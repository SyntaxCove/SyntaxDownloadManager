//! dc-protocol — Rust mirror of `packages/contracts` (the Syntax Download Manager wire contract).
//!
//! Both sides must agree byte-for-byte on the JSON shapes; shared fixtures in
//! `packages/contracts/fixtures/` are parsed by tests on both languages.

pub mod browser;
pub mod diagnostics;
pub mod envelope;
pub mod error;
pub mod ids;
pub mod job;
pub mod media;
pub mod scheduler;
pub mod toolkit;
pub mod torrent;

pub use browser::{
    Bookmark, BookmarkCreateParams, BookmarkGetByUrlResult, BookmarkUpdateParams, HistoryEntry,
    HistoryListParams, HistoryListResult, HistoryRecordParams,
};
pub use diagnostics::{CoreHealthCounts, CoreHealthSnapshot};
pub use envelope::{
    make_error, make_event, make_request, make_success, ErrorEnvelope, EventEnvelope,
    RequestEnvelope, ResponseEnvelope, SuccessEnvelope,
};
pub use error::{ContractError, ErrorCode};
pub use ids::{new_ulid, ulid_time, Ulid, UlidError};
pub use job::{ChecksumAlgorithm, DownloadJob};
pub use media::{
    AudioFormat, MediaContainer, MediaDownloadParams, MediaDownloadResult, MediaInspectParams,
    MediaInspectResult, MediaJob, MediaListResult, MediaManifest, MediaProgress, MediaRemoveParams,
    MediaSubtitleSelection, SubtitleTrack, VideoFormat,
};
pub use scheduler::{
    SchedulerCreateParams, SchedulerCreateResult, SchedulerJob, SchedulerJobResult,
    SchedulerListResult, SchedulerPatch, SchedulerSetClockParams, SchedulerUpdateParams,
};
pub use toolkit::{ToolkitPathEntry, ToolkitSetPathsParams};
pub use torrent::{
    TorrentAddParams, TorrentAddResult, TorrentFileEntry, TorrentJob, TorrentListResult,
    TorrentProgress, TorrentRemoveParams, TorrentSourceKind,
};

/// Mirrors CONTRACT_VERSION in packages/contracts/src/version.ts.
/// download-core refuses to start against a mismatched main process.
pub const CONTRACT_VERSION: &str = "1.14.0";

/// Wire protocol version carried by every envelope (`v`).
pub const PROTOCOL_VERSION: i64 = 1;
