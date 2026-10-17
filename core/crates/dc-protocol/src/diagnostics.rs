//! Diagnostics domain (Phase 20, v1.14) — the core-reported health snapshot.
//!
//! Rust mirror of `packages/contracts/src/domain/diagnostics.ts`; the cross-language
//! fixture `diagnosticsCoreHealth` (packages/contracts/fixtures/domain.json) must parse
//! and round-trip byte-for-byte on both sides.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Row counts across the persistent domains other than download jobs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreHealthCounts {
    pub media_jobs: i64,
    pub torrent_jobs: i64,
    pub history_entries: i64,
    pub bookmarks: i64,
    pub scheduler_jobs: i64,
}

/// The full core health snapshot — the `health` field of the `diagnostics.health` result.
///
/// `jobs_by_status` is a `BTreeMap` on purpose: deterministic key order on the wire, so
/// the TS fixture round-trip comparison is stable across runs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreHealthSnapshot {
    /// First row of `PRAGMA quick_check` — "ok" or a bounded problem list (≤500 chars).
    pub db_quick_check: String,
    pub db_page_count: i64,
    pub db_page_size: i64,
    pub jobs_by_status: BTreeMap<String, i64>,
    pub counts: CoreHealthCounts,
    /// Core process uptime in milliseconds.
    pub uptime_ms: u64,
    pub contract_version: String,
    pub protocol_version: i64,
}
