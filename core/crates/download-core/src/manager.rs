//! JobManager — owns the engine, per-job tasks, the queue and the operating policy.
//!
//! Queue (Phase 8): queued jobs carry a persisted `queue_position`; the pump starts them
//! in position order (ties broken by creation time) while free slots exist. User-initiated
//! paths (resume/retry/recover/replaceUrl/startAll) re-enqueue at the END of the queue and
//! mark the run as **manual**. Reorder (`queue_move`) only touches queued jobs.
//!
//! Scheduler policy: `auto_start_new` parks freshly created jobs as `paused`; an optional
//! daily local-time window gates auto-started runs — on window close the queue pauses
//! **auto-started runs only** (explicit user intent is never interrupted); on window open
//! the pump resumes. Manual runs, once stopped by the user or terminal, stay put.
//!
//! Bandwidth: a global token bucket (settings `speedLimitKBps`) and per-job buckets
//! (`download.setSpeedLimit`) live in the engine; the manager only forwards the values.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dc_protocol::job::DownloadJob;
use dc_protocol::scheduler::SchedulerJob;
use dc_protocol::{ContractError, ErrorCode, CONTRACT_VERSION, PROTOCOL_VERSION};
use dc_storage::JobStore;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::{now_ms, CreateJobParams, Engine, EventsTx, JobCommand};
use crate::media_job::MediaJobManager;
use crate::proxy::{ProxyMap, RuntimeProxy};
use crate::scheduler::SchedulerEngine;
use crate::toolkit::ToolkitMap;
use crate::torrent_manager::TorrentManager;

/// How often the queue re-evaluates the schedule window (transition detection).
const POLICY_TICK_SECS: u64 = 30;

/// Max simultaneous media inspections (Phase 11) — yt-dlp is process-per-inspect.
/// Mirrors the engine's own constant; the semaphore is created once here and shared.
const MAX_CONCURRENT_INSPECTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleMode {
    Always,
    Window,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueDirection {
    Top,
    Up,
    Down,
    Bottom,
}

/// Engine operating policy delivered by main (`download.setPolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueuePolicy {
    pub auto_start_new: bool,
    pub schedule_mode: ScheduleMode,
    /// Local minutes-of-day window bounds (0..=1439); equal bounds mean the whole day.
    pub window_start_minute: u32,
    pub window_end_minute: u32,
    /// Local-UTC offset in minutes used to evaluate the window.
    pub tz_offset_minutes: i32,
}

impl Default for QueuePolicy {
    fn default() -> Self {
        Self {
            auto_start_new: true,
            schedule_mode: ScheduleMode::Always,
            window_start_minute: 0,
            window_end_minute: 0,
            tz_offset_minutes: 0,
        }
    }
}

/// `download.setPolicy` wire shape (camelCase, mirrors the zod schema).
#[derive(Debug, Deserialize)]
pub struct SetPolicyParams {
    #[serde(rename = "autoStartNew")]
    pub auto_start_new: bool,
    #[serde(rename = "scheduleMode")]
    pub schedule_mode: String,
    #[serde(rename = "windowStartMinute")]
    pub window_start_minute: u32,
    #[serde(rename = "windowEndMinute")]
    pub window_end_minute: u32,
    #[serde(rename = "speedLimitKBps")]
    pub speed_limit_kbps: u64,
    #[serde(rename = "tzOffsetMinutes")]
    pub tz_offset_minutes: i32,
}

struct JobHandle {
    cmd_tx: mpsc::Sender<JobCommand>,
    stop: CancellationToken,
    /// Started by the user (resume/retry/recover/replaceUrl/startAll) — exempt from
    /// schedule-window pauses.
    manual: bool,
}

pub struct JobManager {
    store: Arc<JobStore>,
    engine: Arc<Engine>,
    /// Phase 12: the persistent media download & merge pipeline (its own lifecycle).
    media: Arc<MediaJobManager>,
    /// Phase 13: the native torrent engine (its own lifecycle).
    torrent: Arc<TorrentManager>,
    /// Phase 15: the persistent scheduler (its own 1 s tick; fires through this manager).
    scheduler: Arc<SchedulerEngine>,
    jobs: Mutex<HashMap<String, JobHandle>>,
    max_concurrent: AtomicUsize,
    policy: Mutex<QueuePolicy>,
    /// Jobs whose next run was explicitly started by the user (consumed by the pump).
    manual_ids: Mutex<HashSet<String>>,
    /// Last observed in-window state (transition detection). Initialized to `true` so
    /// the first tick ESTABLISHES the baseline instead of acting: queued jobs are never
    /// implicitly started by core startup — they start on user action or a real
    /// window-open transition (false→true) later on.
    last_in_window: AtomicBool,
    /// Process start time (Phase 20): reported by `diagnostics.health` as `uptimeMs`.
    started_at: std::time::Instant,
}

/// Is `minute` inside the daily `[start, end)` window? Wrap-over windows (start > end)
/// span midnight; equal bounds mean the whole day.
pub fn in_window_minute(minute: u32, start: u32, end: u32) -> bool {
    if start == end {
        return true;
    }
    if start < end {
        minute >= start && minute < end
    } else {
        minute >= start || minute < end
    }
}

/// Current local minute-of-day for a local-UTC offset in minutes.
pub fn local_minute_of_day(tz_offset_minutes: i32) -> u32 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    ((now / 60 + tz_offset_minutes as i64).rem_euclid(1440)) as u32
}

impl JobManager {
    pub fn new(store: Arc<JobStore>, events: EventsTx) -> Arc<Self> {
        // Shared runtime maps + inspect budget: the HTTP engine and the media pipeline
        // both resolve tools/proxies fail-closed through the same single source of truth.
        let toolkit = Arc::new(ToolkitMap::new());
        let proxies = Arc::new(ProxyMap::new());
        let inspect_limiter = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_INSPECTS));
        let engine = Arc::new(Engine::new(
            store.clone(),
            events.clone(),
            toolkit.clone(),
            proxies.clone(),
            inspect_limiter.clone(),
        ));
        let media = MediaJobManager::new(
            store.clone(),
            events.clone(),
            toolkit,
            proxies.clone(),
            inspect_limiter,
        );
        let torrent = TorrentManager::new(store.clone(), events.clone(), proxies);
        let scheduler = Arc::new(SchedulerEngine::new(store.clone(), events));
        let manager = Arc::new(Self {
            store,
            engine,
            media,
            torrent,
            scheduler,
            jobs: Mutex::new(HashMap::new()),
            max_concurrent: AtomicUsize::new(3),
            policy: Mutex::new(QueuePolicy::default()),
            manual_ids: Mutex::new(HashSet::new()),
            last_in_window: AtomicBool::new(true),
            started_at: std::time::Instant::now(),
        });
        manager.spawn_policy_tick();
        manager.scheduler.spawn_tick(Arc::downgrade(&manager));
        manager
    }

    pub fn set_max_concurrent(self: &Arc<Self>, max: usize) {
        self.max_concurrent.store(max, Ordering::SeqCst);
        self.pump();
    }

    /// Connections per download (Phase 6): affects newly planned runs.
    pub fn set_max_connections(self: &Arc<Self>, max: usize) {
        self.engine.set_max_connections(max);
    }

    /// Phase 8: apply the operating policy (queue + schedule + global bandwidth).
    /// Evaluates the window immediately so the effect is not delayed by up to one tick.
    pub async fn set_policy(self: &Arc<Self>, params: SetPolicyParams) {
        let schedule_mode = match params.schedule_mode.as_str() {
            "window" => ScheduleMode::Window,
            _ => ScheduleMode::Always,
        };
        *self.policy.lock().expect("policy mutex poisoned") = QueuePolicy {
            auto_start_new: params.auto_start_new,
            schedule_mode,
            window_start_minute: params.window_start_minute.min(1439),
            window_end_minute: params.window_end_minute.min(1439),
            tz_offset_minutes: params.tz_offset_minutes.clamp(-840, 840),
        };
        self.engine.set_global_speed_kbps(params.speed_limit_kbps);
        self.evaluate_schedule().await;
    }

    /// Phase 8: per-job bandwidth cap — persists on the row and applies live.
    pub fn set_speed_limit(
        self: &Arc<Self>,
        id: &str,
        kbps: u64,
    ) -> Result<DownloadJob, ContractError> {
        let mut job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        job.speed_limit_kbps = if kbps == 0 { None } else { Some(kbps) };
        job.updated_at = now_ms();
        self.store.update_job(&job)?;
        self.engine.set_job_speed_kbps(id, kbps);
        self.engine.emit_job(&job);
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Phase 9: full replace of the runtime proxy map (main is the source of truth;
    /// credentials live in memory only and are never persisted by the core).
    pub fn set_runtime_proxies(&self, profiles: Vec<RuntimeProxy>) {
        self.engine.set_runtime_proxies(profiles);
    }

    /// Phase 10: full replace of the toolkit path map (main pushes only verified tools).
    pub fn set_toolkit_paths(
        &self,
        tools: Vec<dc_protocol::ToolkitPathEntry>,
    ) -> Result<(), ContractError> {
        self.engine.set_toolkit_paths(tools)
    }

    /// Phase 11: media inspection through the bundled yt-dlp (engine owns the semaphore,
    /// the fail-closed tool resolution and the JSON normalization).
    pub async fn inspect_media(
        &self,
        params: dc_protocol::MediaInspectParams,
    ) -> Result<dc_protocol::MediaInspectResult, ContractError> {
        self.engine.inspect_media(params).await
    }

    // ---- Phase 12: persistent media download & merge pipeline ----

    pub async fn media_download(
        self: &Arc<Self>,
        params: dc_protocol::MediaDownloadParams,
    ) -> Result<dc_protocol::MediaJob, ContractError> {
        self.media.create(params).await
    }

    pub fn media_list(&self) -> Result<Vec<dc_protocol::MediaJob>, ContractError> {
        self.media.list()
    }

    pub fn media_get(&self, id: &str) -> Result<Option<dc_protocol::MediaJob>, ContractError> {
        self.media.get(id)
    }

    pub async fn media_pause(&self, id: &str) -> Result<dc_protocol::MediaJob, ContractError> {
        self.media.pause(id).await
    }

    pub async fn media_resume(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<dc_protocol::MediaJob, ContractError> {
        self.media.resume(id).await
    }

    pub async fn media_cancel(&self, id: &str) -> Result<dc_protocol::MediaJob, ContractError> {
        self.media.cancel(id).await
    }

    pub async fn media_remove(
        self: &Arc<Self>,
        id: &str,
        delete_files: bool,
    ) -> Result<(), ContractError> {
        self.media.remove(id, delete_files).await
    }

    // ---- Phase 13: native torrent engine ----

    /// Bind the torrent peer listener (once; the port is announced to trackers/DHT).
    pub async fn bind_torrents(&self) -> Result<u16, ContractError> {
        self.torrent.bind().await
    }

    pub async fn torrent_add(
        self: &Arc<Self>,
        params: dc_protocol::TorrentAddParams,
    ) -> Result<dc_protocol::TorrentJob, ContractError> {
        self.torrent.add(params).await
    }

    pub fn torrent_list(&self) -> Result<Vec<dc_protocol::TorrentJob>, ContractError> {
        self.torrent.list()
    }

    pub fn torrent_get(&self, id: &str) -> Result<Option<dc_protocol::TorrentJob>, ContractError> {
        self.torrent.get(id)
    }

    pub async fn torrent_pause(&self, id: &str) -> Result<dc_protocol::TorrentJob, ContractError> {
        self.torrent.pause(id).await
    }

    pub async fn torrent_resume(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<dc_protocol::TorrentJob, ContractError> {
        self.torrent.resume(id).await
    }

    pub async fn torrent_cancel(&self, id: &str) -> Result<dc_protocol::TorrentJob, ContractError> {
        self.torrent.cancel(id).await
    }

    pub async fn torrent_remove(
        self: &Arc<Self>,
        id: &str,
        delete_files: bool,
    ) -> Result<(), ContractError> {
        self.torrent.remove(id, delete_files).await
    }

    // ---- Phase 14: browser history + bookmarks (persisted in the same database) ----

    /// Record one settled main-frame visit. The core re-validates the scheme (defense in
    /// depth — main already filters) and stamps the row with its own clock when main
    /// omitted `visitedAt`.
    pub fn history_record(
        &self,
        params: dc_protocol::HistoryRecordParams,
    ) -> Result<(), ContractError> {
        ensure_web_url(&params.url)?;
        let entry = dc_protocol::HistoryEntry {
            id: dc_protocol::new_ulid(),
            url: params.url,
            title: params.title,
            favicon_url: params.favicon_url,
            visited_at: params.visited_at.unwrap_or_else(now_ms),
        };
        self.store.insert_history_entry(&entry)
    }

    pub fn history_list(
        &self,
        params: dc_protocol::HistoryListParams,
    ) -> Result<Vec<dc_protocol::HistoryEntry>, ContractError> {
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let offset = params.offset.unwrap_or(0);
        self.store
            .list_history(params.query.as_deref(), limit, offset)
    }

    pub fn history_delete(&self, id: &str) -> Result<(), ContractError> {
        if !self.store.delete_history_entry(id)? {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "history entry not found",
            ));
        }
        Ok(())
    }

    pub fn history_clear(&self, before: Option<i64>) -> Result<usize, ContractError> {
        self.store.clear_history(before)
    }

    pub fn bookmark_create(
        &self,
        params: dc_protocol::BookmarkCreateParams,
    ) -> Result<dc_protocol::Bookmark, ContractError> {
        ensure_web_url(&params.url)?;
        let now = now_ms();
        let bookmark = dc_protocol::Bookmark {
            id: dc_protocol::new_ulid(),
            url: params.url,
            title: params.title,
            position: 0, // assigned by the store (max+1, same transaction)
            created_at: now,
            updated_at: now,
        };
        self.store.insert_bookmark(&bookmark)
    }

    pub fn bookmark_list(&self) -> Result<Vec<dc_protocol::Bookmark>, ContractError> {
        self.store.list_bookmarks()
    }

    pub fn bookmark_get_by_url(
        &self,
        url: &str,
    ) -> Result<Option<dc_protocol::Bookmark>, ContractError> {
        self.store.get_bookmark_by_url(url)
    }

    pub fn bookmark_update(
        &self,
        params: dc_protocol::BookmarkUpdateParams,
    ) -> Result<dc_protocol::Bookmark, ContractError> {
        if let Some(url) = &params.url {
            ensure_web_url(url)?;
        }
        self.store.update_bookmark(
            params.id.as_str(),
            params.title.as_deref(),
            params.url.as_deref(),
        )
    }

    pub fn bookmark_remove(&self, id: &str) -> Result<(), ContractError> {
        if !self.store.delete_bookmark(id)? {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "bookmark not found",
            ));
        }
        Ok(())
    }

    // ---- Phase 15: scheduler jobs + automation ----

    pub fn scheduler_list(&self) -> Result<Vec<SchedulerJob>, ContractError> {
        Ok(self
            .store
            .list_scheduler_jobs()?
            .iter()
            .map(dc_storage::SchedulerJobRow::to_wire)
            .collect())
    }

    /// Create + persist a scheduler job. The anchor is always the first occurrence:
    /// `next_run_at = start_at` (past anchors catch up at the next tick — documented).
    pub fn scheduler_create(
        &self,
        params: dc_protocol::SchedulerCreateParams,
    ) -> Result<SchedulerJob, ContractError> {
        if !crate::scheduler::is_valid_action(&params.kind) {
            return Err(crate::scheduler::invalid_field("action", &params.kind));
        }
        if !crate::scheduler::is_valid_repeat(&params.repeat) {
            return Err(crate::scheduler::invalid_field("repeat", &params.repeat));
        }
        if params.start_at < 0 {
            return Err(ContractError::new(
                ErrorCode::InvalidParams,
                "startAt must be a non-negative epoch ms",
            ));
        }
        crate::scheduler::validate_payload(&params.kind, &params.payload)?;
        let now = now_ms();
        let tz = self.scheduler.tz_offset();
        let row = dc_storage::SchedulerJobRow {
            id: dc_protocol::new_ulid(),
            kind: params.kind,
            payload: params.payload,
            start_at: params.start_at,
            wall_anchor: crate::scheduler::epoch_to_wall(params.start_at, tz),
            repeat: params.repeat,
            enabled: params.enabled,
            next_run_at: if params.enabled {
                Some(params.start_at)
            } else {
                None
            },
            last_fired_at: None,
            last_result_code: None,
            last_result_message: None,
            created_at: now,
            updated_at: now,
        };
        self.store.insert_scheduler_job(&row)?;
        let wire = row.to_wire();
        self.scheduler.emit(&wire);
        Ok(wire)
    }

    /// Patch a scheduler row. `kind` is immutable; a replacement payload is re-validated
    /// against the row's kind; startAt/repeat/enabled changes re-derive `next_run_at`
    /// (a new anchor is honored verbatim; repeat switches and re-enables skip the past).
    pub fn scheduler_update(
        &self,
        params: dc_protocol::SchedulerUpdateParams,
    ) -> Result<SchedulerJob, ContractError> {
        let mut row = self
            .store
            .get_scheduler_job(params.id.as_str())?
            .ok_or_else(|| {
                ContractError::new(ErrorCode::InvalidState, "scheduler job not found")
            })?;
        let patch = params.patch;
        // Validate everything before mutating anything.
        if let Some(repeat) = &patch.repeat {
            if !crate::scheduler::is_valid_repeat(repeat) {
                return Err(crate::scheduler::invalid_field("repeat", repeat));
            }
        }
        if let Some(start_at) = patch.start_at {
            if start_at < 0 {
                return Err(ContractError::new(
                    ErrorCode::InvalidParams,
                    "startAt must be a non-negative epoch ms",
                ));
            }
        }
        if let Some(payload) = &patch.payload {
            crate::scheduler::validate_payload(&row.kind, payload)?;
        }

        let tz = self.scheduler.tz_offset();
        let now = now_ms();
        if let Some(payload) = patch.payload {
            row.payload = payload;
        }
        if let Some(start_at) = patch.start_at {
            row.start_at = start_at;
            row.wall_anchor = crate::scheduler::epoch_to_wall(start_at, tz);
            if row.enabled {
                row.next_run_at = Some(start_at);
            }
        }
        if let Some(repeat) = patch.repeat {
            if row.repeat != repeat {
                row.repeat = repeat.clone();
                if row.enabled {
                    row.next_run_at = match repeat.as_str() {
                        "none" => Some(row.start_at),
                        r => crate::scheduler::next_occurrence_wall(
                            row.wall_anchor,
                            r,
                            crate::scheduler::epoch_to_wall(now, tz),
                        )
                        .map(|w| crate::scheduler::wall_to_epoch(w, tz)),
                    };
                }
            }
        }
        if let Some(enabled) = patch.enabled {
            if enabled && !row.enabled {
                row.enabled = true;
                row.next_run_at = match row.repeat.as_str() {
                    "none" => Some(row.start_at),
                    r => crate::scheduler::next_occurrence_wall(
                        row.wall_anchor,
                        r,
                        crate::scheduler::epoch_to_wall(now, tz),
                    )
                    .map(|w| crate::scheduler::wall_to_epoch(w, tz)),
                };
            } else if !enabled && row.enabled {
                row.enabled = false;
                // next_run_at stays; the row is inert until re-enabled (which recomputes).
            }
        }
        row.updated_at = now_ms();
        self.store.update_scheduler_job(&row)?;
        let wire = row.to_wire();
        self.scheduler.emit(&wire);
        Ok(wire)
    }

    pub fn scheduler_remove(&self, id: &str) -> Result<(), ContractError> {
        if !self.store.delete_scheduler_job(id)? {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "scheduler job not found",
            ));
        }
        Ok(())
    }

    /// `scheduler.runNow`: fire immediately; the outcome is recorded on the row, the
    /// schedule is untouched (explicit user intent).
    pub async fn scheduler_run_now(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<SchedulerJob, ContractError> {
        self.scheduler.run_now(self, id).await
    }

    /// `scheduler.setClock` (main → core): push the local-UTC offset; repeating rows
    /// re-derive next_run_at in wall clock. Returns how many rows moved.
    pub fn scheduler_set_clock(&self, tz_offset_minutes: i32) -> Result<usize, ContractError> {
        self.scheduler.set_clock(tz_offset_minutes)
    }

    /// Fire every due scheduler job now (the 1 s tick calls this; exposed so the fire
    /// pipeline is exercisable without waiting on wall-clock time in tests).
    pub async fn scheduler_fire_due(self: &Arc<Self>) -> usize {
        self.scheduler.fire_due(self).await
    }

    /// Phase 9: change the proxy profile a job routes through (None = direct).
    /// Refused while a run is active — mutating the route mid-run would splice bytes
    /// from two different network identities into one file.
    pub fn set_job_proxy(
        &self,
        id: &str,
        profile_id: Option<String>,
    ) -> Result<DownloadJob, ContractError> {
        let mut job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if matches!(job.status.as_str(), "probing" | "downloading") {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "cannot change the proxy of an active job",
            ));
        }
        job.proxy_profile_id = profile_id;
        job.updated_at = now_ms();
        self.store.update_job(&job)?;
        self.engine.emit_job(&job);
        Ok(job)
    }

    /// Phase 9 `proxy.test`: GET a probe URL through a runtime profile; returns
    /// latency + exit IP or a classified failure (never throws for network faults).
    pub async fn test_proxy(
        &self,
        profile_id: &str,
        url_override: Option<String>,
    ) -> Result<serde_json::Value, ContractError> {
        self.engine
            .test_proxy(profile_id, url_override.as_deref())
            .await
    }

    /// Phase 8: reorder a queued job within the queue (top/up/down/bottom).
    pub fn queue_move(
        self: &Arc<Self>,
        id: &str,
        direction: QueueDirection,
    ) -> Result<DownloadJob, ContractError> {
        let all = self.store.list_jobs()?;
        let mut queued: Vec<DownloadJob> =
            all.into_iter().filter(|j| j.status == "queued").collect();
        queued.sort_by_key(|j| (j.queue_position.unwrap_or(u64::MAX), j.created_at));
        let idx = queued
            .iter()
            .position(|j| j.id.as_str() == id)
            .ok_or_else(|| {
                ContractError::new(ErrorCode::InvalidState, "job is not in the queue")
            })?;
        let last = queued.len() - 1;
        let new_idx = match direction {
            QueueDirection::Top => 0,
            QueueDirection::Up => idx.saturating_sub(1),
            QueueDirection::Down => (idx + 1).min(last),
            QueueDirection::Bottom => last,
        };
        if new_idx != idx {
            let job = queued.remove(idx);
            queued.insert(new_idx, job);
            for (pos, mut job) in queued.into_iter().enumerate() {
                job.queue_position = Some(pos as u64);
                job.updated_at = now_ms();
                self.store.update_job(&job)?;
                self.engine.emit_job(&job);
            }
        }
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Phase 8: resume every `paused` job (user intent; failed/canceled keep their
    /// dedicated recover/retry semantics). Returns how many jobs were requeued.
    pub async fn start_all(self: &Arc<Self>) -> Result<usize, ContractError> {
        let all = self.store.list_jobs()?;
        let mut started = 0usize;
        for mut job in all {
            if job.status != "paused" {
                continue;
            }
            self.manual_ids
                .lock()
                .expect("manual_ids mutex poisoned")
                .insert(job.id.as_str().to_string());
            job.status = "queued".into();
            job.error_code = None;
            job.queue_position = Some(self.next_position()?);
            job.updated_at = now_ms();
            self.store.update_job(&job)?;
            self.engine.emit_job(&job);
            started += 1;
        }
        if started > 0 {
            self.pump();
        }
        Ok(started)
    }

    /// Phase 8: pause every `queued`/`probing`/`downloading` job. Returns the count.
    pub async fn pause_all(self: &Arc<Self>) -> Result<usize, ContractError> {
        let all = self.store.list_jobs()?;
        let mut paused = 0usize;
        for job in all {
            if !matches!(job.status.as_str(), "queued" | "probing" | "downloading") {
                continue;
            }
            let handle = {
                let jobs = self.jobs.lock().expect("jobs mutex poisoned");
                jobs.get(job.id.as_str()).map(|h| h.cmd_tx.clone())
            };
            match handle {
                Some(cmd_tx) => {
                    let _ = cmd_tx.send(JobCommand::Pause).await;
                }
                None => {
                    // Task not running (queued or pump-pending): flip status directly.
                    let mut job = job;
                    job.status = "paused".into();
                    job.queue_position = None;
                    job.speed_bps = None;
                    job.eta_seconds = None;
                    job.updated_at = now_ms();
                    self.store.update_job(&job)?;
                    self.engine.emit_job(&job);
                    self.manual_ids
                        .lock()
                        .expect("manual_ids mutex poisoned")
                        .remove(job.id.as_str());
                }
            }
            paused += 1;
        }
        Ok(paused)
    }

    pub async fn create(
        self: &Arc<Self>,
        params: CreateJobParams,
    ) -> Result<DownloadJob, ContractError> {
        let mut job = self.engine.create_job(params).await?;
        let auto_start = self
            .policy
            .lock()
            .expect("policy mutex poisoned")
            .auto_start_new;
        if auto_start {
            job.queue_position = Some(self.next_position()?);
        } else {
            // Queue policy: new downloads are parked until the user starts them.
            job.status = "paused".into();
        }
        job.updated_at = now_ms();
        self.store.update_job(&job)?;
        self.engine.emit_job(&job);
        if auto_start {
            self.pump();
        }
        self.store
            .get_job(job.id.as_str())?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    pub fn list(&self) -> Result<Vec<DownloadJob>, ContractError> {
        self.store.list_jobs()
    }

    pub fn get(&self, id: &str) -> Result<Option<DownloadJob>, ContractError> {
        self.store.get_job(id)
    }

    /// Phase 20: process + storage health snapshot for `diagnostics.health`. Read-only
    /// queries only — a diagnostics call must never mutate or disturb live job state.
    pub fn health_snapshot(&self) -> Result<dc_protocol::CoreHealthSnapshot, ContractError> {
        let (page_count, page_size) = self.store.db_page_stats()?;
        let jobs_by_status: std::collections::BTreeMap<String, i64> =
            self.store.count_jobs_by_status()?.into_iter().collect();
        let (media, torrents, history, bookmarks, scheduler) = self.store.health_counts()?;
        Ok(dc_protocol::CoreHealthSnapshot {
            db_quick_check: self.store.quick_check()?,
            db_page_count: page_count,
            db_page_size: page_size,
            jobs_by_status,
            counts: dc_protocol::CoreHealthCounts {
                media_jobs: media,
                torrent_jobs: torrents,
                history_entries: history,
                bookmarks,
                scheduler_jobs: scheduler,
            },
            uptime_ms: self.started_at.elapsed().as_millis() as u64,
            contract_version: CONTRACT_VERSION.to_string(),
            protocol_version: PROTOCOL_VERSION,
        })
    }

    pub async fn pause(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        self.send_command(id, JobCommand::Pause, |status| {
            matches!(status, "queued" | "probing" | "downloading")
        })
        .await
    }

    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        let mut job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if !matches!(job.status.as_str(), "paused" | "canceled" | "failed") {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot resume a job in status {}", job.status),
            ));
        }
        job.status = "queued".into();
        job.error_code = None;
        job.queue_position = Some(self.next_position()?);
        job.updated_at = now_ms();
        self.store.update_job(&job)?;
        self.engine.emit_job(&job);
        self.mark_manual(id);
        self.pump();
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Phase 7 recovery cycle: re-acquire the source, revalidate the part with multiple
    /// signals, rebind and requeue. The outcome (success or classified failure) is carried
    /// by the returned job, not by an RPC error.
    pub async fn recover(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        let mut job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if !matches!(job.status.as_str(), "paused" | "failed" | "canceled") {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot recover a job in status {}", job.status),
            ));
        }
        self.engine
            .recover(&mut job)
            .await
            .map_err(|e| e.to_contract())?;
        // Re-enqueue at the end of the queue (the engine reset the status to `queued`
        // without a position); a user-initiated recovery run is manual.
        job = self.store.get_job(id)?.unwrap_or(job);
        if job.queue_position.is_none() {
            job.queue_position = Some(self.next_position()?);
            job.updated_at = now_ms();
            self.store.update_job(&job)?;
            self.engine.emit_job(&job);
        }
        self.mark_manual(id);
        self.pump();
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Phase 7: rebind a dead/expired source to a new URL. Bytes and journal are kept;
    /// the next run revalidates and gap-fills against the new source.
    pub async fn replace_url(
        self: &Arc<Self>,
        id: &str,
        url: String,
    ) -> Result<DownloadJob, ContractError> {
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(ContractError::new(
                ErrorCode::UrlInvalid,
                "only http(s) URLs are supported",
            ));
        }
        let mut job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if !matches!(
            job.status.as_str(),
            "queued" | "paused" | "failed" | "canceled"
        ) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot replace the URL of a job in status {}", job.status),
            ));
        }
        // The row may still say `queued` while the pump has already spawned the task.
        if self
            .jobs
            .lock()
            .expect("jobs mutex poisoned")
            .contains_key(id)
        {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "job task is active",
            ));
        }
        job.url = url;
        job.status = "queued".into();
        job.error_code = None;
        job.recovery_count = Some(job.recovery_count.unwrap_or(0) + 1);
        job.rebound_at = Some(now_ms());
        job.speed_bps = None;
        job.eta_seconds = None;
        if job.queue_position.is_none() {
            job.queue_position = Some(self.next_position()?);
        }
        job.updated_at = now_ms();
        self.store.update_job(&job)?;
        self.engine.emit_job(&job);
        self.mark_manual(id);
        self.pump();
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Distinct UI verb for re-acquiring a failed/canceled/paused job; the engine re-probes
    /// on the next run and gap-fills (Phase 7 revalidation) when the source serves again.
    pub async fn retry(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        self.resume(id).await
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        self.send_command(id, JobCommand::Cancel, |status| {
            matches!(status, "queued" | "probing" | "downloading")
        })
        .await
    }

    pub async fn remove(
        self: &Arc<Self>,
        id: &str,
        delete_partial_file: bool,
    ) -> Result<(), ContractError> {
        // Read before delete so the `.part` sidecar can be located.
        let job = self.store.get_job(id)?;
        let handle = {
            let jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.get(id).map(|h| (h.cmd_tx.clone(), h.stop.clone()))
        };
        if let Some((cmd_tx, stop)) = handle {
            let _ = cmd_tx.send(JobCommand::Cancel).await;
            stop.cancel();
            // Phase 25 fix: wait for the engine task to observe the cancellation and
            // exit (it removes its own handle) BEFORE touching its files — an in-flight
            // writer must never outlive the `.part` unlink. Bounded: a wedged task must
            // not hang remove() past 5 s.
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            while self
                .jobs
                .lock()
                .expect("jobs mutex poisoned")
                .contains_key(id)
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            self.jobs.lock().expect("jobs mutex poisoned").remove(id);
        }
        if !self.store.delete_job(id)? {
            return Err(ContractError::new(ErrorCode::InvalidState, "job not found"));
        }
        if delete_partial_file {
            if let Some(job) = job {
                if let Some(path) = job.destination_path {
                    let part = PathBuf::from(format!("{path}.part"));
                    let _ = tokio::fs::remove_file(&part).await; // best effort
                }
            }
        }
        self.pump();
        Ok(())
    }

    /// Graceful shutdown: stop all tasks (each persists its final pre-shutdown state).
    pub async fn shutdown(&self) {
        let handles: Vec<(mpsc::Sender<JobCommand>, CancellationToken)> = self
            .jobs
            .lock()
            .expect("jobs mutex poisoned")
            .values()
            .map(|h| (h.cmd_tx.clone(), h.stop.clone()))
            .collect();
        for (cmd_tx, stop) in handles {
            let _ = cmd_tx.send(JobCommand::Pause).await;
            stop.cancel();
        }
        self.media.shutdown().await;
        self.torrent.shutdown().await;
    }

    async fn send_command(
        self: &Arc<Self>,
        id: &str,
        cmd: JobCommand,
        allowed: fn(&str) -> bool,
    ) -> Result<DownloadJob, ContractError> {
        let job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if !allowed(&job.status) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot {} a job in status {}", cmd_name(cmd), job.status),
            ));
        }
        let handle = {
            let jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.get(id).map(|h| (h.cmd_tx.clone(), h.stop.clone()))
        };
        match handle {
            Some((cmd_tx, _)) => {
                cmd_tx.send(cmd).await.map_err(|_| {
                    ContractError::new(ErrorCode::InternalError, "job task is not running")
                })?;
            }
            None => {
                // Task not running (e.g. queued or pump-pending): flip status directly.
                let mut job = job;
                job.status = match cmd {
                    JobCommand::Pause => "paused".to_string(),
                    JobCommand::Cancel => "canceled".to_string(),
                };
                // Leaving the queue releases the slot and the user-start marker.
                job.queue_position = None;
                job.speed_bps = None;
                job.eta_seconds = None;
                job.updated_at = now_ms();
                self.store.update_job(&job)?;
                self.engine.emit_job(&job);
                self.manual_ids
                    .lock()
                    .expect("manual_ids mutex poisoned")
                    .remove(id);
            }
        }
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Start queued jobs (in queue order) while free slots exist; prune finished tasks.
    fn pump(self: &Arc<Self>) {
        let max = self.max_concurrent.load(Ordering::SeqCst);
        let running = {
            let mut jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.retain(|_, h| !h.stop.is_cancelled());
            jobs.len()
        };
        if running >= max {
            return;
        }
        let Ok(all) = self.store.list_jobs() else {
            return;
        };
        let mut queued: Vec<DownloadJob> =
            all.into_iter().filter(|j| j.status == "queued").collect();
        queued.sort_by_key(|j| (j.queue_position.unwrap_or(u64::MAX), j.created_at));
        let mut slots = max - running;
        for job in queued {
            if slots == 0 {
                break;
            }
            let already = self
                .jobs
                .lock()
                .expect("jobs mutex poisoned")
                .contains_key(job.id.as_str());
            if !already {
                // Consuming the marker returns true when the user started this job.
                let manual = self
                    .manual_ids
                    .lock()
                    .expect("manual_ids mutex poisoned")
                    .remove(job.id.as_str());
                self.spawn_task(job, manual);
                slots -= 1;
            }
        }
    }

    /// Spawn the engine task; on completion the task removes itself and pumps the queue.
    fn spawn_task(self: &Arc<Self>, job: DownloadJob, manual: bool) {
        let id = job.id.as_str().to_string();
        let (cmd_tx, cmd_rx) = mpsc::channel::<JobCommand>(8);
        let stop = CancellationToken::new();
        let engine = self.engine.clone();
        let manager = self.clone();

        self.jobs.lock().expect("jobs mutex poisoned").insert(
            id.clone(),
            JobHandle {
                cmd_tx,
                stop: stop.clone(),
                manual,
            },
        );

        tokio::spawn(async move {
            engine.run_job(job, cmd_rx, stop).await;
            manager
                .jobs
                .lock()
                .expect("jobs mutex poisoned")
                .remove(&id);
            manager.pump();
        });
    }

    fn mark_manual(&self, id: &str) {
        self.manual_ids
            .lock()
            .expect("manual_ids mutex poisoned")
            .insert(id.to_string());
    }

    /// Next free queue slot (end of the queue).
    fn next_position(&self) -> Result<u64, ContractError> {
        let max = self
            .store
            .list_jobs()?
            .iter()
            .filter_map(|j| j.queue_position)
            .max();
        Ok(max.map_or(0, |m| m + 1))
    }

    fn spawn_policy_tick(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(POLICY_TICK_SECS));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(manager) = weak.upgrade() else { break };
                manager.evaluate_schedule().await;
            }
        });
    }

    /// Window transition detection: on outside→inside pump, on inside→outside pause the
    /// auto-started runs (manual runs are never interrupted).
    async fn evaluate_schedule(self: &Arc<Self>) {
        let now_in = self.in_window();
        let prev = self.last_in_window.swap(now_in, Ordering::SeqCst);
        if now_in && !prev {
            self.pump();
        } else if !now_in && prev {
            self.pause_auto_runs().await;
        }
    }

    fn in_window(&self) -> bool {
        let policy = *self.policy.lock().expect("policy mutex poisoned");
        match policy.schedule_mode {
            ScheduleMode::Always => true,
            ScheduleMode::Window => in_window_minute(
                local_minute_of_day(policy.tz_offset_minutes),
                policy.window_start_minute,
                policy.window_end_minute,
            ),
        }
    }

    /// Pause every running job whose run was started by the pump (not by the user).
    async fn pause_auto_runs(&self) {
        let handles: Vec<mpsc::Sender<JobCommand>> = {
            let jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.values()
                .filter(|h| !h.manual)
                .map(|h| h.cmd_tx.clone())
                .collect()
        };
        for cmd_tx in handles {
            let _ = cmd_tx.send(JobCommand::Pause).await;
        }
    }
}

fn cmd_name(cmd: JobCommand) -> &'static str {
    match cmd {
        JobCommand::Pause => "pause",
        JobCommand::Cancel => "cancel",
    }
}

/// History/bookmark URLs must be http(s) — the managed browser records nothing else and
/// the boundary rejects everything else early (mirrors the zod `protocol: /^https?$/` pin).
fn ensure_web_url(url: &str) -> Result<(), ContractError> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err(ContractError::new(
            ErrorCode::InvalidParams,
            "url must be http(s)",
        ))
    }
}
