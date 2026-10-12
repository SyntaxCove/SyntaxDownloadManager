//! Peer wire protocol (BEP 3) — handshake, framed messages, extended handshake (BEP 10)
//! and the ut_metadata metadata exchange (BEP 9) for magnets.

use std::time::Duration;

use crate::BtError;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

pub const PROTOCOL_STRING: &[u8] = b"BitTorrent protocol";
/// Extension-protocol support flag (BEP 10), byte 5, bit 0x10.
pub const EXTENSION_FLAG_BYTE: usize = 5;
pub const EXTENSION_FLAG_MASK: u8 = 0x10;

/// Peer wire message types (BEP 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    KeepAlive,
    Choke,
    Unchoke,
    Interested,
    NotInterested,
    Have(u32),
    Bitfield(Vec<u8>),
    /// (index, begin, length)
    Request(u32, u32, u32),
    /// (index, begin, block)
    Piece(u32, u32, Vec<u8>),
    /// (index, begin, length)
    Cancel(u32, u32, u32),
    /// (extended message id, payload) — type byte 20 (BEP 10).
    Extended(u8, Vec<u8>),
}

impl Message {
    pub fn encode(&self) -> Vec<u8> {
        let (type_byte, payload): (u8, Vec<u8>) = match self {
            Message::KeepAlive => return vec![0u8; 4], // zero length prefix, no type byte
            Message::Choke => (0, Vec::new()),
            Message::Unchoke => (1, Vec::new()),
            Message::Interested => (2, Vec::new()),
            Message::NotInterested => (3, Vec::new()),
            Message::Have(i) => (4, i.to_be_bytes().to_vec()),
            Message::Bitfield(b) => (5, b.clone()),
            Message::Request(i, b, l) => {
                let mut p = Vec::with_capacity(12);
                p.extend_from_slice(&i.to_be_bytes());
                p.extend_from_slice(&b.to_be_bytes());
                p.extend_from_slice(&l.to_be_bytes());
                (6, p)
            }
            Message::Piece(i, b, block) => {
                let mut p = Vec::with_capacity(8 + block.len());
                p.extend_from_slice(&i.to_be_bytes());
                p.extend_from_slice(&b.to_be_bytes());
                p.extend_from_slice(block);
                (7, p)
            }
            Message::Cancel(i, b, l) => {
                let mut p = Vec::with_capacity(12);
                p.extend_from_slice(&i.to_be_bytes());
                p.extend_from_slice(&b.to_be_bytes());
                p.extend_from_slice(&l.to_be_bytes());
                (8, p)
            }
            Message::Extended(id, payload) => (20, {
                let mut p = Vec::with_capacity(1 + payload.len());
                p.push(*id);
                p.extend_from_slice(payload);
                p
            }),
        };
        let mut out = Vec::with_capacity(4 + 1 + payload.len());
        out.extend_from_slice(&((1 + payload.len()) as u32).to_be_bytes());
        out.push(type_byte);
        out.extend_from_slice(&payload);
        out
    }
}

/// Encode the BT handshake: 19 + protocol + 8 reserved (extension bit set) + info_hash + peer_id.
pub fn encode_handshake(info_hash: &[u8; 20], peer_id: &[u8; 20]) -> Vec<u8> {
    let mut out = Vec::with_capacity(68);
    out.push(19);
    out.extend_from_slice(PROTOCOL_STRING);
    let mut reserved = [0u8; 8];
    reserved[EXTENSION_FLAG_BYTE] |= EXTENSION_FLAG_MASK; // BEP 10
    out.extend_from_slice(&reserved);
    out.extend_from_slice(info_hash);
    out.extend_from_slice(peer_id);
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Handshake {
    pub info_hash: [u8; 20],
    pub peer_id: [u8; 20],
    pub extensions: [u8; 8],
}

/// Read and validate one handshake from the stream.
pub async fn read_handshake(reader: &mut (impl AsyncRead + Unpin)) -> Result<Handshake, BtError> {
    let mut len_byte = [0u8; 1];
    reader.read_exact(&mut len_byte).await.map_err(io_err)?;
    if len_byte[0] != 19 {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            "handshake length prefix is not 19",
        ));
    }
    let mut proto = [0u8; 19];
    reader.read_exact(&mut proto).await.map_err(io_err)?;
    if proto != *PROTOCOL_STRING {
        return Err(BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            "handshake protocol string mismatch",
        ));
    }
    let mut h = Handshake {
        info_hash: [0u8; 20],
        peer_id: [0u8; 20],
        extensions: [0u8; 8],
    };
    reader.read_exact(&mut h.extensions).await.map_err(io_err)?;
    reader.read_exact(&mut h.info_hash).await.map_err(io_err)?;
    reader.read_exact(&mut h.peer_id).await.map_err(io_err)?;
    Ok(h)
}

fn io_err(e: std::io::Error) -> BtError {
    BtError::new(
        dc_protocol::ErrorCode::NetworkError,
        format!("peer connection: {e}"),
    )
}

/// Framed peer connection over any async stream (TCP or a proxy tunnel).
pub struct PeerConn<S> {
    reader: BufReader<S>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> PeerConn<S> {
    pub fn new(stream: S) -> Self {
        Self {
            reader: BufReader::with_capacity(64 * 1024, stream),
        }
    }

    pub fn get_mut(&mut self) -> &mut S {
        self.reader.get_mut()
    }

    /// Release the raw stream (the inbound acceptor re-paths it into a session).
    pub fn into_inner(self) -> S {
        self.reader.into_inner()
    }

    /// Send one message (empty vec = keep-alive).
    pub async fn send(&mut self, msg: &Message) -> Result<(), BtError> {
        let bytes = msg.encode();
        self.reader
            .get_mut()
            .write_all(&bytes)
            .await
            .map_err(io_err)?;
        self.reader.get_mut().flush().await.map_err(io_err)
    }

    /// Read one framed message; `None` on clean EOF (peer closed).
    pub async fn recv(&mut self) -> Result<Option<Message>, BtError> {
        let mut len_buf = [0u8; 4];
        match self.reader.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(io_err(e)),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 {
            return Ok(Some(Message::KeepAlive));
        }
        // sanity cap: piece blocks are ≤ 32 KiB by protocol convention; allow headroom
        if len > 4 * 1024 * 1024 {
            return Err(BtError::new(
                dc_protocol::ErrorCode::NetworkError,
                "peer message length exceeds sane cap",
            ));
        }
        let mut body = vec![0u8; len];
        self.reader.read_exact(&mut body).await.map_err(io_err)?;
        let type_byte = body[0];
        let payload = body[1..].to_vec();
        let msg = match type_byte {
            0 => Message::Choke,
            1 => Message::Unchoke,
            2 => Message::Interested,
            3 => Message::NotInterested,
            4 => Message::Have(u32::from_be_bytes(
                payload[..4].try_into().map_err(|_| bad_frame())?,
            )),
            5 => Message::Bitfield(payload),
            6 => Message::Request(be32(&payload, 0)?, be32(&payload, 4)?, be32(&payload, 8)?),
            7 => Message::Piece(
                be32(&payload, 0)?,
                be32(&payload, 4)?,
                payload[8..].to_vec(),
            ),
            8 => Message::Cancel(be32(&payload, 0)?, be32(&payload, 4)?, be32(&payload, 8)?),
            20 => Message::Extended(
                *payload.first().ok_or_else(bad_frame)?,
                payload[1..].to_vec(),
            ),
            other => {
                // Unknown message types are tolerated (forward compat): skip silently.
                tracing::debug!(type_byte = other, len, "unknown peer message type");
                Message::KeepAlive
            }
        };
        Ok(Some(msg))
    }
}

fn be32(payload: &[u8], off: usize) -> Result<u32, BtError> {
    payload
        .get(off..off + 4)
        .map(|s| u32::from_be_bytes(s.try_into().unwrap()))
        .ok_or_else(bad_frame)
}

fn bad_frame() -> BtError {
    BtError::new(
        dc_protocol::ErrorCode::NetworkError,
        "malformed peer message frame",
    )
}

/// Read one message with a deadline (handshakes and idle peers must not hang the session).
pub async fn recv_timeout<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut PeerConn<S>,
    timeout: Duration,
) -> Result<Option<Message>, BtError> {
    match tokio::time::timeout(timeout, conn.recv()).await {
        Ok(r) => r,
        Err(_) => Err(BtError::new(
            dc_protocol::ErrorCode::Timeout,
            "peer read timeout",
        )),
    }
}

// ---- BEP 10 extended handshake + BEP 9 ut_metadata ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtendedHandshake {
    /// Remote's ut_metadata message id (0 = unsupported).
    pub ut_metadata: u8,
    pub metadata_size: Option<u64>,
    pub client: Option<String>,
}

/// Parse an extended-handshake payload (ext id 0).
pub fn parse_extended_handshake(payload: &[u8]) -> Result<ExtendedHandshake, BtError> {
    let v = crate::bencode::decode(payload).map_err(|e| {
        BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("ext handshake: {e}"),
        )
    })?;
    let ut_metadata = v
        .get(b"m")
        .and_then(|m| m.get(b"ut_metadata"))
        .and_then(|x| x.as_int())
        .unwrap_or(0) as u8;
    Ok(ExtendedHandshake {
        ut_metadata,
        metadata_size: v
            .get(b"metadata_size")
            .and_then(|x| x.as_int())
            .map(|x| x as u64),
        client: v
            .get(b"v")
            .and_then(|x| x.as_bytes())
            .and_then(|b| std::str::from_utf8(b).ok())
            .map(|s| s.to_string()),
    })
}

/// Build the local extended handshake (we advertise ut_metadata = 1 when metadata is needed).
pub fn encode_extended_handshake(ut_metadata: u8, metadata_size: Option<u64>) -> Vec<u8> {
    use crate::bencode::{bint, bstr, BValue};
    let mut m = Vec::new();
    if ut_metadata != 0 {
        m.push((b"ut_metadata".to_vec(), bint(ut_metadata as i64)));
    }
    let mut pairs: Vec<(Vec<u8>, BValue)> = vec![
        (b"m".to_vec(), BValue::Dict(m)),
        (b"p".to_vec(), bint(0)),
        (b"v".to_vec(), bstr("UniDM 1.0")),
    ];
    if let Some(size) = metadata_size {
        pairs.push((b"metadata_size".to_vec(), bint(size as i64)));
    }
    crate::bencode::encode(&BValue::Dict(pairs))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataMsg {
    /// Request metadata piece `piece`.
    Request(u32),
    /// Data for piece `piece` (+ raw metadata bytes for the frame).
    Data(u32, Vec<u8>),
    Reject(u32),
    /// Anything unparseable / unknown msg_type — tolerated.
    Unknown,
}

/// Encode a ut_metadata (BEP 9) payload: bencode dict + appended data bytes.
pub fn encode_metadata_msg(msg: &MetadataMsg) -> Vec<u8> {
    use crate::bencode::{bint, BValue};
    let dict = match msg {
        MetadataMsg::Request(piece) => BValue::Dict(vec![
            (b"msg_type".to_vec(), bint(0)),
            (b"piece".to_vec(), bint(*piece as i64)),
        ]),
        MetadataMsg::Data(piece, data) => BValue::Dict(vec![
            (b"msg_type".to_vec(), bint(1)),
            (b"piece".to_vec(), bint(*piece as i64)),
            (b"total_size".to_vec(), bint(data.len() as i64)),
        ]),
        MetadataMsg::Reject(piece) => BValue::Dict(vec![
            (b"msg_type".to_vec(), bint(2)),
            (b"piece".to_vec(), bint(*piece as i64)),
        ]),
        MetadataMsg::Unknown => BValue::Dict(vec![]),
    };
    let mut out = crate::bencode::encode(&dict);
    if let MetadataMsg::Data(_, data) = msg {
        out.extend_from_slice(data);
    }
    out
}

/// Parse a ut_metadata payload; the dict end is found by decoding at offset 0.
pub fn parse_metadata_msg(payload: &[u8]) -> Result<MetadataMsg, BtError> {
    let (dict, end) = crate::bencode::decode_at(payload, 0).map_err(|e| {
        BtError::new(
            dc_protocol::ErrorCode::NetworkError,
            format!("ut_metadata: {e}"),
        )
    })?;
    let msg_type = dict.get(b"msg_type").and_then(|v| v.as_int()).unwrap_or(-1);
    let piece = dict.get(b"piece").and_then(|v| v.as_int()).unwrap_or(0) as u32;
    Ok(match msg_type {
        0 => MetadataMsg::Request(piece),
        1 => MetadataMsg::Data(piece, payload[end..].to_vec()),
        2 => MetadataMsg::Reject(piece),
        _ => MetadataMsg::Unknown,
    })
}

/// Split metadata into BEP 9 pieces (16 KiB each, last short).
pub fn metadata_piece_count(metadata_size: usize) -> usize {
    metadata_size.div_ceil(16 * 1024).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_codecs_round_trip() {
        for msg in [
            Message::Choke,
            Message::Unchoke,
            Message::Interested,
            Message::NotInterested,
            Message::Have(1234),
            Message::Bitfield(vec![0b1010_0001, 0b0000_0011]),
            Message::Request(7, 16384, 16384),
            Message::Cancel(7, 0, 16384),
            Message::Piece(7, 0, vec![1, 2, 3, 4]),
            Message::Extended(1, vec![9, 9, 9]),
        ] {
            let bytes = msg.encode();
            assert_eq!(bytes.len(), 4 + inner_len(&msg));
        }
        assert_eq!(Message::KeepAlive.encode(), vec![0u8; 4]);
    }

    fn inner_len(m: &Message) -> usize {
        match m {
            Message::KeepAlive => 0,
            Message::Choke | Message::Unchoke | Message::Interested | Message::NotInterested => 1,
            Message::Have(_) => 5,
            Message::Bitfield(b) => 1 + b.len(),
            Message::Request(..) | Message::Cancel(..) => 13,
            Message::Piece(_, _, b) => 9 + b.len(),
            Message::Extended(_, p) => 2 + p.len(), // type byte + ext id + payload
        }
    }

    #[test]
    fn handshake_encoding_is_68_bytes_with_extension_flag() {
        let ih = [7u8; 20];
        let pid = [9u8; 20];
        let bytes = encode_handshake(&ih, &pid);
        assert_eq!(bytes.len(), 68);
        assert_eq!(&bytes[1..20], PROTOCOL_STRING);
        assert_eq!(
            bytes[20 + EXTENSION_FLAG_BYTE] & EXTENSION_FLAG_MASK,
            EXTENSION_FLAG_MASK
        );
        assert_eq!(&bytes[28..48], &ih);
        assert_eq!(&bytes[48..68], &pid);
    }

    #[tokio::test]
    async fn framed_read_write_round_trip() {
        let (client, server) = tokio::io::duplex(8192);
        let mut a = PeerConn::new(client);
        let mut b = PeerConn::new(server);
        a.send(&Message::Interested).await.unwrap();
        a.send(&Message::Piece(3, 0, vec![0xAB; 100]))
            .await
            .unwrap();
        a.send(&Message::KeepAlive).await.unwrap();
        assert_eq!(b.recv().await.unwrap().unwrap(), Message::Interested);
        match b.recv().await.unwrap().unwrap() {
            Message::Piece(i, o, block) => {
                assert_eq!((i, o), (3, 0));
                assert_eq!(block, vec![0xAB; 100]);
            }
            other => panic!("wrong message: {other:?}"),
        }
        assert_eq!(b.recv().await.unwrap().unwrap(), Message::KeepAlive);
    }

    #[tokio::test]
    async fn handshake_read_rejects_wrong_protocol() {
        use tokio::io::AsyncWriteExt;
        let mut bad = vec![];
        bad.push(19);
        bad.extend_from_slice(b"BitTorrent NOTPROTO");
        let (mut r, mut w) = tokio::io::simplex(64);
        w.write_all(&bad).await.unwrap();
        drop(w);
        let err = read_handshake(&mut r).await.unwrap_err();
        assert!(err.message.contains("protocol string mismatch"));
    }

    #[test]
    fn extended_handshake_round_trip() {
        let payload = encode_extended_handshake(1, Some(12345));
        let hs = parse_extended_handshake(&payload).unwrap();
        assert_eq!(hs.ut_metadata, 1);
        assert_eq!(hs.metadata_size, Some(12345));
        assert_eq!(hs.client.as_deref(), Some("UniDM 1.0"));
    }

    #[test]
    fn ut_metadata_round_trips_with_appended_data() {
        let data = vec![0xEE; 50];
        let bytes = encode_metadata_msg(&MetadataMsg::Data(2, data.clone()));
        match parse_metadata_msg(&bytes).unwrap() {
            MetadataMsg::Data(piece, got) => {
                assert_eq!(piece, 2);
                assert_eq!(got, data);
            }
            other => panic!("wrong msg {other:?}"),
        }
        assert_eq!(
            parse_metadata_msg(&encode_metadata_msg(&MetadataMsg::Request(1))).unwrap(),
            MetadataMsg::Request(1)
        );
        assert_eq!(
            parse_metadata_msg(&encode_metadata_msg(&MetadataMsg::Reject(3))).unwrap(),
            MetadataMsg::Reject(3)
        );
    }

    #[test]
    fn metadata_piece_count_splits_16k() {
        assert_eq!(metadata_piece_count(1), 1);
        assert_eq!(metadata_piece_count(16 * 1024), 1);
        assert_eq!(metadata_piece_count(16 * 1024 + 1), 2);
        assert_eq!(metadata_piece_count(48 * 1024), 3);
    }
}
