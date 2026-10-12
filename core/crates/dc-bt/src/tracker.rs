//! Tracker announce client — HTTP(S) GET + UDP (BEP 15), compact peers (BEP 23) + dict form.
//!
//! Proxy note: HTTP(S) announces run through the caller-provided reqwest client (the manager
//! builds one per proxy profile). UDP announces have no proxy path — the manager suspends
//! them entirely while a proxy profile is attached (never leaks direct traffic).

use std::net::{IpAddr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use crate::bencode::{self, BValue};
use crate::BtError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackerEvent {
    Started,
    Completed,
    Stopped,
    /// Periodic re-announce (no event parameter).
    None,
}

impl TrackerEvent {
    fn as_param(&self) -> Option<&'static str> {
        match self {
            TrackerEvent::Started => Some("started"),
            TrackerEvent::Completed => Some("completed"),
            TrackerEvent::Stopped => Some("stopped"),
            TrackerEvent::None => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrackerResponse {
    /// Seconds until the next announce.
    pub interval: u32,
    pub seeders: u32,
    pub leechers: u32,
    pub peers: Vec<SocketAddr>,
    pub warning: Option<String>,
    /// Opaque tracker id to echo in subsequent announces (rare, respected when present).
    pub tracker_id: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct AnnounceParams {
    pub info_hash: [u8; 20],
    pub peer_id: [u8; 20],
    pub port: u16,
    pub uploaded: u64,
    pub downloaded: u64,
    pub left: u64,
    pub event: TrackerEvent,
    pub numwant: u32,
}

impl AnnounceParams {
    pub fn new(info_hash: [u8; 20], peer_id: [u8; 20], port: u16, left: u64) -> Self {
        Self {
            info_hash,
            peer_id,
            port,
            uploaded: 0,
            downloaded: 0,
            left,
            event: TrackerEvent::Started,
            numwant: 50,
        }
    }
}

fn percent_encode_raw(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 3);
    for b in bytes {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn parse_response(body: &[u8]) -> Result<TrackerResponse, BtError> {
    let v = bencode::decode(body)
        .map_err(|e| BtError::invalid_metainfo(format!("tracker response bencode: {e}")))?;
    if let Some(reason) = v
        .get(b"failure reason")
        .and_then(|b| b.as_bytes())
        .and_then(|b| std::str::from_utf8(b).ok())
    {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("tracker failure: {reason}"),
        ));
    }
    let warning = v
        .get(b"warning message")
        .and_then(|b| b.as_bytes())
        .and_then(|b| std::str::from_utf8(b).ok())
        .map(|s| s.to_string());
    let tracker_id = v
        .get(b"tracker id")
        .and_then(|b| b.as_bytes())
        .map(|b| b.to_vec());
    let interval = v.get(b"interval").and_then(|b| b.as_int()).unwrap_or(1800) as u32;
    let seeders = v.get(b"complete").and_then(|b| b.as_int()).unwrap_or(0) as u32;
    let leechers = v.get(b"incomplete").and_then(|b| b.as_int()).unwrap_or(0) as u32;

    let mut peers = Vec::new();
    match v.get(b"peers") {
        Some(BValue::Bytes(raw)) => {
            if raw.len() % 6 != 0 {
                return Err(BtError::new(
                    dc_protocol::ErrorCode::MediaInvalidResponse,
                    "compact peer list is not 6-byte aligned",
                ));
            }
            for chunk in raw.as_chunks::<6>().0 {
                let ip = IpAddr::V4(std::net::Ipv4Addr::new(
                    chunk[0], chunk[1], chunk[2], chunk[3],
                ));
                let port = u16::from_be_bytes([chunk[4], chunk[5]]);
                if port != 0 {
                    peers.push(SocketAddr::new(ip, port));
                }
            }
        }
        Some(BValue::List(items)) => {
            for item in items {
                let ip = item
                    .get(b"ip")
                    .and_then(|b| b.as_bytes())
                    .and_then(|b| std::str::from_utf8(b).ok());
                let port = item.get(b"port").and_then(|b| b.as_int()).unwrap_or(0) as u16;
                if let Some(ip) = ip.and_then(|s| s.parse::<IpAddr>().ok()) {
                    if port != 0 {
                        peers.push(SocketAddr::new(ip, port));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(TrackerResponse {
        interval,
        seeders,
        leechers,
        peers,
        warning,
        tracker_id,
    })
}

/// Announce over HTTP(S). `client` may carry a proxy; errors are classified.
pub async fn announce_http(
    client: &reqwest::Client,
    url: &str,
    p: &AnnounceParams,
) -> Result<TrackerResponse, BtError> {
    let mut parsed = url::Url::parse(url)
        .map_err(|_| BtError::new(dc_protocol::ErrorCode::UrlInvalid, "tracker url invalid"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(BtError::new(
            dc_protocol::ErrorCode::UrlInvalid,
            format!("unsupported tracker scheme: {}", parsed.scheme()),
        ));
    }
    // Binary-safe manual query encoding (url's pair encoder is form-oriented).
    let mut query = format!(
        "info_hash={}&peer_id={}&port={}&uploaded={}&downloaded={}&left={}&compact=1&numwant={}",
        percent_encode_raw(&p.info_hash),
        percent_encode_raw(&p.peer_id),
        p.port,
        p.uploaded,
        p.downloaded,
        p.left,
        p.numwant,
    );
    if let Some(ev) = p.event.as_param() {
        query.push_str(&format!("&event={ev}"));
    }
    parsed.set_query(Some(&query));

    let resp = client
        .get(parsed.clone())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            BtError::new(
                dc_protocol::ErrorCode::NetworkError,
                format!("tracker request: {e}"),
            )
        })?;
    let status = resp.status();
    let body = resp.bytes().await.map_err(|e| {
        BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("tracker body: {e}"),
        )
    })?;
    if !status.is_success() {
        return Err(BtError::new(
            dc_protocol::ErrorCode::HttpError,
            format!("tracker HTTP {status}"),
        ));
    }
    parse_response(&body)
}

/// Announce over UDP (BEP 15). `sock` must be an IPv4-bound UdpSocket (compact peers are v4).
pub async fn announce_udp(
    sock: &tokio::net::UdpSocket,
    tracker: SocketAddrV4,
    p: &AnnounceParams,
) -> Result<TrackerResponse, BtError> {
    let txn: u32 = rand::random();
    // --- connect ---
    let mut req = Vec::with_capacity(16);
    req.extend_from_slice(&0x41727101980u64.to_be_bytes()); // magic
    req.extend_from_slice(&0u32.to_be_bytes()); // action connect
    req.extend_from_slice(&txn.to_be_bytes());
    sock.send_to(&req, tracker).await.map_err(|e| {
        BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("udp send: {e}"),
        )
    })?;
    let mut buf = [0u8; 16];
    let n = tokio::time::timeout(Duration::from_secs(10), sock.recv(&mut buf))
        .await
        .map_err(|_| {
            BtError::new(
                dc_protocol::ErrorCode::Timeout,
                "udp tracker connect timeout",
            )
        })?
        .map_err(|e| {
            BtError::new(
                dc_protocol::ErrorCode::NetworkError,
                format!("udp recv: {e}"),
            )
        })?;
    // Reply: action(4) at [0..4], our txn echo at [4..8], connection_id at [8..16].
    if n < 16
        || u32::from_be_bytes(buf[0..4].try_into().unwrap()) != 0
        || buf[4..8] != txn.to_be_bytes()
    {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!(
                "udp tracker connect reply invalid (n={n} bytes={:?} want_txn={:?})",
                &buf[..n.min(16)],
                txn.to_be_bytes()
            ),
        ));
    }
    let connection_id = u64::from_be_bytes(buf[8..16].try_into().unwrap());

    // --- announce ---
    let txn2: u32 = rand::random();
    let mut ann = Vec::with_capacity(98);
    ann.extend_from_slice(&connection_id.to_be_bytes());
    ann.extend_from_slice(&1u32.to_be_bytes()); // action announce
    ann.extend_from_slice(&txn2.to_be_bytes());
    ann.extend_from_slice(&p.info_hash);
    ann.extend_from_slice(&p.peer_id);
    ann.extend_from_slice(&p.downloaded.to_be_bytes());
    ann.extend_from_slice(&p.left.to_be_bytes());
    ann.extend_from_slice(&p.uploaded.to_be_bytes());
    ann.extend_from_slice(&(p.event as u32).to_be_bytes());
    ann.extend_from_slice(&0u32.to_be_bytes()); // ip (default)
    ann.extend_from_slice(&0u32.to_be_bytes()); // key
    ann.extend_from_slice(&p.numwant.to_be_bytes());
    ann.extend_from_slice(&p.port.to_be_bytes());
    sock.send_to(&ann, tracker).await.map_err(|e| {
        BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("udp send: {e}"),
        )
    })?;
    let mut abuf = vec![0u8; 2048];
    let n = tokio::time::timeout(Duration::from_secs(10), sock.recv(&mut abuf))
        .await
        .map_err(|_| {
            BtError::new(
                dc_protocol::ErrorCode::Timeout,
                "udp tracker announce timeout",
            )
        })?
        .map_err(|e| {
            BtError::new(
                dc_protocol::ErrorCode::NetworkError,
                format!("udp recv: {e}"),
            )
        })?;
    if n < 8 {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            "udp tracker announce reply too short",
        ));
    }
    // Reply: action(4) at [0..4], txn echo at [4..8], interval/leechers/seeders at [8..20].
    let action = u32::from_be_bytes(abuf[0..4].try_into().unwrap());
    if action == 3 {
        let msg_len = n.saturating_sub(8).min(256);
        let msg = String::from_utf8_lossy(&abuf[8..8 + msg_len]);
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("udp tracker error: {msg}"),
        ));
    }
    if action != 1 || abuf[4..8] != txn2.to_be_bytes() {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            "udp tracker announce reply mismatch",
        ));
    }
    if n < 20 {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            "udp tracker announce reply truncated",
        ));
    }
    let interval = u32::from_be_bytes(abuf[8..12].try_into().unwrap());
    let leechers = u32::from_be_bytes(abuf[12..16].try_into().unwrap());
    let seeders = u32::from_be_bytes(abuf[16..20].try_into().unwrap());
    let peers_len = (n - 20) / 6 * 6;
    let mut peers = Vec::new();
    for chunk in abuf[20..20 + peers_len].as_chunks::<6>().0 {
        let ip = IpAddr::V4(std::net::Ipv4Addr::new(
            chunk[0], chunk[1], chunk[2], chunk[3],
        ));
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        if port != 0 {
            peers.push(SocketAddr::new(ip, port));
        }
    }
    Ok(TrackerResponse {
        interval,
        seeders,
        leechers,
        peers,
        warning: None,
        tracker_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bencode::bstr;

    fn compact_resp(peers: &[(u8, u8, u8, u8, u16)]) -> Vec<u8> {
        let mut peer_bytes = Vec::new();
        for (a, b, c, d, port) in peers {
            peer_bytes.push(*a);
            peer_bytes.push(*b);
            peer_bytes.push(*c);
            peer_bytes.push(*d);
            peer_bytes.extend_from_slice(&port.to_be_bytes());
        }
        bencode::encode(&BValue::Dict(vec![
            (b"complete".to_vec(), bencode::bint(12)),
            (b"incomplete".to_vec(), bencode::bint(7)),
            (b"interval".to_vec(), bencode::bint(1800)),
            (b"peers".to_vec(), BValue::Bytes(peer_bytes)),
        ]))
    }

    #[test]
    fn parses_compact_peers() {
        let body = compact_resp(&[(10, 0, 0, 1, 6881), (127, 0, 0, 1, 51413), (1, 2, 3, 4, 0)]);
        let r = parse_response(&body).unwrap();
        assert_eq!(r.interval, 1800);
        assert_eq!(r.seeders, 12);
        assert_eq!(r.leechers, 7);
        assert_eq!(r.peers.len(), 2, "zero-port peer dropped");
        assert_eq!(r.peers[0], "10.0.0.1:6881".parse().unwrap());
        assert_eq!(r.peers[1], "127.0.0.1:51413".parse().unwrap());
    }

    #[test]
    fn parses_dict_peers_and_failure_reason() {
        let body = bencode::encode(&BValue::Dict(vec![
            (b"interval".to_vec(), bencode::bint(60)),
            (
                b"peers".to_vec(),
                BValue::List(vec![BValue::Dict(vec![
                    (b"ip".to_vec(), bstr("192.168.1.5")),
                    (b"port".to_vec(), bencode::bint(1234)),
                    (b"peer id".to_vec(), bstr("-qB0001-abcdef")),
                ])]),
            ),
        ]));
        let r = parse_response(&body).unwrap();
        assert_eq!(r.peers, vec!["192.168.1.5:1234".parse().unwrap()]);

        let fail = bencode::encode(&BValue::Dict(vec![(
            b"failure reason".to_vec(),
            bstr("unregistered torrent"),
        )]));
        let err = parse_response(&fail).unwrap_err();
        assert_eq!(err.code, dc_protocol::ErrorCode::NetworkError);
        assert!(err.message.contains("unregistered torrent"));
    }

    #[test]
    fn rejects_unaligned_compact_list() {
        let body = bencode::encode(&BValue::Dict(vec![(
            b"peers".to_vec(),
            BValue::Bytes(vec![1, 2, 3, 4, 5, 6, 7]),
        )]));
        assert!(parse_response(&body).is_err());
    }

    #[test]
    fn event_params_and_url_encoding() {
        assert_eq!(TrackerEvent::Started.as_param(), Some("started"));
        assert_eq!(TrackerEvent::None.as_param(), None);
        assert_eq!(percent_encode_raw(&[0xde, 0xad, b'a', b'1']), "%DE%ADa1");
    }
}
