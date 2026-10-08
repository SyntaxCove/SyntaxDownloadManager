//! download-core library: JSONL RPC server + segmented resumable download engine +
//! recovery engine (source re-acquisition, multi-signal revalidation, rebind, gap-fill).

pub mod engine;
pub mod manager;
pub mod recover;
pub mod segments;
pub mod server;

pub use manager::JobManager;
