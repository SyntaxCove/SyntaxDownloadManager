//! download-core library: JSONL RPC server + resumable download engine + job manager.

pub mod engine;
pub mod manager;
pub mod server;

pub use manager::JobManager;
