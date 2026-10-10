//! Error codes — must stay aligned with packages/contracts/src/errors.ts (append-only).

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    // protocol-level
    ParseError,
    InvalidParams,
    MethodNotFound,
    UnsupportedVersion,
    InternalError,
    Timeout,
    CoreUnavailable,
    // storage
    StorageError,
    // filesystem
    IoError,
    FileExists,
    DiskFull,
    // network / http
    NetworkError,
    HttpError,
    RangeNotSatisfiable,
    UrlInvalid,
    // job lifecycle
    Canceled,
    InvalidState,
    ChecksumMismatch,
    // recovery (v1.2, Phase 7) — classified re-acquisition outcomes; append-only
    SourceGone,
    SourceForbidden,
    SourceChanged,
    // proxy (v1.4, Phase 9) — append-only
    ProxyKeychainUnavailable,
    ProxyProfileNotFound,
    ProxyInUse,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::ParseError => "parse_error",
            ErrorCode::InvalidParams => "invalid_params",
            ErrorCode::MethodNotFound => "method_not_found",
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::InternalError => "internal_error",
            ErrorCode::Timeout => "timeout",
            ErrorCode::CoreUnavailable => "core_unavailable",
            ErrorCode::StorageError => "storage_error",
            ErrorCode::IoError => "io_error",
            ErrorCode::FileExists => "file_exists",
            ErrorCode::DiskFull => "disk_full",
            ErrorCode::NetworkError => "network_error",
            ErrorCode::HttpError => "http_error",
            ErrorCode::RangeNotSatisfiable => "range_not_satisfiable",
            ErrorCode::UrlInvalid => "url_invalid",
            ErrorCode::Canceled => "canceled",
            ErrorCode::InvalidState => "invalid_state",
            ErrorCode::ChecksumMismatch => "checksum_mismatch",
            ErrorCode::SourceGone => "source_gone",
            ErrorCode::SourceForbidden => "source_forbidden",
            ErrorCode::SourceChanged => "source_changed",
            ErrorCode::ProxyKeychainUnavailable => "proxy_keychain_unavailable",
            ErrorCode::ProxyProfileNotFound => "proxy_profile_not_found",
            ErrorCode::ProxyInUse => "proxy_in_use",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Mirrors the ContractError schema: { code, message, data? }.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContractError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ContractError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ContractError {}
