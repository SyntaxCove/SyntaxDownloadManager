//! dc-bt — BitTorrent protocol toolbox for the UniDM torrent engine (Phase 13).
//!
//! Protocol-pure: codecs and small state machines with no storage, IPC or process deps.
//! Orchestration (sessions, swarm peers, persistence, events) lives in
//! `download-core/src/torrent_manager.rs`.
//!
//! Supported surface (honest scope): bencode, v1 metainfo (hybrid works via v1), magnet
//! URIs, HTTP(S)+UDP trackers (BEP 15/23), peer wire (BEP 3), extended handshake + metadata
//! exchange (BEP 9/10), rarest-first piece picker, minimal-real DHT (BEP 5), SOCKS5/HTTP
//! CONNECT peer tunnels. Out of scope: MSE encryption, uTP, PEX, v2-only merkle torrents.

pub mod bencode;
pub mod dht;
pub mod magnet;
pub mod metainfo;
pub mod peer;
pub mod picker;
pub mod socks;
pub mod tracker;

use dc_protocol::{ContractError, ErrorCode};

/// Unified torrent error — every failure carries a contract error code so the manager can
/// persist a classified, recoverable state instead of guessing.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct BtError {
    pub code: ErrorCode,
    pub message: String,
}

impl BtError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_metainfo(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TorrentInvalidMetainfo, message)
    }

    pub fn v2_unsupported() -> Self {
        Self::new(
            ErrorCode::TorrentV2Unsupported,
            "v2-only torrent (no v1 piece hashes); hybrid v1+v2 torrents are supported",
        )
    }
}

impl From<ContractError> for BtError {
    fn from(e: ContractError) -> Self {
        BtError {
            code: e.code,
            message: e.message,
        }
    }
}

impl From<BtError> for ContractError {
    fn from(e: BtError) -> Self {
        ContractError::new(e.code, e.message)
    }
}

/// Azureus-style peer id: `-UN0100-` + 12 random alphanumerics.
pub fn new_peer_id() -> [u8; 20] {
    use rand::RngExt;
    const ALPHANUM: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut rng = rand::rng();
    let mut id = [0u8; 20];
    id[..8].copy_from_slice(b"-UN0100-");
    for slot in id.iter_mut().skip(8) {
        *slot = ALPHANUM[rng.random_range(0..ALPHANUM.len())];
    }
    id
}

/// Lowercase hex of 20 raw bytes (info hashes on the wire are lowercase hex).
pub fn hex20(bytes: &[u8]) -> String {
    debug_assert_eq!(bytes.len(), 20);
    let mut s = String::with_capacity(40);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Decode 40 lowercase/uppercase hex chars into 20 bytes.
pub fn unhex20(s: &str) -> Option<[u8; 20]> {
    if s.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    let bytes = s.as_bytes();
    for (i, slot) in out.iter_mut().enumerate() {
        let hi = hex_val(bytes[2 * i])?;
        let lo = hex_val(bytes[2 * i + 1])?;
        *slot = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// RFC 4648 base32 decode (magnet `xt=btih` alt form, 32 chars = 20 bytes).
pub fn base32_decode_20(s: &str) -> Option<[u8; 20]> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 20];
    let mut buf = 0u32;
    let mut bits = 0u32;
    let mut out_pos = 0usize;
    for ch in s.bytes() {
        let upper = ch.to_ascii_uppercase();
        let v = ALPHABET.iter().position(|&a| a == upper)? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if out_pos >= 20 {
                return None;
            }
            out[out_pos] = ((buf >> bits) & 0xFF) as u8;
            out_pos += 1;
        }
    }
    if out_pos != 20 {
        return None;
    }
    Some(out)
}

/// Standard base64 decode (with padding; whitespace tolerated). Used for `torrent.add`'s
/// base64-encoded .torrent files.
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b" \t\r\n".contains(b)).collect();
    let stripped: &[u8] = match cleaned.iter().position(|&b| b == b'=') {
        Some(first_pad) => {
            let tail = &cleaned[first_pad..];
            if tail.iter().any(|&b| b != b'=') || tail.len() > 2 {
                return None;
            }
            &cleaned[..first_pad]
        }
        None => &cleaned,
    };
    // 4n+1 data chars cannot exist in valid base64 (a lone char carries no byte).
    if stripped.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(stripped.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &ch in stripped {
        let v = ALPHABET.iter().position(|&a| a == ch)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_id_has_azureus_prefix() {
        let a = new_peer_id();
        let b = new_peer_id();
        assert_eq!(&a[..8], b"-UN0100-");
        assert_eq!(&b[..8], b"-UN0100-");
        assert_ne!(&a[8..], &b[8..], "random suffixes differ");
    }

    #[test]
    fn hex_round_trip() {
        let bytes = [
            0u8, 0x01, 0xfe, 0xff, 0x7f, 0x10, 0x20, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
            0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x42,
        ];
        let hex = hex20(&bytes);
        assert_eq!(hex.len(), 40);
        assert_eq!(unhex20(&hex).unwrap(), bytes);
        assert!(unhex20("zz").is_none());
        assert!(unhex20("0123").is_none());
    }

    #[test]
    fn base32_decodes_known_vector() {
        // 20 zero bytes encode to exactly 32 'A's in base32.
        assert_eq!(base32_decode_20(&"A".repeat(32)).unwrap(), [0u8; 20]);
        assert!(base32_decode_20("AAAA").is_none());
        assert!(
            base32_decode_20(&"1".repeat(32)).is_none(),
            "1 is not base32"
        );
    }

    #[test]
    fn base64_decodes_round_trip_and_rejects_garbage() {
        assert_eq!(base64_decode("ZGVmYXVsdA==").unwrap(), b"default".to_vec());
        assert_eq!(
            base64_decode("aGVsbG8gd29ybGQ=").unwrap(),
            b"hello world".to_vec()
        );
        assert_eq!(
            base64_decode("aGVs\nbG8=").unwrap(),
            b"hello".to_vec(),
            "whitespace ignored"
        );
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
        assert!(base64_decode("A").is_none());
        assert!(
            base64_decode("A===B").is_none(),
            "padding must be trailing only"
        );
        assert!(base64_decode("!!!!").is_none());
    }
}
