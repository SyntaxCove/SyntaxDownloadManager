//! Bencode codec — decode (order-preserving dicts, raw-span extraction) + canonical encode.
//!
//! The info-hash is SHA-1 over the EXACT raw bytes of the `info` dict, so the decoder must
//! never re-encode to find it. `decode_top_with_span` returns the byte span of a top-level
//! key's value alongside its decoded value.

/// Decoded bencode value. Dicts preserve file order (keys sorted canonically by encoders,
/// but real-world files occasionally deviate — we never reorder on the decode path).
#[derive(Debug, Clone, PartialEq)]
pub enum BValue {
    Int(i64),
    Bytes(Vec<u8>),
    List(Vec<BValue>),
    Dict(Vec<(Vec<u8>, BValue)>),
}

impl BValue {
    pub fn as_int(&self) -> Option<i64> {
        match self {
            BValue::Int(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            BValue::Bytes(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            BValue::Bytes(b) => std::str::from_utf8(b).ok(),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[BValue]> {
        match self {
            BValue::List(l) => Some(l),
            _ => None,
        }
    }

    pub fn get(&self, key: &[u8]) -> Option<&BValue> {
        match self {
            BValue::Dict(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BencodeError {
    #[error("unexpected end of input")]
    Eof,
    #[error("invalid character {0:?} at offset {1}")]
    InvalidChar(u8, usize),
    #[error("invalid integer at offset {0}")]
    InvalidInt(usize),
    #[error("length prefix overflows at offset {0}")]
    LengthOverflow(usize),
    #[error("dictionary key not a byte string at offset {0}")]
    DictKeyNotString(usize),
    #[error("unsorted dictionary keys at offset {0}")]
    DictKeysUnsorted(usize),
    #[error("trailing bytes after value (offset {0})")]
    TrailingBytes(usize),
}

/// Decode one value starting at `pos`; returns (value, end offset exclusive).
pub fn decode_at(src: &[u8], pos: usize) -> Result<(BValue, usize), BencodeError> {
    match src.get(pos).copied() {
        None => Err(BencodeError::Eof),
        Some(b'i') => {
            let end = src[pos..]
                .iter()
                .position(|&b| b == b'e')
                .ok_or(BencodeError::Eof)?
                + pos;
            let body = std::str::from_utf8(&src[pos + 1..end])
                .map_err(|_| BencodeError::InvalidInt(pos))?;
            let body = body.strip_prefix('-').unwrap_or(body);
            if body.is_empty() || (body.len() > 1 && body.starts_with('0')) {
                return Err(BencodeError::InvalidInt(pos));
            }
            if !body.bytes().all(|b| b.is_ascii_digit()) {
                return Err(BencodeError::InvalidInt(pos));
            }
            let v: i64 = body
                .parse()
                .map_err(|_| BencodeError::LengthOverflow(pos))?;
            Ok((BValue::Int(v), end + 1))
        }
        Some(d @ b'0'..=b'9') => {
            let colon = src[pos..]
                .iter()
                .position(|&b| b == b':')
                .ok_or(BencodeError::Eof)?
                + pos;
            let len_str = std::str::from_utf8(&src[pos..colon])
                .map_err(|_| BencodeError::InvalidChar(d, pos))?;
            if len_str.len() > 1 && len_str.starts_with('0') {
                return Err(BencodeError::InvalidInt(pos));
            }
            let len: usize = len_str
                .parse()
                .map_err(|_| BencodeError::LengthOverflow(pos))?;
            let start = colon + 1;
            let end = start
                .checked_add(len)
                .filter(|&e| e <= src.len())
                .ok_or(BencodeError::Eof)?;
            Ok((BValue::Bytes(src[start..end].to_vec()), end))
        }
        Some(b'l') => {
            let mut items = Vec::new();
            let mut pos = pos + 1;
            loop {
                match src.get(pos).copied() {
                    None => return Err(BencodeError::Eof),
                    Some(b'e') => return Ok((BValue::List(items), pos + 1)),
                    Some(_) => {
                        let (v, next) = decode_at(src, pos)?;
                        items.push(v);
                        pos = next;
                    }
                }
            }
        }
        Some(b'd') => {
            let mut pairs: Vec<(Vec<u8>, BValue)> = Vec::new();
            let mut pos = pos + 1;
            loop {
                match src.get(pos).copied() {
                    None => return Err(BencodeError::Eof),
                    Some(b'e') => return Ok((BValue::Dict(pairs), pos + 1)),
                    Some(b'0'..=b'9') => {
                        let (k, next) = decode_at(src, pos)?;
                        let key = match k {
                            BValue::Bytes(b) => b,
                            _ => return Err(BencodeError::DictKeyNotString(pos)),
                        };
                        if let Some((prev, _)) = pairs.last() {
                            if prev.as_slice() >= key.as_slice() {
                                return Err(BencodeError::DictKeysUnsorted(pos));
                            }
                        }
                        let (v, next) = decode_at(src, next)?;
                        pairs.push((key, v));
                        pos = next;
                    }
                    Some(_) => return Err(BencodeError::DictKeyNotString(pos)),
                }
            }
        }
        Some(other) => Err(BencodeError::InvalidChar(other, pos)),
    }
}

/// Decode a complete buffer (must be exactly one value).
pub fn decode(src: &[u8]) -> Result<BValue, BencodeError> {
    let (v, end) = decode_at(src, 0)?;
    if end != src.len() {
        return Err(BencodeError::TrailingBytes(end));
    }
    Ok(v)
}

/// Decode a complete buffer and additionally return the raw byte span of a top-level key's
/// value (used for the exact-bytes `info` dict the info-hash is computed over).
pub fn decode_top_with_span(
    src: &[u8],
    key: &[u8],
) -> Result<(BValue, Option<std::ops::Range<usize>>), BencodeError> {
    let mut pairs: Vec<(Vec<u8>, Option<std::ops::Range<usize>>)> = Vec::new();
    let mut pos = 1usize; // top-level must be a dict starting with 'd'
    if src.first() != Some(&b'd') {
        return Err(BencodeError::InvalidChar(
            src.first().copied().unwrap_or(0),
            0,
        ));
    }
    let mut values: Vec<BValue> = Vec::new();
    loop {
        match src.get(pos).copied() {
            None => return Err(BencodeError::Eof),
            Some(b'e') => {
                let span = pairs
                    .iter()
                    .find(|(k, _)| k.as_slice() == key)
                    .and_then(|(_, s)| s.clone());
                let dict = BValue::Dict(
                    pairs
                        .drain(..)
                        .zip(values.drain(..))
                        .map(|((k, _), v)| (k, v))
                        .collect(),
                );
                return Ok((dict, span));
            }
            Some(b'0'..=b'9') => {
                let (kv, k_end) = decode_at(src, pos)?;
                let key_bytes = match kv {
                    BValue::Bytes(b) => b,
                    _ => return Err(BencodeError::DictKeyNotString(pos)),
                };
                let (v, v_end) = decode_at(src, k_end)?;
                let span = if key_bytes.as_slice() == key {
                    Some(k_end..v_end)
                } else {
                    None
                };
                pairs.push((key_bytes, span));
                values.push(v);
                pos = v_end;
            }
            Some(_) => return Err(BencodeError::DictKeyNotString(pos)),
        }
    }
}

fn encode_into(out: &mut Vec<u8>, v: &BValue) {
    match v {
        BValue::Int(i) => {
            out.push(b'i');
            out.extend_from_slice(i.to_string().as_bytes());
            out.push(b'e');
        }
        BValue::Bytes(b) => {
            out.extend_from_slice(b.len().to_string().as_bytes());
            out.push(b':');
            out.extend_from_slice(b);
        }
        BValue::List(items) => {
            out.push(b'l');
            for item in items {
                encode_into(out, item);
            }
            out.push(b'e');
        }
        BValue::Dict(pairs) => {
            out.push(b'd');
            let mut sorted: Vec<&(Vec<u8>, BValue)> = pairs.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            for (k, v) in sorted {
                out.extend_from_slice(k.len().to_string().as_bytes());
                out.push(b':');
                out.extend_from_slice(k);
                encode_into(out, v);
            }
            out.push(b'e');
        }
    }
}

/// Canonical bencode encoding (dict keys sorted lexicographically).
pub fn encode(v: &BValue) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(&mut out, v);
    out
}

/// Convenience builders.
pub fn bstr(s: &str) -> BValue {
    BValue::Bytes(s.as_bytes().to_vec())
}

pub fn bint(i: i64) -> BValue {
    BValue::Int(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_all_types() {
        let src = b"d3:bar4:spam3:fooi42ee";
        let v = decode(src).unwrap();
        assert_eq!(
            v,
            BValue::Dict(vec![
                (b"bar".to_vec(), BValue::Bytes(b"spam".to_vec())),
                (b"foo".to_vec(), BValue::Int(42)),
            ])
        );
        assert_eq!(encode(&v), src.to_vec());
    }

    #[test]
    fn decodes_nested_structures() {
        let src = b"ll3:aaael4:bbbdee";
        let v = decode(src).unwrap();
        let list = v.as_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].as_list().unwrap()[0].as_str(), Some("aaa"));
        assert_eq!(list[1].as_list().unwrap()[0].as_str(), Some("bbbd"));
    }

    #[test]
    fn span_extraction_covers_exact_info_bytes() {
        // A canonical dict where info sits in the middle; span must cover `4:spame` exactly.
        let src = b"d4:infod4:spam4:eggsee";
        let (v, span) = decode_top_with_span(src, b"info").unwrap();
        let span = span.expect("info span found");
        assert_eq!(&src[span.clone()], b"d4:spam4:eggse");
        assert!(v.get(b"info").is_some());
        let (v, span) = decode_top_with_span(src, b"missing").unwrap();
        assert!(span.is_none());
        assert!(v.get(b"info").is_some());
    }

    #[test]
    fn span_is_none_for_missing_key() {
        let (_, span) = decode_top_with_span(b"d1:ai1ee", b"info").unwrap();
        assert!(span.is_none());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(decode(b"").is_err());
        assert!(decode(b"i12").is_err());
        assert!(decode(b"4:spa").is_err());
        assert!(decode(b"ie").is_err());
        assert!(decode(b"i012e").is_err());
        assert!(decode(b"01:a").is_err());
        assert!(decode(b"d1:bi1e1:bi2ee").is_err(), "unsorted dict keys");
        assert!(decode(b"di1ei2ee").is_err(), "int dict key");
        assert!(decode(b"i1ei2e").is_err(), "trailing bytes");
        assert!(decode(b"d1:ai1ee").is_ok());
    }

    #[test]
    fn encode_produces_canonical_output() {
        let v = BValue::Dict(vec![(b"zz".to_vec(), bint(1)), (b"aa".to_vec(), bstr("x"))]);
        assert_eq!(encode(&v), b"d2:aa1:x2:zzi1ee".to_vec());
    }

    #[test]
    fn big_integers_round_trip() {
        let v = BValue::Int(9_223_372_036_854_775_807);
        assert_eq!(decode(&encode(&v)).unwrap(), v);
        // i64 overflow is rejected, not wrapped
        assert!(decode(b"i99999999999999999999e").is_err());
    }
}
