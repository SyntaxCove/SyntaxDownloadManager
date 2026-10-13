//! SchedulerEngine — persistent scheduler jobs + automation (Phase 15).
//!
//! Jobs are rows in the core's SQLite database (storage v9) fired by a 1 s tick, so the
//! schedule survives renderer reloads, core restarts and app shutdowns. Firing rules:
//!
//! - due = `enabled AND next_run_at <= now`; fires sequentially in `next_run_at` order —
//!   a slow probe never becomes a burst, and a catch-up burst replays in schedule order;
//! - every fire records `last_fired_at` + `last_result_code` ("ok" or a classified error
//!   code) + `last_result_message` on the row and emits `scheduler.updated`;
//! - `repeat: none` → enabled flips false, `next_run_at` becomes null (the row stays as
//!   the audit trail); repeating jobs advance to the next local-wall-clock occurrence —
//!   a failed action never kills the schedule;
//! - catch-up: rows missed while the app was closed fire at the first tick after boot
//!   (a schedule is persistent, never silently dropped); a missed repeating run collapses
//!   into ONE catch-up fire (the occurrence math skips the whole past);
//! - `runNow` fires immediately, records the outcome, and never touches the schedule;
//!   an in-flight guard makes tick-vs-runNow double-fires impossible.
//!
//! Time model: the anchor is persisted as a **wall clock** (`wall_anchor`, naive local
//! ms) alongside its epoch (`start_at`). Recurring slots advance in naive local ms —
//! exactly 24 h / 7 d of wall clock — so when main re-pushes the local-UTC offset
//! (`scheduler.setClock`, startup + every 10 min), future fires snap back to the same
//! local time after a DST/travel change. The anchor itself is always the first
//! occurrence: create (and a startAt edit) schedule it verbatim, past or future —
//! catch-up semantics; every later slot is strictly future.
//!
//! Actions are a CLOSED set dispatched through the same `JobManager` methods the IPC
//! handlers use — identical validation, identical fail-closed posture, zero new
//! privileged surface.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use dc_protocol::scheduler::SchedulerJob;
use dc_protocol::{ContractError, ErrorCode, EventEnvelope};
use dc_storage::JobStore;
use serde::Deserialize;
use serde_json::Value;

use crate::engine::{now_ms, ChecksumSpec, CreateJobParams, EventsTx};
use crate::manager::JobManager;
use crate::segments::normalize_expected;

/// How often the due query runs. One indexed SELECT per tick — negligible, and it keeps
/// worst-case fire latency at ~1 s without sleep-until-next machinery.
const SCHEDULER_TICK_SECS: u64 = 1;

const DAY_MS: i64 = 86_400_000;
const WEEK_MS: i64 = 7 * DAY_MS;

/// The closed action set (mirrors `SchedulerAction` in the contracts).
const ACTIONS: &[&str] = &[
    "download.create",
    "download.startAll",
    "download.pauseAll",
    "media.download",
    "torrent.add",
];

/// The repeat set (the v1 stub's enum, preserved verbatim).
const REPEATS: &[&str] = &["none", "daily", "weekly"];

pub fn is_valid_action(kind: &str) -> bool {
    ACTIONS.contains(&kind)
}

pub fn is_valid_repeat(repeat: &str) -> bool {
    REPEATS.contains(&repeat)
}

pub fn invalid_field(field: &str, value: &str) -> ContractError {
    ContractError::new(
        ErrorCode::InvalidParams,
        format!("invalid scheduler {field}: {value}"),
    )
}

/// epoch ms → naive local ms under a local-UTC offset in minutes.
pub fn epoch_to_wall(epoch_ms: i64, tz_offset_minutes: i32) -> i64 {
    epoch_ms + (tz_offset_minutes as i64) * 60_000
}

/// naive local ms → epoch ms under a local-UTC offset in minutes.
pub fn wall_to_epoch(wall_ms: i64, tz_offset_minutes: i32) -> i64 {
    wall_ms - (tz_offset_minutes as i64) * 60_000
}

/// First repeating slot strictly after `now_wall`, in naive local ms.
///
/// `repeat: none` has exactly one occurrence (the anchor). Future anchors fire at the
/// anchor itself; a missed past collapses into ONE strictly-future slot (k =
/// floor(elapsed/step) + 1), so catch-up never replays every missed day.
pub fn next_occurrence_wall(wall_anchor: i64, repeat: &str, now_wall: i64) -> Option<i64> {
    match repeat {
        "none" => Some(wall_anchor),
        "daily" | "weekly" => {
            let step_ms: i64 = if repeat == "daily" { DAY_MS } else { WEEK_MS };
            if now_wall < wall_anchor {
                return Some(wall_anchor);
            }
            let k = (now_wall - wall_anchor) / step_ms + 1;
            Some(wall_anchor + k * step_ms)
        }
        _ => None,
    }
}

// ---- action payloads (mirror the target methods' param schemas) ----

#[derive(Debug, Deserialize)]
pub struct ChecksumPayload {
    pub algorithm: dc_protocol::ChecksumAlgorithm,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateDownloadPayload {
    pub url: String,
    #[serde(rename = "destinationDir")]
    pub destination_dir: String,
    pub filename: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub checksum: Option<ChecksumPayload>,
    #[serde(rename = "proxyProfileId", default)]
    pub proxy_profile_id: Option<String>,
}

/// `startAll` / `pauseAll` carry no payload; unexpected keys are rejected (honesty —
/// the zod side uses a strict empty object too).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyPayload {}

fn parse_payload<T: for<'de> Deserialize<'de>>(payload: &Value) -> Result<T, ContractError> {
    serde_json::from_value(payload.clone())
        .map_err(|e| ContractError::new(ErrorCode::InvalidParams, format!("invalid payload: {e}")))
}

/// Validate a payload against its kind WITHOUT dispatching (create/update boundary).
pub fn validate_payload(kind: &str, payload: &Value) -> Result<(), ContractError> {
    match kind {
        "download.create" => parse_payload::<CreateDownloadPayload>(payload).map(|_| ()),
        "download.startAll" | "download.pauseAll" => {
            parse_payload::<EmptyPayload>(payload).map(|_| ())
        }
        "media.download" => parse_payload::<dc_protocol::MediaDownloadParams>(payload).map(|_| ()),
        "torrent.add" => parse_payload::<dc_protocol::TorrentAddParams>(payload).map(|_| ()),
        other => Err(invalid_field("action", other)),
    }
}

/// Dispatch one action through the same manager paths the IPC handlers use.
/// Returns the ok-message or a classified error (never panics on bad input).
async fn dispatch_action(
    manager: &Arc<JobManager>,
    kind: &str,
    payload: &Value,
) -> Result<String, ContractError> {
    match kind {
        "download.create" => {
            let p = parse_payload::<CreateDownloadPayload>(payload)?;
            if !p.url.starts_with("http://") && !p.url.starts_with("https://") {
                return Err(ContractError::new(
                    ErrorCode::UrlInvalid,
                    "only http(s) URLs are supported",
                ));
            }
            let checksum = match p.checksum {
                Some(c) => Some(ChecksumSpec {
                    algorithm: c.algorithm,
                    value: normalize_expected(c.algorithm, &c.value)
                        .map_err(|msg| ContractError::new(ErrorCode::InvalidParams, msg))?,
                }),
                None => None,
            };
            let job = manager
                .create(CreateJobParams {
                    url: p.url,
                    destination_dir: p.destination_dir,
                    filename: p.filename,
                    overwrite: p.overwrite,
                    headers: p.headers,
                    checksum,
                    proxy_profile_id: p.proxy_profile_id,
                })
                .await?;
            Ok(format!("created download job {}", job.id))
        }
        "download.startAll" => {
            parse_payload::<EmptyPayload>(payload)?;
            let started = manager.start_all().await?;
            Ok(format!("started {started} paused job(s)"))
        }
        "download.pauseAll" => {
            parse_payload::<EmptyPayload>(payload)?;
            let paused = manager.pause_all().await?;
            Ok(format!("paused {paused} active job(s)"))
        }
        "media.download" => {
            let p = parse_payload::<dc_protocol::MediaDownloadParams>(payload)?;
            let job = manager.media_download(p).await?;
            Ok(format!("created media job {}", job.id))
        }
        "torrent.add" => {
            let p = parse_payload::<dc_protocol::TorrentAddParams>(payload)?;
            let job = manager.torrent_add(p).await?;
            Ok(format!("created torrent job {}", job.id))
        }
        other => Err(invalid_field("action", other)),
    }
}

/// Removes the job from the in-flight set on drop — panic/early-return safe.
struct FiringGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    id: String,
}

impl Drop for FiringGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.id);
        }
    }
}

/// How this fire affects the schedule: a scheduled fire advances (or terminates) it;
/// a manual fire (`runNow`) records the outcome and leaves the schedule untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FireMode {
    Scheduled,
    Manual,
}

pub struct SchedulerEngine {
    store: Arc<JobStore>,
    events: EventsTx,
    /// Local-UTC offset minutes, pushed by main (`scheduler.setClock`).
    tz_offset_minutes: Mutex<i32>,
    /// Job ids currently firing (tick vs runNow double-fire guard).
    firing: Mutex<HashSet<String>>,
}

impl SchedulerEngine {
    pub fn new(store: Arc<JobStore>, events: EventsTx) -> Self {
        Self {
            store,
            events,
            tz_offset_minutes: Mutex::new(0),
            firing: Mutex::new(HashSet::new()),
        }
    }

    /// Spawn the 1 s due-check loop; dies with the manager (weak refs).
    pub fn spawn_tick(self: &Arc<Self>, manager: Weak<JobManager>) {
        let engine = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(SCHEDULER_TICK_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let (Some(engine), Some(manager)) = (engine.upgrade(), manager.upgrade()) else {
                    break;
                };
                engine.fire_due(&manager).await;
            }
        });
    }

    pub fn tz_offset(&self) -> i32 {
        *self.tz_offset_minutes.lock().expect("tz mutex poisoned")
    }

    /// `scheduler.setClock`: store the offset, then recompute `next_run_at` for every
    /// enabled repeating job from its persisted wall anchor — a DST/travel change snaps
    /// future fires back to the same local time. Returns how many rows moved.
    pub fn set_clock(&self, tz_offset_minutes: i32) -> Result<usize, ContractError> {
        let tz = tz_offset_minutes.clamp(-840, 840);
        *self.tz_offset_minutes.lock().expect("tz mutex poisoned") = tz;
        let now = now_ms();
        let now_wall = epoch_to_wall(now, tz);
        let mut changed = 0usize;
        for mut row in self.store.list_scheduler_jobs()? {
            if !row.enabled || row.repeat == "none" {
                continue;
            }
            // A currently-due row is catch-up pending — the fire itself advances it;
            // recomputing here would push its missed slot into the future and silently
            // skip the run (setClock runs before the first post-boot tick).
            if row.next_run_at.is_some_and(|t| t <= now) {
                continue;
            }
            let next_wall = next_occurrence_wall(row.wall_anchor, &row.repeat, now_wall);
            let next = next_wall.map(|w| wall_to_epoch(w, tz));
            if next != row.next_run_at {
                row.next_run_at = next;
                row.updated_at = now;
                self.store.update_scheduler_job(&row)?;
                self.emit(&row.to_wire());
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Fire every due job sequentially; per-row failures were recorded on the rows.
    pub async fn fire_due(self: &Arc<Self>, manager: &Arc<JobManager>) -> usize {
        let now = now_ms();
        let due = match self.store.list_due_scheduler_jobs(now) {
            Ok(due) => due,
            Err(_) => return 0,
        };
        let mut fired = 0usize;
        for row in due {
            {
                let firing = self.firing.lock().expect("firing mutex poisoned");
                if firing.contains(row.id.as_str()) {
                    continue; // a runNow is mid-flight for this row; it records the outcome
                }
            }
            if self
                .fire_job(manager, row.id.as_str(), FireMode::Scheduled)
                .await
                .is_ok()
            {
                fired += 1;
            }
        }
        fired
    }

    /// Fire one job (due-fire or runNow). The outcome — ok or a classified error — is
    /// always recorded on the row and emitted; Err is reserved for operational failures
    /// (unknown row, already firing, storage).
    pub async fn fire_job(
        self: &Arc<Self>,
        manager: &Arc<JobManager>,
        id: &str,
        mode: FireMode,
    ) -> Result<SchedulerJob, ContractError> {
        if !self
            .firing
            .lock()
            .expect("firing mutex poisoned")
            .insert(id.to_string())
        {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "scheduler job is already firing",
            ));
        }
        let _guard = FiringGuard {
            set: &self.firing,
            id: id.to_string(),
        };

        let mut row = self.store.get_scheduler_job(id)?.ok_or_else(|| {
            ContractError::new(ErrorCode::InvalidState, "scheduler job not found")
        })?;

        let now = now_ms();
        let (code, message) = match dispatch_action(manager, &row.kind, &row.payload).await {
            Ok(message) => ("ok".to_string(), message),
            Err(err) => (err.code.as_str().to_string(), err.message),
        };
        row.last_fired_at = Some(now);
        row.last_result_code = Some(code);
        row.last_result_message = Some(message);

        if mode == FireMode::Scheduled {
            if row.repeat == "none" {
                row.enabled = false;
                row.next_run_at = None;
            } else {
                let tz = self.tz_offset();
                row.next_run_at =
                    next_occurrence_wall(row.wall_anchor, &row.repeat, epoch_to_wall(now, tz))
                        .map(|w| wall_to_epoch(w, tz));
            }
        }
        row.updated_at = now_ms();
        self.store.update_scheduler_job(&row)?;
        let wire = row.to_wire();
        self.emit(&wire);
        Ok(wire)
    }

    /// `scheduler.runNow`: existence check up front for a clean not-found, then a manual
    /// fire (outcome recorded, schedule untouched).
    pub async fn run_now(
        self: &Arc<Self>,
        manager: &Arc<JobManager>,
        id: &str,
    ) -> Result<SchedulerJob, ContractError> {
        if self.store.get_scheduler_job(id)?.is_none() {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "scheduler job not found",
            ));
        }
        self.fire_job(manager, id, FireMode::Manual).await
    }

    pub fn emit(&self, job: &SchedulerJob) {
        let _ = self.events.send(EventEnvelope {
            v: dc_protocol::PROTOCOL_VERSION,
            event: "scheduler.updated".into(),
            payload: Some(serde_json::json!({ "job": job })),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TZ: i32 = 210; // UTC+03:30
    const HOUR_MS: i64 = 3_600_000;

    #[test]
    fn none_repeat_has_exactly_the_anchor_occurrence() {
        assert_eq!(next_occurrence_wall(1000, "none", 500), Some(1000));
        assert_eq!(next_occurrence_wall(1000, "none", 5000), Some(1000));
    }

    #[test]
    fn future_anchor_fires_at_the_anchor_itself() {
        assert_eq!(next_occurrence_wall(10_000, "daily", 9_999), Some(10_000));
        assert_eq!(next_occurrence_wall(10_000, "weekly", 1), Some(10_000));
    }

    #[test]
    fn daily_advances_one_wall_clock_day() {
        // Anchor at local 09:00 (wall 09:00 naive ms-of-era); "now" is 2h later.
        let anchor_wall = 1_700_000_000_000i64;
        let now_wall = anchor_wall + 2 * HOUR_MS;
        let next = next_occurrence_wall(anchor_wall, "daily", now_wall).unwrap();
        assert_eq!(
            next - anchor_wall,
            DAY_MS,
            "a wall-clock day is exactly 24h"
        );
        assert!(next > now_wall, "strictly after now");
    }

    #[test]
    fn missed_days_collapse_into_one_catch_up_slot() {
        let anchor_wall = 1_700_000_000_000i64;
        let now_wall = anchor_wall + 3 * DAY_MS + 1; // three whole days missed
        let next = next_occurrence_wall(anchor_wall, "daily", now_wall).unwrap();
        assert_eq!(next, anchor_wall + 4 * DAY_MS, "k = floor(elapsed/step)+1");
        assert!(next > now_wall);
    }

    #[test]
    fn weekly_keeps_the_weekday_wall_clock() {
        let anchor_wall = 1_700_000_000_000i64;
        let next = next_occurrence_wall(anchor_wall, "weekly", anchor_wall + DAY_MS).unwrap();
        assert_eq!(next - anchor_wall, 7 * DAY_MS);
    }

    #[test]
    fn a_tz_change_snaps_future_fires_to_the_same_local_time() {
        // The same wall anchor observed under UTC+3:30 and UTC+0: the wall-clock slot is
        // identical; only the epoch moves by the offset delta.
        let now = 1_700_000_000_000i64;
        let anchor_wall = epoch_to_wall(now, 0); // anchor just fired (k=1 → +1 wall day)
        let next_tehran = wall_to_epoch(
            next_occurrence_wall(anchor_wall, "daily", epoch_to_wall(now, TZ)).unwrap(),
            TZ,
        );
        let next_utc = wall_to_epoch(
            next_occurrence_wall(anchor_wall, "daily", epoch_to_wall(now, 0)).unwrap(),
            0,
        );
        assert_eq!(next_utc - next_tehran, (TZ as i64) * 60_000);
        // Both sit exactly one wall day after the anchor's wall time (same local time).
        assert_eq!(next_tehran + (TZ as i64) * 60_000 - anchor_wall, DAY_MS);
        assert_eq!(next_utc - anchor_wall, DAY_MS);
    }

    #[test]
    fn wall_epoch_conversions_round_trip() {
        for tz in [-720, -210, 0, 210, 840] {
            let epoch = 1_700_000_000_123i64;
            assert_eq!(wall_to_epoch(epoch_to_wall(epoch, tz), tz), epoch);
        }
    }

    #[test]
    fn invalid_repeat_is_none() {
        assert_eq!(next_occurrence_wall(1, "monthly", 0), None);
    }

    #[test]
    fn payload_validation_rejects_wrong_shapes_per_kind() {
        let good = serde_json::json!({
            "url": "https://example.com/x",
            "destinationDir": "/tmp"
        });
        assert!(validate_payload("download.create", &good).is_ok());
        assert!(
            validate_payload("download.create", &serde_json::json!({"url": "https://x/"})).is_err()
        );
        assert!(validate_payload("download.startAll", &serde_json::json!({})).is_ok());
        assert!(validate_payload("download.startAll", &serde_json::json!({"x": 1})).is_err());
        assert!(validate_payload(
            "torrent.add",
            &serde_json::json!({"magnetUri": "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", "destinationDir": "/tmp"})
        )
        .is_ok());
        assert!(validate_payload("unknown", &serde_json::json!({})).is_err());
    }
}
