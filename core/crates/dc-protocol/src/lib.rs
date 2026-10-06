//! dc-protocol — Rust mirror of `packages/contracts` (the UniDM wire contract).
//!
//! Both sides must agree byte-for-byte on the JSON shapes; shared fixtures in
//! `packages/contracts/fixtures/` are parsed by tests on both languages.

pub mod envelope;
pub mod error;
pub mod ids;
pub mod job;

pub use envelope::{
    make_error, make_event, make_request, make_success, ErrorEnvelope, EventEnvelope,
    RequestEnvelope, ResponseEnvelope, SuccessEnvelope,
};
pub use error::{ContractError, ErrorCode};
pub use ids::{new_ulid, ulid_time, Ulid, UlidError};
pub use job::DownloadJob;

/// Mirrors CONTRACT_VERSION in packages/contracts/src/version.ts.
/// download-core refuses to start against a mismatched main process.
pub const CONTRACT_VERSION: &str = "1.0.0";

/// Wire protocol version carried by every envelope (`v`).
pub const PROTOCOL_VERSION: i64 = 1;
