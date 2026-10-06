//! DownloadJob — mirrors packages/contracts/src/domain/download.ts (camelCase on the wire).

use crate::ids::Ulid;
use serde::{Deserialize, Serialize};

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
    /// Absolute final path; None until the probe resolves the filename.
    #[serde(rename = "destinationPath", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}
