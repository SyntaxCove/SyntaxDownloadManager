//! download-core library: JSONL RPC server + segmented resumable download engine +
//! recovery engine (source re-acquisition, multi-signal revalidation, rebind, gap-fill) +
//! queue/scheduler policy and token-bucket bandwidth limiting (Phase 8) + media inspector
//! running the bundled yt-dlp (Phase 11).

pub mod engine;
pub mod manager;
pub mod media;
pub mod media_job;
pub mod proxy;
pub mod rate_limit;
pub mod recover;
pub mod segments;
pub mod server;
pub mod toolkit;
pub mod torrent_manager;

pub use manager::JobManager;
