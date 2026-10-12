//! Torrent domain (Phase 13, v1.8) — mirrors packages/contracts/src/domain/torrent.ts.
//!
//! Wire rules as in `MediaJob`: fields declared `.nullable()` in zod are ALWAYS serialized
//! (None → null); plain `Option` fields are omitted when None. The torrent domain's
//! lifecycle semantics live in `download-core/src/torrent_manager.rs`.

use crate::ids::Ulid;
use serde::{Deserialize, Serialize};

/// Torrent job lifecycle statuses (mirrors `TorrentStatus` in the TS contracts).
pub const TORRENT_JOB_STATUSES: [&str; 8] = [
    "queued",
    "metadata",
    "downloading",
    "seeding",
    "paused",
    "completed",
    "failed",
    "canceled",
];

/// Where the job's source came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TorrentSourceKind {
    Torrent,
    Magnet,
}

impl TorrentSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TorrentSourceKind::Torrent => "torrent",
            TorrentSourceKind::Magnet => "magnet",
        }
    }
}

/// One file of a multi-file torrent (or the single file itself).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TorrentFileEntry {
    /// Relative, "/"-separated, traversal-proof path.
    pub path: String,
    pub size: u64,
    /// Absolute byte offset inside the concatenated piece space.
    pub offset: u64,
}

/// A persistent torrent job — mirrors the TS `TorrentJob` wire shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentJob {
    pub id: Ulid,
    /// Display name; null until the metainfo (or magnet `dn`) resolves it (always serialized).
    pub name: Option<String>,
    pub status: String,
    #[serde(rename = "sourceKind")]
    pub source_kind: TorrentSourceKind,
    /// 40-char lowercase hex v1 info hash; null for magnets until metadata (always serialized).
    #[serde(rename = "infoHash")]
    pub info_hash: Option<String>,
    #[serde(rename = "destinationDir")]
    pub destination_dir: String,
    /// Total payload size; null until metadata (always serialized).
    #[serde(rename = "totalBytes")]
    pub total_bytes: Option<u64>,
    #[serde(rename = "receivedBytes")]
    pub received_bytes: u64,
    #[serde(rename = "uploadedBytes")]
    pub uploaded_bytes: u64,
    #[serde(rename = "downloadSpeedBps")]
    pub download_speed_bps: u64,
    #[serde(rename = "uploadSpeedBps")]
    pub upload_speed_bps: u64,
    pub peers: u64,
    pub seeds: u64,
    #[serde(rename = "etaSeconds")]
    pub eta_seconds: Option<u64>,
    #[serde(rename = "numPieces")]
    pub num_pieces: Option<u64>,
    #[serde(rename = "pieceLength")]
    pub piece_length: Option<u64>,
    /// Empty until metadata (always serialized as an array).
    pub files: Vec<TorrentFileEntry>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(rename = "proxyProfileId")]
    pub proxy_profile_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// `torrent.add` params (camelCase wire; exactly one of magnetUri / torrentFileB64 —
/// the refinement is mirrored at the core boundary).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TorrentAddParams {
    #[serde(rename = "magnetUri", skip_serializing_if = "Option::is_none")]
    pub magnet_uri: Option<String>,
    /// Base64-encoded .torrent file; the core caps the decoded size.
    #[serde(rename = "torrentFileB64", skip_serializing_if = "Option::is_none")]
    pub torrent_file_b64: Option<String>,
    #[serde(rename = "destinationDir")]
    pub destination_dir: String,
    #[serde(rename = "proxyProfileId", skip_serializing_if = "Option::is_none")]
    pub proxy_profile_id: Option<String>,
}

/// `torrent.add` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentAddResult {
    pub job: TorrentJob,
}

/// `torrent.list` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentListResult {
    pub jobs: Vec<TorrentJob>,
}

/// `torrent.remove` params.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TorrentRemoveParams {
    pub id: String,
    #[serde(rename = "deleteFiles", default)]
    pub delete_files: bool,
}

/// Throttled progress payload (`torrent.progress` event).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentProgress {
    #[serde(rename = "jobId")]
    pub job_id: String,
    /// Active status: metadata | downloading | seeding.
    pub phase: String,
    #[serde(rename = "receivedBytes")]
    pub received_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: Option<u64>,
    #[serde(rename = "downloadSpeedBps")]
    pub download_speed_bps: u64,
    #[serde(rename = "uploadSpeedBps")]
    pub upload_speed_bps: u64,
    pub peers: u64,
    pub seeds: u64,
    #[serde(rename = "etaSeconds")]
    pub eta_seconds: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn torrent_job_round_trips_camel_case_wire_shape() {
        let job = TorrentJob {
            id: Ulid("01JD8W3G5XQ9V4M2K7PZ6N8S0X".into()),
            name: Some("Sample Torrent".into()),
            status: "downloading".into(),
            source_kind: TorrentSourceKind::Torrent,
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
            destination_dir: "/home/user/Downloads".into(),
            total_bytes: Some(262_144),
            received_bytes: 131_072,
            uploaded_bytes: 4_096,
            download_speed_bps: 524_288,
            upload_speed_bps: 16_384,
            peers: 7,
            seeds: 3,
            eta_seconds: Some(1),
            num_pieces: Some(4),
            piece_length: Some(65_536),
            files: vec![TorrentFileEntry {
                path: "Sample Torrent/sample.txt".into(),
                size: 262_144,
                offset: 0,
            }],
            error_code: None,
            proxy_profile_id: None,
            created_at: 1_735_689_600_000,
            updated_at: 1_735_689_900_000,
        };
        let json = serde_json::to_value(&job).unwrap();
        assert_eq!(json["sourceKind"], "torrent");
        assert_eq!(json["infoHash"], "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(json["files"][0]["path"], "Sample Torrent/sample.txt");
        assert!(json["name"].is_string());
        assert!(json["errorCode"].is_null());
        assert!(json["proxyProfileId"].is_null());
        let back: TorrentJob = serde_json::from_value(json).unwrap();
        assert_eq!(back, job);
    }

    #[test]
    fn magnet_job_serializes_null_identity_fields() {
        let job = TorrentJob {
            id: Ulid("01JD8W3G5XQ9V4M2K7PZ6N8S0W".into()),
            name: None,
            status: "metadata".into(),
            source_kind: TorrentSourceKind::Magnet,
            info_hash: None,
            destination_dir: "/home/user/Downloads".into(),
            total_bytes: None,
            received_bytes: 0,
            uploaded_bytes: 0,
            download_speed_bps: 0,
            upload_speed_bps: 0,
            peers: 0,
            seeds: 0,
            eta_seconds: None,
            num_pieces: None,
            piece_length: None,
            files: vec![],
            error_code: None,
            proxy_profile_id: Some("01HQ".into()),
            created_at: 1_735_689_600_000,
            updated_at: 1_735_689_900_000,
        };
        let json = serde_json::to_value(&job).unwrap();
        assert!(json["name"].is_null());
        assert!(json["infoHash"].is_null());
        assert_eq!(json["files"], serde_json::json!([]));
        assert_eq!(json["proxyProfileId"], "01HQ");
        let back: TorrentJob = serde_json::from_value(json).unwrap();
        assert_eq!(back, job);
    }

    #[test]
    fn add_params_accept_optional_fields_and_defaults() {
        let p: TorrentAddParams = serde_json::from_str(
            r#"{"magnetUri": "magnet:?xt=urn:btih:aa", "destinationDir": "/d"}"#,
        )
        .unwrap();
        assert_eq!(p.magnet_uri.as_deref(), Some("magnet:?xt=urn:btih:aa"));
        assert!(p.torrent_file_b64.is_none());
        assert!(p.proxy_profile_id.is_none());

        let p: TorrentRemoveParams =
            serde_json::from_str(r#"{"id": "01JD8W3G5XQ9V4M2K7PZ6N8S0X"}"#).unwrap();
        assert!(!p.delete_files, "deleteFiles defaults to false");
    }

    #[test]
    fn torrent_progress_round_trips() {
        let raw = serde_json::json!({
            "jobId": "01JD8W3G5XQ9V4M2K7PZ6N8S0X",
            "phase": "seeding",
            "receivedBytes": 262_144,
            "totalBytes": 262_144,
            "downloadSpeedBps": 0,
            "uploadSpeedBps": 16_384,
            "peers": 2,
            "seeds": 0,
            "etaSeconds": null,
        });
        let p: TorrentProgress = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(p.phase, "seeding");
        assert_eq!(serde_json::to_value(&p).unwrap(), raw);
    }
}
