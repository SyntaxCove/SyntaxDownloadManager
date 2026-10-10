//! DownloadJob — mirrors packages/contracts/src/domain/download.ts (camelCase on the wire).
//!
//! Wire-shape rules (must match the zod schemas exactly):
//!  - fields the TS side declares `.nullable()` are ALWAYS serialized (None → null);
//!  - fields the TS side declares `.nullish()`/`.optional()` are omitted when None.

use crate::ids::Ulid;
use serde::{Deserialize, Serialize};

/// Checksum algorithms (v1.1) — mirrors `ChecksumAlgorithm` in the TS contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChecksumAlgorithm {
    Sha256,
    Sha1,
    Md5,
}

impl ChecksumAlgorithm {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChecksumAlgorithm::Sha256 => "sha256",
            ChecksumAlgorithm::Sha1 => "sha1",
            ChecksumAlgorithm::Md5 => "md5",
        }
    }

    /// Required lowercase-hex digest length for the algorithm.
    pub fn hex_len(&self) -> usize {
        match self {
            ChecksumAlgorithm::Sha256 => 64,
            ChecksumAlgorithm::Sha1 => 40,
            ChecksumAlgorithm::Md5 => 32,
        }
    }
}

pub const DOWNLOAD_STATUSES: [&str; 7] = [
    "queued",
    "probing",
    "downloading",
    "paused",
    "completed",
    "failed",
    "canceled",
];

pub fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: Ulid,
    pub url: String,
    /// Absolute save directory (known at creation).
    #[serde(rename = "destinationDir")]
    pub destination_dir: String,
    /// Absolute final path; null until the probe resolves the filename (always serialized).
    #[serde(rename = "destinationPath")]
    pub destination_path: Option<String>,
    /// Explicit filename from creation params, when provided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub status: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: Option<u64>,
    #[serde(rename = "receivedBytes")]
    pub received_bytes: u64,
    pub etag: Option<String>,
    #[serde(rename = "lastModified")]
    pub last_modified: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "speedBps")]
    pub speed_bps: Option<u64>,
    #[serde(rename = "etaSeconds")]
    pub eta_seconds: Option<u64>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    /// Request headers captured at creation (absent/null when none were given).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
    // ---- v1.1 (Phase 6): segmentation + integrity ----
    /// Number of planned range windows; null until the probe plans them (always serialized).
    #[serde(rename = "segmentCount")]
    pub segment_count: Option<u64>,
    /// Expected checksum from creation params (omitted when none was given).
    #[serde(rename = "checksumAlgorithm", skip_serializing_if = "Option::is_none")]
    pub checksum_algorithm: Option<ChecksumAlgorithm>,
    #[serde(rename = "checksumExpected", skip_serializing_if = "Option::is_none")]
    pub checksum_expected: Option<String>,
    /// Streaming SHA-256 over the finished part file (always serialized; null before hashing).
    #[serde(rename = "checksumActual")]
    pub checksum_actual: Option<String>,
    /// Expected-vs-actual verdict; null = never compared (always serialized).
    #[serde(rename = "checksumVerified")]
    pub checksum_verified: Option<bool>,
    // ---- v1.2 (Phase 7): recovery audit trail ----
    /// How many times the job was rebound to a (re-)acquired source (always serialized).
    #[serde(rename = "recoveryCount")]
    pub recovery_count: Option<u64>,
    /// Epoch ms of the most recent rebind (always serialized).
    #[serde(rename = "reboundAt")]
    pub rebound_at: Option<i64>,
    // ---- v1.3 (Phase 8): queue + bandwidth ----
    /// 0-based queue slot while `queued` (pump order); null once the job leaves the
    /// queue (always serialized).
    #[serde(rename = "queuePosition")]
    pub queue_position: Option<u64>,
    /// Per-job bandwidth cap in KiB/s; omitted when unset (0 = unlimited).
    #[serde(rename = "speedLimitKBps", skip_serializing_if = "Option::is_none")]
    pub speed_limit_kbps: Option<u64>,
    // ---- v1.4 (Phase 9): proxy routing ----
    /// Proxy profile the job routes through; None = direct (always serialized).
    #[serde(rename = "proxyProfileId")]
    pub proxy_profile_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}
