//! download-core library: JSONL RPC server + segmented resumable download engine + job manager.

pub mod engine;
pub mod manager;
pub mod segments;
pub mod server;

pub use manager::JobManager;
