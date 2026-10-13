//! Scheduler domain (Phase 15, v1.10) — mirrors packages/contracts/src/domain/scheduler.ts.
//!
//! Scheduler jobs are persistent rows in the core's SQLite database (dc-storage migration
//! v9) fired by a 1 s tick inside download-core. Wire rules as in `browser.rs`: fields
//! declared `.nullable()` in zod are ALWAYS serialized (None → null); request-side
//! `.optional()`/`.nullish()` fields are plain `Option` and omitted when None.
//! `kind`/`repeat` stay strings on the wire (closed sets enforced at the boundary), and
//! `payload` is opaque JSON — validated per kind against the target method's schema.

use crate::ids::Ulid;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A persistent scheduler job — mirrors the core's SQLite row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerJob {
    pub id: Ulid,
    /// Closed action set: download.create | download.startAll | download.pauseAll |
    /// media.download | torrent.add (validated by the manager before insert/dispatch).
    pub kind: String,
    /// Opaque action payload — the target method's params object.
    pub payload: Value,
    /// Epoch ms of the schedule anchor (first occurrence); may be in the past → catch-up.
    #[serde(rename = "startAt")]
    pub start_at: i64,
    /// none | daily | weekly (the v1 stub's enum, preserved verbatim).
    pub repeat: String,
    pub enabled: bool,
    /// Epoch ms of the next due fire; null = nothing scheduled (always serialized).
    #[serde(rename = "nextRunAt")]
    pub next_run_at: Option<i64>,
    /// Epoch ms of the most recent fire; null = never fired (always serialized).
    #[serde(rename = "lastFiredAt")]
    pub last_fired_at: Option<i64>,
    /// "ok" or a classified error code; null = never fired (always serialized).
    #[serde(rename = "lastResultCode")]
    pub last_result_code: Option<String>,
    /// Human-readable outcome detail; null = never fired (always serialized).
    #[serde(rename = "lastResultMessage")]
    pub last_result_message: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// `scheduler.create` params.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SchedulerCreateParams {
    pub kind: String,
    pub payload: Value,
    #[serde(rename = "startAt")]
    pub start_at: i64,
    pub repeat: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerCreateResult {
    pub job: SchedulerJob,
}

/// `scheduler.update` params — patch semantics; `kind` is immutable.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SchedulerUpdateParams {
    pub id: Ulid,
    pub patch: SchedulerPatch,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct SchedulerPatch {
    #[serde(rename = "startAt", default)]
    pub start_at: Option<i64>,
    #[serde(default)]
    pub repeat: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Full payload replacement when present (re-validated per kind by the core).
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerJobResult {
    pub job: SchedulerJob,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerListResult {
    pub jobs: Vec<SchedulerJob>,
}

/// `scheduler.setClock` params — main → core only (never on the renderer router).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct SchedulerSetClockParams {
    /// Local-UTC offset in minutes (e.g. 210 for UTC+03:30).
    #[serde(rename = "tzOffsetMinutes")]
    pub tz_offset_minutes: i32,
}
