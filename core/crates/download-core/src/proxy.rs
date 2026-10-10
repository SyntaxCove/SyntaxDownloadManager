//! Proxy routing (Phase 9) — runtime endpoints pushed by main, fail-closed resolution and
//! the bypass matcher shared by every proxied run.
//!
//! Credentials live ONLY here in memory (never persisted by the core — main owns the
//! keychain-backed profile store). A job whose profile is missing from the runtime map is
//! **paused** with `proxy_profile_not_found`, never silently routed direct: falling back
//! would leak the user's real IP and is a security failure, not a convenience.

use dc_protocol::ErrorCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use url::Url;

/// One runtime proxy endpoint as pushed by main via `proxy.setRuntime` (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeProxy {
    pub id: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default, rename = "bypassList")]
    pub bypass_list: Vec<String>,
}

/// In-memory runtime map, replaced wholesale by `proxy.setRuntime`.
#[derive(Default)]
pub struct ProxyMap {
    inner: Mutex<HashMap<String, RuntimeProxy>>,
}

impl ProxyMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Full replace (main is the single source of truth).
    pub fn replace(&self, profiles: Vec<RuntimeProxy>) {
        let mut map = self.inner.lock().expect("proxy map mutex poisoned");
        map.clear();
        for p in profiles {
            map.insert(p.id.clone(), p);
        }
    }

    pub fn get(&self, id: &str) -> Option<RuntimeProxy> {
        self.inner
            .lock()
            .expect("proxy map mutex poisoned")
            .get(id)
            .cloned()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("proxy map mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `scheme://[user:pass@]host:port` for `reqwest::Proxy::all`. Percent-encodes the userinfo.
pub fn proxy_url(p: &RuntimeProxy) -> Result<String, dc_protocol::ContractError> {
    let scheme = match p.scheme.as_str() {
        "http" | "https" | "socks5" => p.scheme.as_str(),
        other => {
            return Err(dc_protocol::ContractError::new(
                ErrorCode::InvalidParams,
                format!("unsupported proxy scheme: {other}"),
            ))
        }
    };
    let host = p.host.trim();
    if host.is_empty() {
        return Err(dc_protocol::ContractError::new(
            ErrorCode::InvalidParams,
            "proxy host is empty",
        ));
    }
    let mut url = format!("{scheme}://");
    if p.username.is_some() || p.password.is_some() {
        let user = encode_userinfo(p.username.as_deref().unwrap_or(""));
        let pass = encode_userinfo(p.password.as_deref().unwrap_or(""));
        url.push_str(&user);
        url.push(':');
        url.push_str(&pass);
        url.push('@');
    }
    // Bracket IPv6 literals; other hosts are used verbatim.
    if host.contains(':') && !host.starts_with('[') {
        url.push_str(&format!("[{host}]"));
    } else {
        url.push_str(host);
    }
    url.push_str(&format!(":{}", p.port));
    Ok(url)
}

fn encode_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'!'
            | b'$'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b';'
            | b'=' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Extract the host from an http(s) URL (lowercased). Returns None for non-http(s).
pub fn host_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some(host)
}

/// The documented bypass subset, identical in spirit to Chromium's proxyBypassRules:
///  - `<local>`  — hostname without a dot, `localhost`, or a loopback address;
///  - `host`     — exact match (case-insensitive);
///  - `.d.tld`   — the domain itself plus every subdomain;
///  - `*.d.tld`  — subdomains only (NOT the apex);
///  - any of the above optionally `:port`-qualified (matches only that port).
pub fn host_matches_bypass(host: &str, port: u16, bypass: &[String]) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    for raw in bypass {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        // Optional :port qualifier.
        let (pattern, entry_port) = match entry.rsplit_once(':') {
            // Do not treat the colons inside `[::1]:8080` or bare IPv6 as port separators
            // unless something follows the last colon.
            Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
                (h, p.parse::<u16>().ok())
            }
            _ => (entry, None),
        };
        if let Some(want) = entry_port {
            if want != port {
                continue;
            }
        }
        let pattern = pattern.trim().to_ascii_lowercase();
        if pattern == "<local>" {
            if is_local(&host) {
                return true;
            }
        } else if let Some(sub) = pattern.strip_prefix("*.") {
            if host.ends_with(&format!(".{sub}")) && host != sub {
                return true;
            }
        } else if let Some(dom) = pattern.strip_prefix('.') {
            if host == dom || host.ends_with(&format!(".{dom}")) {
                return true;
            }
        } else if pattern == host {
            return true;
        }
    }
    false
}

fn is_local(host: &str) -> bool {
    host == "localhost"
        || !host.contains('.')
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host.starts_with("127.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(
        scheme: &str,
        host: &str,
        port: u16,
        user: Option<&str>,
        pass: Option<&str>,
    ) -> RuntimeProxy {
        RuntimeProxy {
            id: "01TEST".into(),
            scheme: scheme.into(),
            host: host.into(),
            port,
            username: user.map(|s| s.into()),
            password: pass.map(|s| s.into()),
            bypass_list: vec![],
        }
    }

    #[test]
    fn proxy_url_shapes() {
        assert_eq!(
            proxy_url(&proxy("http", "p.example.com", 3128, None, None)).unwrap(),
            "http://p.example.com:3128"
        );
        assert_eq!(
            proxy_url(&proxy("https", "10.0.0.1", 8443, Some("u"), Some("p"))).unwrap(),
            "https://u:p@10.0.0.1:8443"
        );
        assert_eq!(
            proxy_url(&proxy("socks5", "::1", 1080, None, None)).unwrap(),
            "socks5://[::1]:1080"
        );
        // userinfo is percent-encoded; secrets never appear raw
        assert_eq!(
            proxy_url(&proxy("http", "h", 80, Some("us@r"), Some("p:ass"))).unwrap(),
            "http://us%40r:p%3Aass@h:80"
        );
        assert!(proxy_url(&proxy("ftp", "h", 21, None, None)).is_err());
        assert!(proxy_url(&proxy("http", "  ", 80, None, None)).is_err());
    }

    #[test]
    fn bypass_matrix() {
        let rules: Vec<String> = [
            ".internal.example.com",
            "*.cdn.example.net",
            "<local>",
            "10.1.2.3:8080",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // .domain: apex + subdomains
        assert!(host_matches_bypass("internal.example.com", 443, &rules));
        assert!(host_matches_bypass("a.internal.example.com", 443, &rules));
        assert!(!host_matches_bypass("example.com", 443, &rules));
        assert!(!host_matches_bypass("notinternal.example.com", 443, &rules));
        // *.sub: subdomains only
        assert!(host_matches_bypass("x.cdn.example.net", 443, &rules));
        assert!(!host_matches_bypass("cdn.example.net", 443, &rules));
        // <local>
        assert!(host_matches_bypass("localhost", 80, &rules));
        assert!(host_matches_bypass("intranet", 80, &rules));
        assert!(host_matches_bypass("127.0.0.1", 80, &rules));
        assert!(!host_matches_bypass("example.org", 80, &rules));
        // :port qualifier
        assert!(host_matches_bypass("10.1.2.3", 8080, &rules));
        assert!(!host_matches_bypass("10.1.2.3", 80, &rules));
        // case-insensitivity + empty rules
        assert!(host_matches_bypass("INTERNAL.EXAMPLE.COM", 443, &rules));
        assert!(!host_matches_bypass("anything.example", 443, &[]));
        assert!(!host_matches_bypass("", 443, &rules));
    }

    #[test]
    fn proxy_map_replaces_wholesale() {
        let map = ProxyMap::new();
        map.replace(vec![proxy("http", "a", 1, None, None)]);
        assert_eq!(map.len(), 1);
        map.replace(vec![]);
        assert!(map.is_empty());
        assert!(map.get("01TEST").is_none());
    }

    #[test]
    fn host_of_parses_and_rejects() {
        assert_eq!(
            host_of("https://Example.COM/x").as_deref(),
            Some("example.com")
        );
        assert_eq!(host_of("http://[::1]:8080/f").as_deref(), Some("[::1]"));
        assert_eq!(host_of("ftp://example.com/f"), None);
        assert_eq!(host_of("not a url"), None);
    }
}
