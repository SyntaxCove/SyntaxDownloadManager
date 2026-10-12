//! Magnet URI parsing — `xt=urn:btih:` (40-hex or 32-base32), `dn`, `tr` (multi), `xl`.

use crate::{base32_decode_20, unhex20, BtError};

#[derive(Debug, Clone, PartialEq)]
pub struct Magnet {
    pub info_hash: [u8; 20],
    /// Percent-decoded display name (`dn`), if present.
    pub display_name: Option<String>,
    /// Tracker announce URLs (`tr`, in order, deduplicated).
    pub trackers: Vec<String>,
    /// Suggested total length (`xl`), advisory only.
    pub length: Option<u64>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push(((h << 4) | l) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a magnet URI. Scheme must be `magnet:`; `xt` must be exactly one `urn:btih:` hash.
pub fn parse(uri: &str) -> Result<Magnet, BtError> {
    let uri = uri.trim();
    let rest = uri
        .strip_prefix("magnet:")
        .ok_or_else(|| BtError::new(dc_protocol::ErrorCode::UrlInvalid, "not a magnet URI"))?;
    let query = rest.strip_prefix('?').unwrap_or(rest);
    if query.is_empty() {
        return Err(BtError::new(
            dc_protocol::ErrorCode::UrlInvalid,
            "magnet URI has no parameters",
        ));
    }

    let mut info_hash: Option<[u8; 20]> = None;
    let mut display_name: Option<String> = None;
    let mut trackers: Vec<String> = Vec::new();
    let mut length: Option<u64> = None;

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        match key {
            "xt" => {
                let hash = value.strip_prefix("urn:btih:").ok_or_else(|| {
                    BtError::new(
                        dc_protocol::ErrorCode::UrlInvalid,
                        "magnet xt is not urn:btih (v2 urn:btmh is unsupported)",
                    )
                })?;
                let decoded = unhex20(hash)
                    .or_else(|| base32_decode_20(hash))
                    .ok_or_else(|| {
                        BtError::new(
                            dc_protocol::ErrorCode::UrlInvalid,
                            "magnet btih is neither 40-hex nor 32-base32",
                        )
                    })?;
                if info_hash.is_some() {
                    return Err(BtError::new(
                        dc_protocol::ErrorCode::UrlInvalid,
                        "magnet carries multiple btih hashes",
                    ));
                }
                info_hash = Some(decoded);
            }
            "dn" => display_name = Some(percent_decode(value)),
            "tr" => {
                let t = percent_decode(value);
                if !t.is_empty() && !trackers.contains(&t) {
                    trackers.push(t);
                }
            }
            "xl" => length = value.parse().ok(),
            _ => {}
        }
    }

    let info_hash = info_hash.ok_or_else(|| {
        BtError::new(
            dc_protocol::ErrorCode::UrlInvalid,
            "magnet has no xt=urn:btih",
        )
    })?;

    Ok(Magnet {
        info_hash,
        display_name,
        trackers,
        length,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn parses_hex_magnet_with_trackers_and_name() {
        let m = parse(&format!(
            "magnet:?xt=urn:btih:{HEX}&dn=My%20File%20.iso&tr=http%3A%2F%2Ft1%2Fann&tr=udp%3A%2F%2Ft2%3A6969&tr=http%3A%2F%2Ft1%2Fann&xl=1048576"
        ))
        .unwrap();
        assert_eq!(m.info_hash, unhex20(HEX).unwrap());
        assert_eq!(m.display_name.as_deref(), Some("My File .iso"));
        assert_eq!(m.trackers.len(), 2, "duplicates removed");
        assert_eq!(m.trackers[0], "http://t1/ann");
        assert_eq!(m.trackers[1], "udp://t2:6969");
        assert_eq!(m.length, Some(1_048_576));
    }

    #[test]
    fn parses_base32_info_hash() {
        // 20 zero bytes → exactly 32 'A's in base32
        let m = parse("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        assert_eq!(m.info_hash, [0u8; 20]);
    }

    #[test]
    fn rejects_malformed_magnets() {
        assert!(parse("http://example.com/x").is_err(), "wrong scheme");
        assert!(parse("magnet:?dn=nohash").is_err(), "missing xt");
        assert!(parse("magnet:?xt=urn:btmh:...").is_err(), "btmh refused");
        assert!(parse("magnet:?xt=urn:btih:short").is_err(), "bad hash");
        assert!(parse("magnet:?").is_err());
        assert!(parse("magnet:?xt=urn:btih:0000000000000000000000000000000000000000&xt=urn:btih:1111111111111111111111111111111111111111").is_err(), "double xt");
    }

    #[test]
    fn percent_decode_handles_escapes_and_plus() {
        assert_eq!(percent_decode("a%20b+c"), "a b c");
        assert_eq!(percent_decode("%E2%9C%93"), "✓");
        assert_eq!(percent_decode("bad%2"), "bad%2");
    }
}
