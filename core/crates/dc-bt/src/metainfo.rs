//! .torrent metainfo parsing — v1 single/multi-file, exact-bytes info-hash, hybrid OK,
//! v2-only classified refusal, traversal-proof path sanitization (security-critical).

use crate::bencode::decode_top_with_span;
use crate::{hex20, BtError};
use sha1::{Digest, Sha1};

#[derive(Debug, Clone, PartialEq)]
pub struct FileInfo {
    /// Sanitized relative path ("/"-separated, single file for single-file torrents).
    pub path: String,
    pub size: u64,
    /// Absolute byte offset inside the concatenated piece space.
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Metainfo {
    pub announce: Option<String>,
    /// Flattened announce-list (each tier's URLs in order).
    pub announce_list: Vec<String>,
    /// 20 raw bytes; `info_hash_hex()` renders lowercase hex.
    pub info_hash: [u8; 20],
    pub name: String,
    pub piece_length: u32,
    /// Raw concatenated SHA-1s, `num_pieces * 20` bytes.
    pub pieces: Vec<u8>,
    pub num_pieces: usize,
    pub files: Vec<FileInfo>,
    pub total_size: u64,
    pub private: bool,
}

impl Metainfo {
    pub fn info_hash_hex(&self) -> String {
        hex20(&self.info_hash)
    }

    /// Expected SHA-1 of piece `index` (panics only on an out-of-range index; the picker
    /// never produces one).
    pub fn piece_hash(&self, index: usize) -> [u8; 20] {
        let mut h = [0u8; 20];
        h.copy_from_slice(&self.pieces[index * 20..(index + 1) * 20]);
        h
    }

    /// Byte length of piece `index` (the last piece is usually short).
    pub fn piece_len(&self, index: usize) -> u32 {
        if index + 1 == self.num_pieces {
            let rem = self.total_size % self.piece_length as u64;
            if rem == 0 {
                self.piece_length
            } else {
                rem as u32
            }
        } else {
            self.piece_length
        }
    }

    /// File containing byte `offset` of the concatenated piece space.
    pub fn file_at(&self, offset: u64) -> &FileInfo {
        self.files
            .iter()
            .find(|f| offset >= f.offset && offset < f.offset + f.size)
            .or_else(|| self.files.last())
            .expect("metainfo always has at least one file")
    }
}

/// Sanitize one path segment: reject traversal, absolutization and drive-letter tricks;
/// map everything else to a safe, human-readable segment.
pub fn sanitize_segment(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return None;
    }
    if trimmed.contains(':') || trimmed.contains('\0') {
        // ":" blocks Windows drive letters / ADS ("C:" / "file:stream")
        return None;
    }
    // Windows reserved device names are not filenames.
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let upper = trimmed.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    if RESERVED.contains(&stem) {
        return None;
    }
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            '<' | '>' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned)
}

/// Parse a .torrent file's raw bytes.
pub fn parse(bytes: &[u8]) -> Result<Metainfo, BtError> {
    let (top, info_span) = decode_top_with_span(bytes, b"info")
        .map_err(|e| BtError::invalid_metainfo(format!("bencode: {e}")))?;
    let info_span =
        info_span.ok_or_else(|| BtError::invalid_metainfo("metainfo has no info dict"))?;
    let info = top
        .get(b"info")
        .ok_or_else(|| BtError::invalid_metainfo("metainfo has no info dict"))?;

    // v2 detection: "meta version" 2 without v1 `pieces` → v2-only. Hybrid torrents keep
    // `pieces` and work through the v1 path.
    let meta_version = top.get(b"meta version").and_then(|v| v.as_int());
    let has_pieces = info.get(b"pieces").is_some();
    let has_file_tree = info.get(b"file tree").is_some();
    if !has_pieces && (meta_version == Some(2) || has_file_tree) {
        return Err(BtError::v2_unsupported());
    }

    let info_hash: [u8; 20] = Sha1::digest(&bytes[info_span.clone()]).into();

    let name = info
        .get(b"name.utf-8")
        .or_else(|| info.get(b"name"))
        .and_then(|v| v.as_bytes())
        .and_then(|b| std::str::from_utf8(b).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BtError::invalid_metainfo("info dict has no usable name"))?;
    let name = sanitize_segment(&name)
        .ok_or_else(|| BtError::invalid_metainfo("torrent name is not a safe filename"))?;

    let piece_length = info
        .get(b"piece length")
        .and_then(|v| v.as_int())
        .filter(|v| *v > 0 && *v <= 64 * 1024 * 1024)
        .ok_or_else(|| BtError::invalid_metainfo("piece length missing or out of range"))?
        as u32;

    let pieces_raw = info
        .get(b"pieces")
        .and_then(|v| v.as_bytes())
        .ok_or_else(|| BtError::invalid_metainfo("v1 piece hashes missing"))?;
    if pieces_raw.is_empty() || pieces_raw.len() % 20 != 0 {
        return Err(BtError::invalid_metainfo(
            "piece hashes are not 20-byte aligned",
        ));
    }
    let num_pieces = pieces_raw.len() / 20;

    let mut files: Vec<FileInfo> = Vec::new();
    let mut total: u64 = 0;
    match info.get(b"files") {
        None => {
            let len = info
                .get(b"length")
                .and_then(|v| v.as_int())
                .filter(|v| *v >= 0)
                .ok_or_else(|| BtError::invalid_metainfo("single-file torrent has no length"))?
                as u64;
            total = len;
            files.push(FileInfo {
                path: name.clone(),
                size: len,
                offset: 0,
            });
        }
        Some(list) => {
            for entry in list
                .as_list()
                .ok_or_else(|| BtError::invalid_metainfo("files is not a list"))?
            {
                let len = entry
                    .get(b"length")
                    .and_then(|v| v.as_int())
                    .filter(|v| *v >= 0)
                    .ok_or_else(|| BtError::invalid_metainfo("file entry has no length"))?
                    as u64;
                let raw_path: Vec<String> = entry
                    .get(b"path.utf-8")
                    .or_else(|| entry.get(b"path"))
                    .and_then(|v| v.as_list())
                    .map(|segs| {
                        segs.iter()
                            .filter_map(|s| s.as_bytes())
                            .filter_map(|b| std::str::from_utf8(b).ok())
                            .map(|s| s.to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                if raw_path.is_empty() {
                    return Err(BtError::invalid_metainfo("file entry has an empty path"));
                }
                let mut segs: Vec<String> = Vec::with_capacity(raw_path.len());
                for seg in &raw_path {
                    match sanitize_segment(seg) {
                        Some(s) => segs.push(s),
                        None => {
                            return Err(BtError::invalid_metainfo(format!(
                                "unsafe path segment: {seg:?}"
                            )))
                        }
                    }
                }
                total += len;
                files.push(FileInfo {
                    path: segs.join("/"),
                    size: len,
                    offset: total - len,
                });
            }
            if files.is_empty() {
                return Err(BtError::invalid_metainfo("multi-file torrent has no files"));
            }
        }
    }

    if total == 0 {
        return Err(BtError::invalid_metainfo("torrent payload is empty"));
    }
    let expected_pieces = total.div_ceil(piece_length as u64) as usize;
    if expected_pieces != num_pieces {
        return Err(BtError::invalid_metainfo(format!(
            "piece count mismatch: {expected_pieces} expected, {num_pieces} hashed"
        )));
    }

    let mut announce_list = Vec::new();
    if let Some(list) = top.get(b"announce-list") {
        if let Some(tiers) = list.as_list() {
            for tier in tiers {
                if let Some(urls) = tier.as_list() {
                    for u in urls {
                        if let Some(s) = u.as_str() {
                            if !s.trim().is_empty()
                                && !announce_list.contains(&s.trim().to_string())
                            {
                                announce_list.push(s.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    let announce = top
        .get(b"announce")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(a) = &announce {
        if !announce_list.contains(a) {
            announce_list.insert(0, a.clone());
        }
    }

    let private = matches!(
        info.get(b"private").map(|v| v.as_int()).unwrap_or(None),
        Some(1)
    );

    Ok(Metainfo {
        announce,
        announce_list,
        info_hash,
        name,
        piece_length,
        pieces: pieces_raw.to_vec(),
        num_pieces,
        files,
        total_size: total,
        private,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bencode::{bint, bstr, encode, BValue};

    fn build_metainfo(name: &str, files: Vec<(&str, u64)>, piece_len: i64) -> Vec<u8> {
        // piece hashes: SHA-1 of each piece of a deterministic pseudo-payload (we hash the
        // file names padded to piece_len — only self-consistency matters here).
        let total: u64 = files.iter().map(|(_, s)| s).sum();
        let num = total.div_ceil(piece_len as u64) as usize;
        let mut pieces = Vec::with_capacity(num * 20);
        for i in 0..num {
            let mut hasher = Sha1::new();
            hasher.update(name.as_bytes());
            hasher.update((i as u64).to_be_bytes());
            let d: [u8; 20] = hasher.finalize().into();
            pieces.extend_from_slice(&d);
        }
        let files_value = if files.len() == 1 && files[0].0 == name {
            BValue::Int(files[0].1 as i64)
        } else {
            BValue::List(
                files
                    .iter()
                    .map(|(p, s)| {
                        BValue::Dict(vec![
                            (b"length".to_vec(), bint(*s as i64)),
                            (
                                b"path".to_vec(),
                                BValue::List(p.split('/').map(bstr).collect()),
                            ),
                        ])
                    })
                    .collect(),
            )
        };
        let mut info_pairs: Vec<(Vec<u8>, BValue)> = vec![
            (b"name".to_vec(), bstr(name)),
            (b"piece length".to_vec(), bint(piece_len)),
            (b"pieces".to_vec(), BValue::Bytes(pieces)),
        ];
        if files.len() == 1 && files[0].0 == name {
            info_pairs.push((b"length".to_vec(), files_value));
        } else {
            info_pairs.push((b"files".to_vec(), files_value));
        }
        let top = BValue::Dict(vec![
            (b"announce".to_vec(), bstr("http://tracker.example/ann")),
            (
                b"announce-list".to_vec(),
                BValue::List(vec![BValue::List(vec![
                    bstr("http://t1.example/ann"),
                    bstr("udp://t2.example:6969"),
                ])]),
            ),
            (b"info".to_vec(), BValue::Dict(info_pairs)),
        ]);
        encode(&top)
    }

    #[test]
    fn parses_single_file_torrent_with_exact_info_hash() {
        let bytes = build_metainfo("sample.bin", vec![("sample.bin", 96 * 1024)], 32 * 1024);
        let meta = parse(&bytes).unwrap();
        assert_eq!(meta.name, "sample.bin");
        assert_eq!(meta.num_pieces, 3);
        assert_eq!(meta.piece_length, 32 * 1024);
        assert_eq!(meta.total_size, 96 * 1024);
        assert_eq!(meta.files.len(), 1);
        assert_eq!(meta.files[0].path, "sample.bin");
        assert_eq!(meta.files[0].offset, 0);
        // announce list flattens tiers, announce first
        assert_eq!(meta.announce.as_deref(), Some("http://tracker.example/ann"));
        assert!(meta
            .announce_list
            .contains(&"udp://t2.example:6969".to_string()));
        // info-hash must equal SHA-1 of the exact info span inside the file
        let (_, span) = decode_top_with_span(&bytes, b"info").unwrap();
        let span = span.unwrap();
        let expected: [u8; 20] = Sha1::digest(&bytes[span]).into();
        assert_eq!(meta.info_hash, expected);
        // last piece is short when total is not a multiple
        let meta2 = parse(&build_metainfo("s", vec![("s", 100)], 32)).unwrap();
        assert_eq!(meta2.num_pieces, 4);
        assert_eq!(meta2.piece_len(3), 4);
        assert_eq!(meta2.piece_len(0), 32);
    }

    #[test]
    fn parses_multi_file_torrent_with_offsets() {
        let bytes = build_metainfo("pack", vec![("a.txt", 10), ("sub/b.bin", 20)], 16);
        let meta = parse(&bytes).unwrap();
        assert_eq!(meta.files.len(), 2);
        assert_eq!(meta.files[0].path, "a.txt");
        assert_eq!(meta.files[0].offset, 0);
        assert_eq!(meta.files[1].path, "sub/b.bin");
        assert_eq!(meta.files[1].offset, 10);
        assert_eq!(meta.total_size, 30);
        assert_eq!(meta.num_pieces, 2);
    }

    #[test]
    fn v2_only_is_classified_refusal() {
        let top = BValue::Dict(vec![
            (
                b"info".to_vec(),
                BValue::Dict(vec![
                    (b"name".to_vec(), bstr("v2")),
                    (b"piece length".to_vec(), bint(16384)),
                    (b"file tree".to_vec(), BValue::Dict(vec![])),
                ]),
            ),
            (b"meta version".to_vec(), bint(2)),
        ]);
        let err = parse(&encode(&top)).unwrap_err();
        assert_eq!(err.code, dc_protocol::ErrorCode::TorrentV2Unsupported);
    }

    #[test]
    fn unsafe_paths_are_refused() {
        // direct segment checks
        assert!(sanitize_segment("../evil").is_none());
        assert!(sanitize_segment("C:").is_none());
        assert!(sanitize_segment("NUL").is_none());
        assert!(sanitize_segment("..").is_none());
        assert!(sanitize_segment("").is_none());
        assert_eq!(sanitize_segment("a<b|c").as_deref(), Some("a_b_c"));
        assert_eq!(sanitize_segment("ok.txt").as_deref(), Some("ok.txt"));
        // traversal path inside a multi-file torrent is refused at parse time
        let top = BValue::Dict(vec![(
            b"info".to_vec(),
            BValue::Dict(vec![
                (b"name".to_vec(), bstr("pack")),
                (b"piece length".to_vec(), bint(16)),
                (
                    b"files".to_vec(),
                    BValue::List(vec![BValue::Dict(vec![
                        (b"length".to_vec(), bint(10)),
                        (
                            b"path".to_vec(),
                            BValue::List(vec![bstr(".."), bstr("evil")]),
                        ),
                    ])]),
                ),
            ]),
        )]);
        let err = parse(&encode(&top)).unwrap_err();
        assert_eq!(err.code, dc_protocol::ErrorCode::TorrentInvalidMetainfo);
    }

    #[test]
    fn piece_count_mismatch_is_invalid() {
        let bytes = build_metainfo("x", vec![("x", 64)], 32);
        // truncate the pieces blob: 64 bytes / 32 = 2 pieces but only 1 hash left
        let mut top = decode_top_with_span(&bytes, b"info").unwrap().0;
        if let BValue::Dict(pairs) = &mut top {
            for (k, v) in pairs.iter_mut() {
                if k == b"info" {
                    if let BValue::Dict(info_pairs) = v {
                        for (ik, iv) in info_pairs.iter_mut() {
                            if ik == b"pieces" {
                                if let BValue::Bytes(b) = iv {
                                    b.truncate(20);
                                }
                            }
                        }
                    }
                }
            }
        }
        let raw = encode(&top);
        let err = parse(&raw).unwrap_err();
        assert_eq!(err.code, dc_protocol::ErrorCode::TorrentInvalidMetainfo);
    }
}
