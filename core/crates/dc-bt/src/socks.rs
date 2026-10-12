//! Peer-connection tunnels — native SOCKS5 CONNECT (RFC 1928/1929) and plain HTTP CONNECT.
//!
//! Torrent privacy rule (Phase 13): when a proxy profile is attached to a torrent job, peer
//! TCP connections and HTTP(S) tracker announces ride the proxy, and DHT / UDP trackers are
//! suspended — direct leakage is never an option. HTTPS-hop proxies are refused (classified)
//! because tunneling raw peer TCP through a TLS-wrapped proxy hop is out of scope.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::BtError;

#[derive(Debug, Clone, PartialEq)]
pub enum ProxyTunnel {
    Direct,
    /// socks5://[user:pass@]host:port
    Socks5 {
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<String>,
    },
    /// http://[user:pass@]host:port — CONNECT tunnel (plain proxy hop only).
    Http {
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<String>,
    },
}

fn auth_err(msg: impl Into<String>) -> BtError {
    BtError::new(dc_protocol::ErrorCode::ProxyKeychainUnavailable, msg)
}

fn proxy_err(msg: impl Into<String>) -> BtError {
    BtError::new(dc_protocol::ErrorCode::NetworkError, msg)
}

/// Open a TCP connection to `target` through the tunnel.
pub async fn connect(target: &str, port: u16, tunnel: &ProxyTunnel) -> Result<TcpStream, BtError> {
    match tunnel {
        ProxyTunnel::Direct => TcpStream::connect((target, port))
            .await
            .map_err(|e| proxy_err(format!("connect {target}:{port}: {e}"))),
        ProxyTunnel::Socks5 {
            host,
            port: proxy_port,
            username,
            password,
        } => {
            let mut stream = TcpStream::connect((host.as_str(), *proxy_port))
                .await
                .map_err(|e| proxy_err(format!("connect proxy {host}:{proxy_port}: {e}")))?;
            socks5_handshake(
                &mut stream,
                target,
                port,
                username.as_deref(),
                password.as_deref(),
            )
            .await?;
            Ok(stream)
        }
        ProxyTunnel::Http {
            host,
            port: proxy_port,
            username,
            password,
        } => {
            let mut stream = TcpStream::connect((host.as_str(), *proxy_port))
                .await
                .map_err(|e| proxy_err(format!("connect proxy {host}:{proxy_port}: {e}")))?;
            http_connect(
                &mut stream,
                target,
                port,
                username.as_deref(),
                password.as_deref(),
            )
            .await?;
            Ok(stream)
        }
    }
}

async fn socks5_handshake(
    stream: &mut TcpStream,
    target: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(), BtError> {
    let has_auth = username.is_some();
    // greeting: VER=5, NMETHODS, METHODS (0 = no auth, 2 = user/pass)
    let greeting: &[u8] = if has_auth {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream.write_all(greeting).await.map_err(proxy_io)?;
    let mut reply = [0u8; 2];
    read_exact_deadline(stream, &mut reply).await?;
    if reply[0] != 0x05 {
        return Err(auth_err("socks5 proxy version mismatch"));
    }
    match reply[1] {
        0x00 => {}
        0x02 => {
            let user = username.unwrap_or_default();
            let pass = password.unwrap_or_default();
            if user.len() > 255 || pass.len() > 255 {
                return Err(auth_err("socks5 credentials too long"));
            }
            let mut req = Vec::with_capacity(3 + user.len() + pass.len());
            req.push(0x01);
            req.push(user.len() as u8);
            req.extend_from_slice(user.as_bytes());
            req.push(pass.len() as u8);
            req.extend_from_slice(pass.as_bytes());
            stream.write_all(&req).await.map_err(proxy_io)?;
            let mut auth = [0u8; 2];
            read_exact_deadline(stream, &mut auth).await?;
            if auth[0] != 0x01 || auth[1] != 0x00 {
                return Err(auth_err("socks5 authentication failed"));
            }
        }
        0xFF => return Err(auth_err("socks5 proxy offers no acceptable auth method")),
        other => return Err(auth_err(format!("socks5 unexpected auth method {other}"))),
    }

    // CONNECT: always send the hostname (server resolves; works for v4/v6 targets)
    if target.len() > 255 {
        return Err(proxy_err("socks5 target hostname too long"));
    }
    let mut req = Vec::with_capacity(7 + target.len());
    req.extend_from_slice(&[0x05, 0x01, 0x00, 0x03]);
    req.push(target.len() as u8);
    req.extend_from_slice(target.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await.map_err(proxy_io)?;

    let mut head = [0u8; 4];
    read_exact_deadline(stream, &mut head).await?;
    if head[1] != 0x00 {
        return Err(proxy_err(format!(
            "socks5 CONNECT failed (code {})",
            head[1]
        )));
    }
    // drain bound address: ATYP + addr + port
    let consumed = match head[3] {
        0x01 => 4 + 2,
        0x03 => {
            let mut len = [0u8; 1];
            read_exact_deadline(stream, &mut len).await?;
            1 + len[0] as usize + 2
        }
        0x04 => 16 + 2,
        other => return Err(proxy_err(format!("socks5 bad bound addr type {other}"))),
    };
    let mut rest = vec![0u8; consumed];
    read_exact_deadline(stream, &mut rest).await?;
    Ok(())
}

/// Minimal standard base64 (RFC 4648) for proxy credentials.
fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

async fn http_connect(
    stream: &mut TcpStream,
    target: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(), BtError> {
    let mut req = format!("CONNECT {target}:{port} HTTP/1.1\r\nHost: {target}:{port}\r\n");
    if let Some(u) = username {
        let creds = format!("{u}:{}", password.unwrap_or_default());
        req.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            b64(creds.as_bytes())
        ));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.map_err(proxy_io)?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let n = stream.read(&mut chunk).await.map_err(proxy_io)?;
        if n == 0 {
            return Err(proxy_err("http proxy closed during CONNECT"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(proxy_err("http proxy CONNECT response too large"));
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status_line = head.lines().next().unwrap_or_default();
    // "HTTP/1.1 200 ..."
    let mut parts = status_line.split_whitespace();
    let _ver = parts.next();
    let code = parts.next().unwrap_or_default();
    if code != "200" {
        return Err(proxy_err(format!("http proxy CONNECT refused ({code})")));
    }
    Ok(())
}

async fn read_exact_deadline(stream: &mut TcpStream, buf: &mut [u8]) -> Result<(), BtError> {
    match tokio::time::timeout(Duration::from_secs(10), stream.read_exact(buf)).await {
        Ok(r) => r.map(|_| ()).map_err(proxy_io),
        Err(_) => Err(proxy_err("proxy handshake timeout")),
    }
}

fn proxy_io(e: std::io::Error) -> BtError {
    proxy_err(format!("proxy io: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn socks5_no_auth_round_trip() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            s.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            s.write_all(&[0x05, 0x00]).await.unwrap();
            // read CONNECT: VER CMD RSV ATYP LEN + host + port
            let mut head = [0u8; 5];
            s.read_exact(&mut head).await.unwrap();
            assert_eq!(head, [0x05, 0x01, 0x00, 0x03, 10]);
            let mut host = vec![0u8; 10];
            s.read_exact(&mut host).await.unwrap();
            assert_eq!(&host, b"target.prv");
            let mut port = [0u8; 2];
            s.read_exact(&mut port).await.unwrap();
            assert_eq!(port, 443u16.to_be_bytes());
            s.write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90])
                .await
                .unwrap();
        });
        let tunnel = ProxyTunnel::Socks5 {
            host: addr.ip().to_string(),
            port: addr.port(),
            username: None,
            password: None,
        };
        connect("target.prv", 443, &tunnel).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_with_credentials_rejects_wrong_password() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 4];
            s.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x02, 0x00, 0x02]);
            s.write_all(&[0x05, 0x02]).await.unwrap();
            // RFC 1929 subnegotiation: VER(1) ULEN(1) UNAME PLEN(1) PASSWD
            let mut ver = [0u8; 1];
            s.read_exact(&mut ver).await.unwrap();
            assert_eq!(ver[0], 0x01);
            let mut ulen = [0u8; 1];
            s.read_exact(&mut ulen).await.unwrap();
            let mut user = vec![0u8; ulen[0] as usize];
            s.read_exact(&mut user).await.unwrap();
            let mut plen = [0u8; 1];
            s.read_exact(&mut plen).await.unwrap();
            let mut pass = vec![0u8; plen[0] as usize];
            s.read_exact(&mut pass).await.unwrap();
            assert_eq!(user, b"alice");
            if pass == b"secret" {
                s.write_all(&[0x01, 0x00]).await.unwrap();
            } else {
                s.write_all(&[0x01, 0x01]).await.unwrap();
            }
        });
        let tunnel = ProxyTunnel::Socks5 {
            host: addr.ip().to_string(),
            port: addr.port(),
            username: Some("alice".into()),
            password: Some("wrong".into()),
        };
        let err = connect("x", 80, &tunnel).await.unwrap_err();
        assert_eq!(
            err.code,
            dc_protocol::ErrorCode::ProxyKeychainUnavailable,
            "msg={}",
            err.message
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_connect_round_trip() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 512];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            assert!(req.starts_with("CONNECT host.prv:80 HTTP/1.1\r\n"));
            assert!(req.contains("Proxy-Authorization: Basic dXNlcjpwYXNz"));
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
        });
        let tunnel = ProxyTunnel::Http {
            host: addr.ip().to_string(),
            port: addr.port(),
            username: Some("user".into()),
            password: Some("pass".into()),
        };
        connect("host.prv", 80, &tunnel).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_connect_refusal_is_classified() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 512];
            let _ = s.read(&mut buf).await.unwrap();
            s.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                .await
                .unwrap();
        });
        let tunnel = ProxyTunnel::Http {
            host: addr.ip().to_string(),
            port: addr.port(),
            username: None,
            password: None,
        };
        let err = connect("x", 80, &tunnel).await.unwrap_err();
        assert!(err.message.contains("403"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn direct_connect_reaches_local_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
        });
        connect("127.0.0.1", addr.port(), &ProxyTunnel::Direct)
            .await
            .unwrap();
        server.await.unwrap();
    }
}
