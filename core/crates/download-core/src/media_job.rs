//! Media pipeline job manager (Phase 12) — persistent media jobs: format selection →
//! bundled yt-dlp stream downloads → bundled FFmpeg mux.
//!
//! Data-integrity and failure posture (mirrors the download engine's hierarchy):
//! - the job's persistent source is the PAGE URL; every run re-extracts fresh stream data
//!   (rebind-by-re-extraction), so an expired extractor URL never destroys the job or the
//!   bytes already on disk;
//! - yt-dlp's default `--continue` resumes `.part` files by size across runs, and streams
//!   that already completed are detected on disk and skipped ("already been downloaded"),
//!   so a pause/crash/restart costs at most the interrupted stream's tail;
//! - the final mux is written to a `.tmp-unidm` sidepath and renamed only after ffmpeg
//!   exits cleanly — a partial mux is never presented as finished;
//! - tool resolution is fail-closed through the shared `ToolkitMap` (`media_tool_missing`
//!   → paused, recoverable after the toolkit installs); proxy profiles resolve through the
//!   shared `ProxyMap` (`proxy_profile_not_found` → paused, Phase 9 semantics);
//! - live manifests are refused (`media_live_unsupported`) — recording live streams is a
//!   later-phase decision, and a silent never-completing download is not an option;
//! - a selected format that vanished from the fresh extraction is classified
//!   (`media_format_not_found`) instead of silently downloading something else;
//! - spawn is argv-array, no shell; URLs, format ids and subtitle language/extension
//!   values are validated (http(s)-only, no leading dash) before any process is spawned.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dc_protocol::media::{MediaContainer, MediaDownloadParams, MediaJob, MediaSubtitleSelection};
use dc_protocol::{new_ulid, ContractError, ErrorCode, EventEnvelope, MediaInspectParams};
use dc_storage::JobStore;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::{now_ms, EventsTx, JobCommand};
use crate::media::{self, InspectLimits};
use crate::proxy::ProxyMap;
use crate::toolkit::ToolkitMap;

/// Max concurrent media pipeline jobs — every active slot owns yt-dlp (and later ffmpeg)
/// child processes, so the cap is deliberately tighter than the HTTP download queue.
pub const MAX_CONCURRENT_MEDIA_JOBS: usize = 2;
/// Contract cap mirrored in code (the zod schema bounds the array too — belt and braces).
pub const MAX_SUBTITLE_TRACKS: usize = 8;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
/// Bounded tail of the diagnostics pipe kept for error classification.
const TAIL_CAP: usize = 16 * 1024;
/// Base name fallback when the extraction has no usable title.
const FALLBACK_BASE: &str = "media-download";

// ---------------------------------------------------------------------------
// parameter validation (pure)
// ---------------------------------------------------------------------------

/// Value may be passed as a single argv element but must never parse as a flag.
fn arg_safe(s: &str) -> bool {
    !s.starts_with('-')
}

/// Re-validate `media.download` params at the core boundary (defense in depth: the zod
/// schema validates on both TS boundaries; the core repeats the structural rules).
pub fn validate_download_params(p: &MediaDownloadParams) -> Result<(), ContractError> {
    media::validate_url(&p.url)?;
    let check_id = |id: &Option<String>, name: &str| -> Result<(), ContractError> {
        if let Some(v) = id {
            if v.trim().is_empty() || !arg_safe(v) {
                return Err(ContractError::new(
                    ErrorCode::InvalidParams,
                    format!("{name} must be a non-empty yt-dlp format id"),
                ));
            }
        }
        Ok(())
    };
    check_id(&p.video_format_id, "videoFormatId")?;
    check_id(&p.audio_format_id, "audioFormatId")?;
    if p.video_format_id.is_none() && p.audio_format_id.is_none() {
        return Err(ContractError::new(
            ErrorCode::InvalidParams,
            "select at least one of videoFormatId or audioFormatId",
        ));
    }
    if p.subtitles.len() > MAX_SUBTITLE_TRACKS {
        return Err(ContractError::new(
            ErrorCode::InvalidParams,
            format!("at most {MAX_SUBTITLE_TRACKS} subtitle tracks are supported"),
        ));
    }
    if !p.subtitles.is_empty() && p.video_format_id.is_none() {
        return Err(ContractError::new(
            ErrorCode::InvalidParams,
            "subtitles require a video format selection",
        ));
    }
    for s in &p.subtitles {
        if s.language.trim().is_empty() || s.extension.trim().is_empty() {
            return Err(ContractError::new(
                ErrorCode::InvalidParams,
                "subtitle selections need a language and an extension",
            ));
        }
        if !arg_safe(&s.language) || !arg_safe(&s.extension) {
            return Err(ContractError::new(
                ErrorCode::InvalidParams,
                "subtitle language/extension must not start with a dash",
            ));
        }
    }
    Ok(())
}

/// Drop duplicate subtitle selections, preserving order.
pub fn dedupe_subtitles(subs: Vec<MediaSubtitleSelection>) -> Vec<MediaSubtitleSelection> {
    let mut seen = std::collections::HashSet::new();
    subs.into_iter()
        .filter(|s| seen.insert((s.language.clone(), s.extension.clone(), s.is_auto_generated)))
        .collect()
}

// ---------------------------------------------------------------------------
// argv builders (pure, unit-tested)
// ---------------------------------------------------------------------------

/// yt-dlp invocation for ONE stream (`-f <id>`, private out template, machine progress).
pub fn build_ytdlp_stream_args(
    url: &str,
    format_id: &str,
    out_template: &str,
    proxy: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--ignore-config".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--newline".into(),
        "--no-mtime".into(),
        "--socket-timeout".into(),
        "20".into(),
        "--retries".into(),
        "3".into(),
        "-f".into(),
        format_id.into(),
        "-o".into(),
        out_template.into(),
        // Machine-readable progress tokens on the stderr stream (NA = unknown).
        "--progress-template".into(),
        "download:UNIDM %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s".into(),
    ];
    if let Some(endpoint) = proxy {
        args.push("--proxy".into());
        args.push(endpoint.into());
    }
    args.push(url.into());
    args
}

/// yt-dlp invocation for the subtitle fetch (single run for every selected track).
pub fn build_ytdlp_subs_args(
    url: &str,
    out_template: &str,
    subs: &[MediaSubtitleSelection],
    proxy: Option<&str>,
) -> Vec<String> {
    let mut langs: Vec<String> = Vec::new();
    let mut exts: Vec<String> = Vec::new();
    for s in subs {
        if !langs.iter().any(|l| l == &s.language) {
            langs.push(s.language.clone());
        }
        if !exts.iter().any(|e| e == &s.extension) {
            exts.push(s.extension.clone());
        }
    }
    let mut args: Vec<String> = vec![
        "--ignore-config".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--newline".into(),
        "--no-mtime".into(),
        "--skip-download".into(),
        "--write-subs".into(),
        "--write-auto-subs".into(),
        "--sub-langs".into(),
        langs.join(","),
        "--sub-format".into(),
        format!("{}/best", exts.join("/")),
        "-o".into(),
        out_template.into(),
    ];
    if let Some(endpoint) = proxy {
        args.push("--proxy".into());
        args.push(endpoint.into());
    }
    args.push(url.into());
    args
}

/// ffmpeg mux invocation: stream-copy everything (never a re-encode); subtitles convert
/// into the container's subtitle codec (`srt` for matroska, `mov_text` for mp4).
pub fn build_ffmpeg_mux_args(
    video: Option<&Path>,
    audio: Option<&Path>,
    subs: &[PathBuf],
    out: &Path,
    container: MediaContainer,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    let mut input_index = 0usize;
    let mut maps: Vec<String> = Vec::new();
    if let Some(v) = video {
        args.push("-i".into());
        args.push(v.display().to_string());
        maps.push("0:v:0".into());
        input_index += 1;
    }
    if let Some(a) = audio {
        args.push("-i".into());
        args.push(a.display().to_string());
        maps.push(format!("{input_index}:a:0"));
        input_index += 1;
    }
    for sub in subs {
        args.push("-i".into());
        args.push(sub.display().to_string());
        maps.push(format!("{input_index}:s:0"));
        input_index += 1;
    }
    for m in &maps {
        args.push("-map".into());
        args.push(m.clone());
    }
    if video.is_some() {
        args.push("-c:v".into());
        args.push("copy".into());
    }
    if audio.is_some() {
        args.push("-c:a".into());
        args.push("copy".into());
    }
    if !subs.is_empty() {
        args.push("-c:s".into());
        args.push(container.subtitle_codec().into());
    }
    args.push("-f".into());
    args.push(container.mux_format().into());
    args.push(out.display().to_string());
    args
}

// ---------------------------------------------------------------------------
// progress parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

/// Parse one `--progress-template download:UNIDM …` line:
/// `UNIDM <downloaded> <total> <estimate> <speed> <eta>` (NA = unknown). The template is
/// fixed-width: every field is always present, so the estimate slot is consumed even when
/// the exact total is known.
pub fn parse_unidm_progress(line: &str) -> Option<(u64, Option<u64>, u64, Option<u64>)> {
    let rest = line.trim().strip_prefix("UNIDM ")?;
    let mut it = rest.split_whitespace();
    let num = |t: Option<&str>| -> Option<u64> {
        let t = t?;
        if t == "NA" {
            None
        } else {
            t.parse().ok()
        }
    };
    let downloaded = num(it.next())?;
    let exact_total = num(it.next());
    let estimate = num(it.next());
    let total = exact_total.or(estimate);
    let speed = num(it.next()).unwrap_or(0);
    let eta = num(it.next());
    Some((downloaded, total, speed, eta))
}

/// Parse one ffmpeg `-progress` line: `out_time_ms=<microseconds>` (despite the name,
/// ffmpeg prints microseconds here). Returns the elapsed microseconds.
pub fn parse_ffmpeg_out_time_us(line: &str) -> Option<u64> {
    let rest = line.trim().strip_prefix("out_time_ms=")?;
    // Negative values (possible for some demuxers) carry no progress meaning.
    rest.parse::<i64>()
        .ok()
        .filter(|v| *v >= 0)
        .map(|v| v as u64)
}

// ---------------------------------------------------------------------------
// work-dir discovery (async, disk-backed)
// ---------------------------------------------------------------------------

/// The completed stream file for `label` (e.g. `video.mp4`) inside the work dir —
/// `.part`/`.ytdl` sidepaths never count; bytes on disk are the authority.
pub async fn stream_file(work: &Path, label: &str) -> Option<PathBuf> {
    let mut rd = tokio::fs::read_dir(work).await.ok()?;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".part") || name.ends_with(".ytdl") {
            continue;
        }
        if let Some(rest) = name.strip_prefix(label) {
            if rest.starts_with('.') && rest.len() > 1 {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Completed subtitle files for the selections, in selection order, deduped:
/// exact `<base>.<lang>.<ext>` first, then any `<base>.<lang>.*` fallback.
pub async fn subtitle_files(
    work: &Path,
    base: &str,
    subs: &[MediaSubtitleSelection],
) -> Vec<PathBuf> {
    let mut names: Vec<String> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(work).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    for s in subs {
        let exact = format!("{base}.{}.{}", s.language, s.extension);
        if !taken.contains(&exact) && names.iter().any(|n| n == &exact) {
            taken.insert(exact.clone());
            out.push(work.join(&exact));
            continue;
        }
        let prefix = format!("{base}.{}.", s.language);
        if let Some(name) = names
            .iter()
            .find(|n| n.starts_with(&prefix) && !n.ends_with(".part") && !taken.contains(*n))
        {
            taken.insert(name.clone());
            out.push(work.join(name));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

/// Internal pipeline error: user/supervisor interruptions vs classified contract failures.
#[derive(Debug)]
enum PipelineError {
    Paused,
    Canceled,
    Stopped,
    Contract(ContractError),
}

impl From<ContractError> for PipelineError {
    fn from(e: ContractError) -> Self {
        PipelineError::Contract(e)
    }
}

struct ToolOutcome {
    success: bool,
    code: Option<i32>,
    /// Bounded tail of the diagnostics pipe (stderr for yt-dlp, stderr for ffmpeg).
    tail: Vec<u8>,
}

/// One planned stream download.
struct StreamPlan {
    label: &'static str,
    format_id: String,
    /// Size hint from the fresh manifest (None → unknown until the file lands).
    size_hint: Option<u64>,
}

/// Live progress shared between the runner callbacks and the 500 ms ticker.
#[derive(Default)]
struct ProgressState {
    completed: u64,
    downloaded: u64,
    speed: u64,
    eta: Option<u64>,
    total: Option<u64>,
    phase: String,
}

impl ProgressState {
    fn received(&self) -> u64 {
        self.completed + self.downloaded
    }
}

struct MediaTaskHandle {
    cmd_tx: mpsc::Sender<JobCommand>,
    stop: CancellationToken,
}

pub struct MediaJobManager {
    store: Arc<JobStore>,
    events: EventsTx,
    toolkit: Arc<ToolkitMap>,
    proxies: Arc<ProxyMap>,
    /// Shared with the inspector (Phase 11) — extraction slots are the same scarce resource.
    inspect_limiter: Arc<tokio::sync::Semaphore>,
    tasks: Mutex<HashMap<String, MediaTaskHandle>>,
}

impl MediaJobManager {
    pub fn new(
        store: Arc<JobStore>,
        events: EventsTx,
        toolkit: Arc<ToolkitMap>,
        proxies: Arc<ProxyMap>,
        inspect_limiter: Arc<tokio::sync::Semaphore>,
    ) -> Arc<Self> {
        // Boot recovery: a fresh core owns no child processes, so no media job may look
        // active; queued rows pause too (a fresh core never auto-starts media jobs).
        match store.reset_active_media_jobs() {
            Ok(n) if n > 0 => {
                tracing::info!("media boot recovery: paused {n} interrupted job(s)");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("media boot recovery failed: {e}"),
        }
        Arc::new(Self {
            store,
            events,
            toolkit,
            proxies,
            inspect_limiter,
            tasks: Mutex::new(HashMap::new()),
        })
    }

    // ---- queries ----

    pub fn list(&self) -> Result<Vec<MediaJob>, ContractError> {
        self.store.list_media_jobs()
    }

    pub fn get(&self, id: &str) -> Result<Option<MediaJob>, ContractError> {
        self.store.get_media_job(id)
    }

    // ---- create ----

    pub async fn create(
        self: &Arc<Self>,
        params: MediaDownloadParams,
    ) -> Result<MediaJob, ContractError> {
        validate_download_params(&params)?;
        let ts = now_ms();
        let job = MediaJob {
            id: new_ulid(),
            source_url: params.url.trim().to_string(),
            title: None,
            thumbnail_url: None,
            video_format_id: params.video_format_id.clone(),
            audio_format_id: params.audio_format_id.clone(),
            filename: params.filename.clone(),
            subtitles: dedupe_subtitles(params.subtitles),
            container: params.container,
            destination_dir: params.destination_dir,
            destination_path: None,
            work_dir: None,
            status: "queued".into(),
            total_bytes: None,
            received_bytes: 0,
            speed_bps: None,
            eta_seconds: None,
            error_code: None,
            proxy_profile_id: params.proxy_profile_id.clone(),
            created_at: ts,
            updated_at: ts,
        };
        self.store.insert_media_job(&job)?;
        self.emit_job(&job);
        self.pump();
        Ok(job)
    }

    // ---- lifecycle ----

    pub async fn pause(&self, id: &str) -> Result<MediaJob, ContractError> {
        let job = self.store.get_media_job(id)?.ok_or_else(media_not_found)?;
        if !matches!(
            job.status.as_str(),
            "queued" | "extracting" | "downloading" | "muxing"
        ) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot pause a media job in status {}", job.status),
            ));
        }
        let handle = {
            let tasks = self.tasks.lock().expect("media tasks mutex poisoned");
            tasks.get(id).map(|h| h.cmd_tx.clone())
        };
        match handle {
            Some(cmd_tx) => {
                // The runner reacts, kills the child and persists the paused state;
                // acknowledge it before returning so the caller never observes a stale
                // active status (the same contract as the HTTP queue's pause).
                let _ = cmd_tx.send(JobCommand::Pause).await;
                self.wait_runner_ack(id).await;
            }
            None => {
                let mut row = job;
                row.status = "paused".into();
                row.speed_bps = None;
                row.eta_seconds = None;
                row.updated_at = now_ms();
                self.store.update_media_job(&row)?;
                self.emit_job(&row);
            }
        }
        self.fresh(id)
    }

    /// Re-read the durable row (the runner may have advanced it during the await).
    fn fresh(&self, id: &str) -> Result<MediaJob, ContractError> {
        self.store.get_media_job(id)?.ok_or_else(media_not_found)
    }

    /// Wait (bounded) for the runner to persist its reaction to pause/cancel — the child
    /// kill is fast but the await boundaries make it asynchronous to this call.
    async fn wait_runner_ack(&self, id: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(row)) = self.store.get_media_job(id) {
                if !matches!(
                    row.status.as_str(),
                    "queued" | "extracting" | "downloading" | "muxing"
                ) {
                    return;
                }
            } else {
                return; // removed — nothing to wait for
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tracing::warn!(job = %id, "media runner ack timed out; reporting the current row");
    }

    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<MediaJob, ContractError> {
        let mut job = self.store.get_media_job(id)?.ok_or_else(media_not_found)?;
        if !matches!(job.status.as_str(), "paused" | "failed" | "canceled") {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot resume a media job in status {}", job.status),
            ));
        }
        job.status = "queued".into();
        job.error_code = None;
        job.speed_bps = None;
        job.eta_seconds = None;
        job.updated_at = now_ms();
        self.store.update_media_job(&job)?;
        self.emit_job(&job);
        self.pump();
        self.fresh(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<MediaJob, ContractError> {
        let job = self.store.get_media_job(id)?.ok_or_else(media_not_found)?;
        if !matches!(
            job.status.as_str(),
            "queued" | "extracting" | "downloading" | "muxing"
        ) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot cancel a media job in status {}", job.status),
            ));
        }
        let handle = {
            let tasks = self.tasks.lock().expect("media tasks mutex poisoned");
            tasks.get(id).map(|h| h.cmd_tx.clone())
        };
        match handle {
            Some(cmd_tx) => {
                let _ = cmd_tx.send(JobCommand::Cancel).await;
                self.wait_runner_ack(id).await;
            }
            None => {
                let mut row = job;
                row.status = "canceled".into();
                row.speed_bps = None;
                row.eta_seconds = None;
                row.updated_at = now_ms();
                self.store.update_media_job(&row)?;
                self.emit_job(&row);
            }
        }
        self.fresh(id)
    }

    pub async fn remove(
        self: &Arc<Self>,
        id: &str,
        delete_files: bool,
    ) -> Result<(), ContractError> {
        let job = self.store.get_media_job(id)?.ok_or_else(media_not_found)?;
        let handle = {
            let tasks = self.tasks.lock().expect("media tasks mutex poisoned");
            tasks.get(id).map(|h| (h.cmd_tx.clone(), h.stop.clone()))
        };
        if let Some((cmd_tx, stop)) = handle {
            let _ = cmd_tx.send(JobCommand::Cancel).await;
            stop.cancel();
            self.tasks
                .lock()
                .expect("media tasks mutex poisoned")
                .remove(id);
        }
        if !self.store.delete_media_job(id)? {
            return Err(media_not_found());
        }
        if delete_files {
            // Best effort: the record is already gone; leftovers never block the remove.
            if let Some(wd) = job.work_dir {
                let _ = tokio::fs::remove_dir_all(wd).await;
            }
            if let Some(p) = job.destination_path {
                let _ = tokio::fs::remove_file(p).await;
            }
        }
        self.pump();
        Ok(())
    }

    /// Graceful shutdown: interrupt every running pipeline (each task persists its state).
    pub async fn shutdown(&self) {
        let handles: Vec<(mpsc::Sender<JobCommand>, CancellationToken)> = self
            .tasks
            .lock()
            .expect("media tasks mutex poisoned")
            .values()
            .map(|h| (h.cmd_tx.clone(), h.stop.clone()))
            .collect();
        for (cmd_tx, stop) in handles {
            let _ = cmd_tx.send(JobCommand::Pause).await;
            stop.cancel();
        }
    }

    // ---- pump ----

    /// Start queued media jobs (FIFO by creation) while free slots exist.
    fn pump(self: &Arc<Self>) {
        {
            let mut tasks = self.tasks.lock().expect("media tasks mutex poisoned");
            tasks.retain(|_, h| !h.stop.is_cancelled());
            if tasks.len() >= MAX_CONCURRENT_MEDIA_JOBS {
                return;
            }
        }
        let Ok(all) = self.store.list_media_jobs() else {
            return;
        };
        let mut queued: Vec<MediaJob> = all
            .iter()
            .filter(|j| j.status == "queued")
            .cloned()
            .collect();
        queued.sort_by(|a, b| (a.created_at, a.id.as_str()).cmp(&(b.created_at, b.id.as_str())));
        for job in queued {
            {
                let tasks = self.tasks.lock().expect("media tasks mutex poisoned");
                if tasks.len() >= MAX_CONCURRENT_MEDIA_JOBS {
                    break;
                }
                if tasks.contains_key(job.id.as_str()) {
                    continue;
                }
            }
            self.spawn_task(job);
        }
    }

    fn spawn_task(self: &Arc<Self>, job: MediaJob) {
        let id = job.id.as_str().to_string();
        let (cmd_tx, cmd_rx) = mpsc::channel::<JobCommand>(8);
        let stop = CancellationToken::new();
        self.tasks
            .lock()
            .expect("media tasks mutex poisoned")
            .insert(
                id.clone(),
                MediaTaskHandle {
                    cmd_tx,
                    stop: stop.clone(),
                },
            );
        let manager = self.clone();
        tokio::spawn(async move {
            // run_job consumes one Arc; a second one outlives it for cleanup + pump.
            let after = manager.clone();
            manager.run_job(job, cmd_rx, stop).await;
            after
                .tasks
                .lock()
                .expect("media tasks mutex poisoned")
                .remove(&id);
            after.pump();
        });
    }

    // ---- the pipeline ----

    async fn run_job(
        self: Arc<Self>,
        mut job: MediaJob,
        mut cmd_rx: mpsc::Receiver<JobCommand>,
        stop: CancellationToken,
    ) {
        let ticker_stop = CancellationToken::new();
        let progress: Arc<Mutex<ProgressState>> = Arc::new(Mutex::new(ProgressState::default()));
        let ticker = self.spawn_ticker(
            job.id.as_str().to_string(),
            progress.clone(),
            ticker_stop.clone(),
        );
        let result = self
            .drive(&mut job, &mut cmd_rx, &stop, &progress, &ticker_stop)
            .await;
        ticker_stop.cancel();
        let _ = ticker.await; // the final persisted row is authoritative; ticker stops here
        match result {
            Ok(()) => {}
            Err(PipelineError::Paused) => {
                self.persist_transition(&job, "paused", None);
            }
            Err(PipelineError::Canceled) => {
                self.persist_transition(&job, "canceled", None);
            }
            Err(PipelineError::Stopped) => {
                // Supervisor teardown — pause (recoverable), never fail: bytes stay.
                self.persist_transition(&job, "paused", None);
            }
            Err(PipelineError::Contract(e)) => {
                let recoverable = matches!(
                    e.code,
                    ErrorCode::ProxyProfileNotFound | ErrorCode::MediaToolMissing
                );
                tracing::warn!(job = %job.id, error = %e, "media job ended");
                self.persist_transition(
                    &job,
                    if recoverable { "paused" } else { "failed" },
                    Some(e.code.as_str().into()),
                );
            }
        }
    }

    /// Write a terminal-ish status over an ACTIVE row only. A user's newer transition
    /// (resume/pause) must never be clobbered by a stale runner outcome. Byte counts stay
    /// the durable row's (the ticker owns them while running).
    fn persist_transition(&self, job: &MediaJob, status: &str, error_code: Option<String>) {
        let Ok(Some(fresh)) = self.store.get_media_job(job.id.as_str()) else {
            return; // removed while running
        };
        if !matches!(
            fresh.status.as_str(),
            "queued" | "extracting" | "downloading" | "muxing"
        ) {
            return;
        }
        let mut row = fresh;
        row.status = status.into();
        row.error_code = error_code;
        row.speed_bps = None;
        row.eta_seconds = None;
        row.title = job.title.clone();
        row.thumbnail_url = job.thumbnail_url.clone();
        row.work_dir = job.work_dir.clone();
        row.destination_path = job.destination_path.clone();
        row.updated_at = now_ms();
        if self.store.update_media_job(&row).is_ok() {
            self.emit_job(&row);
        }
    }

    async fn drive(
        &self,
        job: &mut MediaJob,
        cmd_rx: &mut mpsc::Receiver<JobCommand>,
        stop: &CancellationToken,
        progress: &Arc<Mutex<ProgressState>>,
        _ticker_stop: &CancellationToken,
    ) -> Result<(), PipelineError> {
        // ---- work dir ----
        let dest = PathBuf::from(&job.destination_dir);
        tokio::fs::create_dir_all(&dest)
            .await
            .map_err(contract_io)?;
        let work_dir = dest.join(".unidm-media").join(job.id.as_str());
        tokio::fs::create_dir_all(&work_dir)
            .await
            .map_err(contract_io)?;
        job.work_dir = Some(work_dir.display().to_string());
        job.error_code = None;
        set_status(job, "extracting");
        self.persist_active(job)?;

        // ---- 1. extraction (Phase 11 inspector: fail-closed tools + proxy) ----
        let manifest = {
            let limits = InspectLimits::default();
            let inspect_fut = media::inspect(
                &self.toolkit,
                &self.proxies,
                &self.inspect_limiter,
                MediaInspectParams {
                    url: job.source_url.clone(),
                    proxy_profile_id: job.proxy_profile_id.clone(),
                },
                &limits,
            );
            tokio::select! {
                _ = stop.cancelled() => return Err(PipelineError::Stopped),
                cmd = cmd_rx.recv() => return Err(interrupted(cmd)),
                r = inspect_fut => r.map_err(PipelineError::Contract)?,
            }
        };

        // First-extraction enrichment: the row now carries the real title/thumbnail.
        let manifest = manifest.manifest;
        if job.title.is_none() {
            job.title = Some(manifest.title.clone());
        }
        if job.thumbnail_url.is_none() {
            job.thumbnail_url = manifest.thumbnail_url.clone();
        }

        if manifest.is_live {
            return Err(PipelineError::Contract(ContractError::new(
                ErrorCode::MediaLiveUnsupported,
                "the stream is live; recording live media is not supported yet",
            )));
        }

        // ---- 2. resolve the persisted selection against the FRESH manifest ----
        // videos and audios are disjoint after normalization (Phase 11); the selection is
        // strict: a vanished format id is a classified outcome, never a silent substitute.
        let video = match &job.video_format_id {
            None => None,
            Some(id) => Some(
                manifest
                    .videos
                    .iter()
                    .find(|v| &v.format_id == id)
                    .ok_or_else(|| media_format_not_found(id, "video"))?,
            ),
        };
        let audio = match &job.audio_format_id {
            None => None,
            Some(id) => Some(
                manifest
                    .audios
                    .iter()
                    .find(|a| &a.format_id == id)
                    .ok_or_else(|| media_format_not_found(id, "audio"))?,
            ),
        };
        if video.is_none() && audio.is_none() {
            return Err(PipelineError::Contract(ContractError::new(
                ErrorCode::InvalidParams,
                "the job has neither a video nor an audio selection",
            )));
        }

        let plans: Vec<StreamPlan> = [
            video.map(|v| StreamPlan {
                label: "video",
                format_id: v.format_id.clone(),
                size_hint: v.file_size_bytes,
            }),
            audio.map(|a| StreamPlan {
                label: "audio",
                format_id: a.format_id.clone(),
                size_hint: a.file_size_bytes,
            }),
        ]
        .into_iter()
        .flatten()
        .collect();

        // Total from size hints (None while any hint is unknown — never a guess).
        let hint_total: Option<u64> = if plans.iter().all(|p| p.size_hint.is_some()) {
            Some(plans.iter().filter_map(|p| p.size_hint).sum())
        } else {
            None
        };
        // Suffix hint sums (per plan index) + whether the hint total is authoritative —
        // the live total reported during a stream run is completed + server-total + suffix.
        let all_hints_known = hint_total.is_some();
        let mut suffix_hints = vec![0u64; plans.len() + 1];
        for i in (0..plans.len()).rev() {
            suffix_hints[i] = suffix_hints[i + 1] + plans[i].size_hint.unwrap_or(0);
        }
        job.total_bytes = hint_total;
        {
            let mut s = progress.lock().expect("progress mutex poisoned");
            s.total = hint_total;
            s.phase = "downloading".into();
        }
        set_status(job, "downloading");
        self.persist_active(job)?;

        // ---- 3. stream downloads (completed streams skip by disk authority) ----
        let mut completed: u64 = 0;
        for (plan_index, plan) in plans.iter().enumerate() {
            if let Some(existing) = stream_file(&work_dir, plan.label).await {
                completed += file_len(&existing).await;
                {
                    let mut s = progress.lock().expect("progress mutex poisoned");
                    s.completed = completed;
                }
                continue;
            }
            let tool = self
                .toolkit
                .get("yt-dlp")
                .ok_or_else(|| PipelineError::Contract(media_tool_missing("yt-dlp")))?;
            let proxy = self.proxy_endpoint(job.proxy_profile_id.as_deref())?;
            let out_template = work_dir
                .join(format!("{}.%(ext)s", plan.label))
                .display()
                .to_string();
            let args = build_ytdlp_stream_args(
                &job.source_url,
                &plan.format_id,
                &out_template,
                proxy.as_deref(),
            );
            let prog = progress.clone();
            let done_before = completed;
            let suffix_after = suffix_hints[plan_index + 1];
            let outcome = run_child(
                &tool.path,
                &args,
                false,
                ErrorCode::MediaToolMissing,
                cmd_rx,
                stop,
                move |line| {
                    if let Some((downloaded, total, speed, eta)) = parse_unidm_progress(line) {
                        let mut s = prog.lock().expect("progress mutex poisoned");
                        s.downloaded = downloaded;
                        s.speed = speed;
                        s.eta = eta;
                        if all_hints_known {
                            if let Some(t) = total {
                                s.total = Some(done_before + t + suffix_after);
                            }
                        }
                    }
                },
            )
            .await?;
            if !outcome.success {
                return Err(PipelineError::Contract(ContractError::new(
                    ErrorCode::MediaDownloadFailed,
                    format!(
                        "the extractor failed downloading the {} stream (exit code {}): {}",
                        plan.label,
                        outcome.code.unwrap_or(-1),
                        tail_excerpt(&outcome.tail)
                    ),
                )));
            }
            let landed = stream_file(&work_dir, plan.label).await.ok_or_else(|| {
                PipelineError::Contract(ContractError::new(
                    ErrorCode::MediaDownloadFailed,
                    format!(
                        "the {} stream finished but no output file was produced",
                        plan.label
                    ),
                ))
            })?;
            completed += file_len(&landed).await;
            {
                let mut s = progress.lock().expect("progress mutex poisoned");
                s.completed = completed;
                s.downloaded = 0;
                s.speed = 0;
                s.eta = None;
            }
        }

        // ---- subtitle fetch (single run for every selected track) ----
        let mut sub_files: Vec<PathBuf> = Vec::new();
        if !job.subtitles.is_empty() && video.is_some() {
            sub_files = subtitle_files(&work_dir, &self.base_name(job), &job.subtitles).await;
            if sub_files.len() < job.subtitles.len() {
                let tool = self
                    .toolkit
                    .get("yt-dlp")
                    .ok_or_else(|| PipelineError::Contract(media_tool_missing("yt-dlp")))?;
                let proxy = self.proxy_endpoint(job.proxy_profile_id.as_deref())?;
                let out_template = work_dir.join(self.base_name(job)).display().to_string();
                let args = build_ytdlp_subs_args(
                    &job.source_url,
                    &out_template,
                    &job.subtitles,
                    proxy.as_deref(),
                );
                let outcome = run_child(
                    &tool.path,
                    &args,
                    false,
                    ErrorCode::MediaToolMissing,
                    cmd_rx,
                    stop,
                    |_| {},
                )
                .await?;
                if !outcome.success {
                    // Subtitles are best-effort decorations: a refusal fails the run only
                    // when NOTHING was produced; otherwise proceed with what landed.
                    sub_files =
                        subtitle_files(&work_dir, &self.base_name(job), &job.subtitles).await;
                    if sub_files.is_empty() {
                        return Err(PipelineError::Contract(ContractError::new(
                            ErrorCode::MediaDownloadFailed,
                            format!(
                                "the extractor failed fetching subtitles (exit code {}): {}",
                                outcome.code.unwrap_or(-1),
                                tail_excerpt(&outcome.tail)
                            ),
                        )));
                    }
                } else {
                    sub_files =
                        subtitle_files(&work_dir, &self.base_name(job), &job.subtitles).await;
                }
            }
        }

        // ---- 4. finalize: mux (or move) into the destination ----
        {
            let mut s = progress.lock().expect("progress mutex poisoned");
            s.phase = "muxing".into();
            s.speed = 0;
            s.eta = None;
            s.downloaded = 0;
            s.completed = completed;
        }
        set_status(job, "muxing");
        self.persist_active(job)?;

        let video_file = if video.is_some() {
            Some(
                stream_file(&work_dir, "video")
                    .await
                    .ok_or_else(|| missing_stream("video"))?,
            )
        } else {
            None
        };
        let audio_file = if audio.is_some() {
            Some(
                stream_file(&work_dir, "audio")
                    .await
                    .ok_or_else(|| missing_stream("audio"))?,
            )
        } else {
            None
        };

        let final_path = match (&video_file, &audio_file) {
            (None, Some(a)) => {
                // Audio-only: the audio file moves untouched — never a transcode.
                let ext = a
                    .extension()
                    .map(|e| e.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "m4a".into());
                self.resolve_final_path(job, &ext).await?
            }
            _ => self.resolve_final_path(job, job.container.as_str()).await?,
        };
        let tmp_path = PathBuf::from(format!("{}.tmp-unidm", final_path.display()));

        match (&video_file, &audio_file) {
            (None, Some(audio_src)) => {
                if audio_src != &final_path {
                    tokio::fs::rename(audio_src, &final_path)
                        .await
                        .map_err(contract_io)?;
                }
            }
            (v, a) => {
                let ffmpeg = self
                    .toolkit
                    .get("ffmpeg")
                    .ok_or_else(|| PipelineError::Contract(media_tool_missing("ffmpeg")))?;
                let duration_secs = manifest.duration_seconds;
                let prog = progress.clone();
                let args = build_ffmpeg_mux_args(
                    v.as_deref(),
                    a.as_deref(),
                    &sub_files,
                    &tmp_path,
                    job.container,
                );
                let outcome = run_child(
                    &ffmpeg.path,
                    &args,
                    true,
                    ErrorCode::MediaMuxFailed,
                    cmd_rx,
                    stop,
                    move |line| {
                        if let Some(us) = parse_ffmpeg_out_time_us(line) {
                            if let Some(d) = duration_secs {
                                if d > 0.0 {
                                    let remaining = (d - (us as f64 / 1_000_000.0)).max(0.0);
                                    let mut s = prog.lock().expect("progress mutex poisoned");
                                    s.eta = Some(remaining.ceil() as u64);
                                }
                            }
                        }
                    },
                )
                .await?;
                if !outcome.success {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(PipelineError::Contract(ContractError::new(
                        ErrorCode::MediaMuxFailed,
                        format!(
                            "ffmpeg failed (exit code {}): {}",
                            outcome.code.unwrap_or(-1),
                            tail_excerpt(&outcome.tail)
                        ),
                    )));
                }
                let meta = tokio::fs::metadata(&tmp_path).await.map_err(contract_io)?;
                if meta.len() == 0 {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(PipelineError::Contract(ContractError::new(
                        ErrorCode::MediaMuxFailed,
                        "ffmpeg produced an empty output file",
                    )));
                }
                // Rename only after a clean exit; never present a partial mux as final.
                if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
                    let rerouted = crate::engine::uniquify(&final_path).await;
                    job.destination_path = Some(rerouted.display().to_string());
                    tokio::fs::rename(&tmp_path, &rerouted)
                        .await
                        .map_err(contract_io)?;
                } else {
                    tokio::fs::rename(&tmp_path, &final_path)
                        .await
                        .map_err(contract_io)?;
                }
            }
        }

        // ---- 5. completion ----
        let final_len = file_len(&final_path).await;
        job.status = "completed".into();
        job.received_bytes = final_len;
        if job.total_bytes.is_none() {
            job.total_bytes = Some(final_len);
        }
        job.speed_bps = None;
        job.eta_seconds = None;
        job.error_code = None;
        job.updated_at = now_ms();
        self.store
            .update_media_job(job)
            .map_err(PipelineError::Contract)?;
        self.emit_job(job);
        // The work dir's bytes now live in the final file — clean up (best effort).
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        Ok(())
    }

    /// Proxy endpoint for the job's profile (fail-closed; None = direct).
    fn proxy_endpoint(&self, profile_id: Option<&str>) -> Result<Option<String>, PipelineError> {
        match profile_id {
            None => Ok(None),
            Some(pid) => {
                let profile = self.proxies.get(pid).ok_or_else(|| {
                    PipelineError::Contract(ContractError::new(
                        ErrorCode::ProxyProfileNotFound,
                        format!("proxy profile {pid} is not available"),
                    ))
                })?;
                Ok(Some(crate::proxy::proxy_url(&profile)?))
            }
        }
    }

    /// Base filename for outputs: explicit param → sanitized title → stable fallback.
    fn base_name(&self, job: &MediaJob) -> String {
        job.filename
            .clone()
            .or_else(|| job.title.clone().map(|t| sanitize(&t)))
            .unwrap_or_else(|| FALLBACK_BASE.into())
    }

    /// The final destination path — computed once (uniquified) and then REUSED on every
    /// later run so resumes land on the same file the UI already shows.
    async fn resolve_final_path(
        &self,
        job: &mut MediaJob,
        ext: &str,
    ) -> Result<PathBuf, PipelineError> {
        if let Some(p) = &job.destination_path {
            return Ok(PathBuf::from(p));
        }
        let candidate =
            Path::new(&job.destination_dir).join(format!("{}.{ext}", self.base_name(job)));
        let final_path = crate::engine::uniquify(&candidate).await;
        job.destination_path = Some(final_path.display().to_string());
        job.updated_at = now_ms();
        self.store
            .update_media_job(job)
            .map_err(PipelineError::Contract)?;
        Ok(final_path)
    }

    /// Persist an in-flight transition (the runner owns the row; no terminal overwrite).
    fn persist_active(&self, job: &MediaJob) -> Result<(), PipelineError> {
        let mut row = job.clone();
        row.updated_at = now_ms();
        self.store
            .update_media_job(&row)
            .map_err(PipelineError::Contract)?;
        self.emit_job(&row);
        Ok(())
    }

    fn emit_job(&self, job: &MediaJob) {
        let _ = self.events.send(EventEnvelope {
            v: dc_protocol::PROTOCOL_VERSION,
            event: "media.updated".into(),
            payload: Some(serde_json::json!({ "job": job })),
        });
    }

    /// 500 ms ticker: throttled `media.progress` events + durable progress rows.
    fn spawn_ticker(
        &self,
        job_id: String,
        progress: Arc<Mutex<ProgressState>>,
        stop: CancellationToken,
    ) -> tokio::task::JoinHandle<()> {
        let store = self.store.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PROGRESS_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tick.tick() => {}
                }
                let (received, total, speed, eta, phase) = {
                    let s = progress.lock().expect("progress mutex poisoned");
                    (s.received(), s.total, s.speed, s.eta, s.phase.clone())
                };
                if phase.is_empty() {
                    continue;
                }
                // The durable row is the truth: if a pause/cancel/remove landed, the
                // ticker must stop overwriting it (the runner may still be draining
                // pipes for a few moments).
                match store.get_media_job(&job_id) {
                    Ok(Some(row)) => {
                        if !matches!(
                            row.status.as_str(),
                            "queued" | "extracting" | "downloading" | "muxing"
                        ) {
                            break;
                        }
                    }
                    _ => break, // row gone
                }
                let _ = store.update_media_progress(&job_id, received, total, speed, eta, &phase);
                let _ = events.send(EventEnvelope {
                    v: dc_protocol::PROTOCOL_VERSION,
                    event: "media.progress".into(),
                    payload: Some(serde_json::json!({
                        "jobId": job_id,
                        "phase": phase,
                        "receivedBytes": received,
                        "totalBytes": total,
                        "speedBps": speed,
                        "etaSeconds": eta,
                    })),
                });
            }
        })
    }
}

fn media_tool_missing(tool: &str) -> ContractError {
    ContractError::new(
        ErrorCode::MediaToolMissing,
        format!(
            "the bundled {tool} is not installed yet — install it from Settings → Media toolkit"
        ),
    )
    .with_data(serde_json::json!({ "tool": tool }))
}

fn media_not_found() -> ContractError {
    ContractError::new(ErrorCode::InvalidState, "media job not found")
}

/// Map a user command onto a pipeline interruption (None = channel closed → canceled).
fn interrupted(cmd: Option<JobCommand>) -> PipelineError {
    match cmd {
        Some(JobCommand::Pause) => PipelineError::Paused,
        _ => PipelineError::Canceled,
    }
}

fn contract_io(e: std::io::Error) -> ContractError {
    let code = if e.kind() == std::io::ErrorKind::StorageFull {
        ErrorCode::DiskFull
    } else {
        ErrorCode::IoError
    };
    ContractError::new(code, format!("{e}"))
}

fn set_status(job: &mut MediaJob, status: &str) {
    job.status = status.into();
    job.updated_at = now_ms();
}

fn missing_stream(label: &str) -> PipelineError {
    PipelineError::Contract(ContractError::new(
        ErrorCode::MediaDownloadFailed,
        format!("the {label} stream file vanished from the work dir before the mux"),
    ))
}

fn media_format_not_found(id: &str, kind: &str) -> PipelineError {
    PipelineError::Contract(ContractError::new(
        ErrorCode::MediaFormatNotFound,
        format!(
            "the selected {kind} format {id} is no longer offered by the source; re-inspect and re-select"
        ),
    ))
}

async fn file_len(path: &Path) -> u64 {
    tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0)
}

fn tail_excerpt(tail: &[u8]) -> String {
    let text = String::from_utf8_lossy(tail);
    let trimmed = text.trim();
    let lines: Vec<&str> = trimmed.lines().collect();
    let start = lines.len().saturating_sub(4);
    lines[start..].join(" | ")
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        FALLBACK_BASE.into()
    } else {
        trimmed.into()
    }
}

// ---------------------------------------------------------------------------
// child process runner
// ---------------------------------------------------------------------------

/// Run an external tool watching for pause/cancel. The "progress" pipe is read line by
/// line and handed to `on_line`; the other pipe drains concurrently into a bounded tail
/// (no pipe deadlock, bounded memory). The child is killed on interruption.
async fn run_child(
    program: &str,
    args: &[String],
    progress_on_stdout: bool,
    spawn_err_code: ErrorCode,
    cmd_rx: &mut mpsc::Receiver<JobCommand>,
    stop: &CancellationToken,
    mut on_line: impl FnMut(&str) + Send,
) -> Result<ToolOutcome, PipelineError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            PipelineError::Contract(ContractError::new(
                spawn_err_code,
                format!("failed to launch {program}: {e}"),
            ))
        })?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    // The two pipes have different concrete types — erase them to one reader shape.
    let (progress_pipe, tail_pipe): (
        Box<dyn tokio::io::AsyncRead + Unpin + Send>,
        Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    ) = if progress_on_stdout {
        (Box::new(stdout), Box::new(stderr))
    } else {
        (Box::new(stderr), Box::new(stdout))
    };

    // Diagnostics tail drain (bounded) — runs concurrently with the progress loop.
    let tail_task = tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(2048);
        let mut reader = tokio::io::BufReader::new(tail_pipe);
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > TAIL_CAP * 2 {
                        let overflow = buf.len() - TAIL_CAP;
                        buf.drain(..overflow);
                    }
                }
            }
        }
        if buf.len() > TAIL_CAP {
            let overflow = buf.len() - TAIL_CAP;
            buf.drain(..overflow);
        }
        buf
    });

    let mut progress_reader = tokio::io::BufReader::new(progress_pipe);
    let mut line = String::new();
    loop {
        line.clear();
        let read = tokio::select! {
            _ = stop.cancelled() => {
                let _ = child.kill().await;
                // Never await the tail here: a killed child may leave grandchildren
                // (shells, helpers) holding the pipe — the drain detaches instead.
                drop(tail_task);
                return Err(PipelineError::Stopped);
            }
            cmd = cmd_rx.recv() => {
                let _ = child.kill().await;
                drop(tail_task);
                return Err(interrupted(cmd));
            }
            r = progress_reader.read_line(&mut line) => r,
        };
        match read {
            Ok(0) | Err(_) => break, // EOF (or read error) — fall through to the exit status
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                on_line(trimmed);
            }
        }
    }

    let status = child.wait().await.map_err(|e| {
        PipelineError::Contract(ContractError::new(
            ErrorCode::IoError,
            format!("waiting for {program} failed: {e}"),
        ))
    })?;
    let tail = tail_task.await.unwrap_or_default();
    Ok(ToolOutcome {
        success: status.success(),
        code: status.code(),
        tail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(
        video: Option<&str>,
        audio: Option<&str>,
        subs: Vec<MediaSubtitleSelection>,
    ) -> MediaDownloadParams {
        MediaDownloadParams {
            url: "https://example.com/watch/abc".into(),
            video_format_id: video.map(str::to_string),
            audio_format_id: audio.map(str::to_string),
            subtitles: subs,
            container: MediaContainer::Mkv,
            destination_dir: "/tmp/unidm".into(),
            filename: None,
            proxy_profile_id: None,
        }
    }

    #[test]
    fn download_params_validate_selection_rules() {
        assert!(validate_download_params(&params(Some("137"), Some("140"), vec![])).is_ok());
        assert!(validate_download_params(&params(Some("137"), None, vec![])).is_ok());
        assert!(validate_download_params(&params(None, Some("140"), vec![])).is_ok());
        // at least one format
        assert!(validate_download_params(&params(None, None, vec![])).is_err());
        // subtitles require a video selection
        assert!(validate_download_params(&params(
            None,
            Some("140"),
            vec![MediaSubtitleSelection {
                language: "en".into(),
                extension: "vtt".into(),
                is_auto_generated: false,
            }]
        ))
        .is_err());
        // leading-dash ids are argv hygiene violations
        assert!(validate_download_params(&params(Some("-o/tmp/evil"), None, vec![])).is_err());
        assert!(validate_download_params(&params(None, Some("--proxy"), vec![])).is_err());
        // subtitle language/extension hygiene
        assert!(validate_download_params(&params(
            Some("137"),
            None,
            vec![MediaSubtitleSelection {
                language: "-x".into(),
                extension: "vtt".into(),
                is_auto_generated: false,
            }]
        ))
        .is_err());
        // non-http url
        let mut p = params(Some("137"), None, vec![]);
        p.url = "ftp://example.com/x".into();
        assert!(validate_download_params(&p).is_err());
    }

    #[test]
    fn subtitles_dedupe_preserving_order() {
        let dup = vec![
            MediaSubtitleSelection {
                language: "en".into(),
                extension: "vtt".into(),
                is_auto_generated: false,
            },
            MediaSubtitleSelection {
                language: "en".into(),
                extension: "vtt".into(),
                is_auto_generated: false,
            },
            MediaSubtitleSelection {
                language: "de".into(),
                extension: "vtt".into(),
                is_auto_generated: true,
            },
        ];
        let out = dedupe_subtitles(dup);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].language, "en");
        assert_eq!(out[1].language, "de");
    }

    #[test]
    fn ytdlp_stream_args_are_flag_safe_and_carry_the_progress_template() {
        let args = build_ytdlp_stream_args(
            "https://example.com/watch/abc",
            "137",
            "/work/video.%(ext)s",
            None,
        );
        assert_eq!(args.last().unwrap(), "https://example.com/watch/abc");
        assert!(args.iter().any(|a| a == "137"));
        assert!(args.iter().any(|a| a.contains("UNIDM")));
        assert!(!args.iter().any(|a| a == "--proxy"));
        let proxied = build_ytdlp_stream_args(
            "https://example.com/watch/abc",
            "137",
            "/work/video.%(ext)s",
            Some("http://u:p@proxy:3128"),
        );
        let idx = proxied.iter().position(|a| a == "--proxy").unwrap();
        assert_eq!(proxied[idx + 1], "http://u:p@proxy:3128");
    }

    #[test]
    fn ytdlp_subs_args_join_langs_and_exts() {
        let subs = vec![
            MediaSubtitleSelection {
                language: "en".into(),
                extension: "vtt".into(),
                is_auto_generated: false,
            },
            MediaSubtitleSelection {
                language: "de".into(),
                extension: "vtt".into(),
                is_auto_generated: true,
            },
            MediaSubtitleSelection {
                language: "en".into(),
                extension: "srt".into(),
                is_auto_generated: false,
            },
        ];
        let args = build_ytdlp_subs_args("https://example.com/x", "/work/base", &subs, None);
        let langs = &args[args.iter().position(|a| a == "--sub-langs").unwrap() + 1];
        assert_eq!(langs, "en,de");
        let fmt = &args[args.iter().position(|a| a == "--sub-format").unwrap() + 1];
        assert_eq!(fmt, "vtt/srt/best");
        assert!(args.iter().any(|a| a == "--skip-download"));
        assert!(args.iter().any(|a| a == "--write-auto-subs"));
    }

    #[test]
    fn ffmpeg_mux_args_map_inputs_and_copy_codecs() {
        let subs = vec![PathBuf::from("/work/Fake Video.en.vtt")];
        let args = build_ffmpeg_mux_args(
            Some(Path::new("/work/video.mp4")),
            Some(Path::new("/work/audio.m4a")),
            &subs,
            Path::new("/dest/out.mkv.tmp-unidm"),
            MediaContainer::Mkv,
        );
        let join_all = |needle: &str| -> Vec<usize> {
            args.iter()
                .enumerate()
                .filter(|(_, a)| *a == needle)
                .map(|(i, _)| i)
                .collect()
        };
        let inputs = join_all("-i");
        assert_eq!(inputs.len(), 3);
        assert_eq!(args[inputs[0] + 1], "/work/video.mp4");
        assert_eq!(args[inputs[1] + 1], "/work/audio.m4a");
        assert_eq!(args[inputs[2] + 1], "/work/Fake Video.en.vtt");
        // video input 0, audio input 1, subtitle input 2 → correct -map indices
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:v:0"));
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "1:a:0"));
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "2:s:0"));
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "copy"));
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "copy"));
        assert!(args.windows(2).any(|w| w[0] == "-c:s" && w[1] == "srt"));
        assert!(args.windows(2).any(|w| w[0] == "-f" && w[1] == "matroska"));
        assert_eq!(args.last().unwrap(), "/dest/out.mkv.tmp-unidm");
        // mp4 selects mov_text; video-only job shifts the audio maps away
        let mp4 = build_ffmpeg_mux_args(
            Some(Path::new("/work/video.webm")),
            None,
            &[],
            Path::new("/dest/out.mp4.tmp-unidm"),
            MediaContainer::Mp4,
        );
        assert!(mp4.windows(2).any(|w| w[0] == "-c:v" && w[1] == "copy"));
        assert!(!mp4.windows(2).any(|w| w[0] == "-c:a"));
        assert!(!mp4.windows(2).any(|w| w[0] == "-c:s"));
        assert!(mp4.windows(2).any(|w| w[0] == "-f" && w[1] == "mp4"));
        // no inputs at all → still well-formed (no crash, no maps)
        let none =
            build_ffmpeg_mux_args(None, None, &[], Path::new("/dest/out"), MediaContainer::Mkv);
        assert!(!none.iter().any(|a| a == "-map"));
    }

    #[test]
    fn unidm_progress_lines_parse_with_na_fields() {
        let (downloaded, total, speed, eta) =
            parse_unidm_progress("UNIDM 4096 10000 10000 512 12").unwrap();
        assert_eq!(downloaded, 4096);
        assert_eq!(total, Some(10000));
        assert_eq!(speed, 512);
        assert_eq!(eta, Some(12));
        // NA tokens: exact total unknown → estimate fallback consumed in one step
        let (downloaded, total, speed, eta) =
            parse_unidm_progress("UNIDM 100 NA 5000 42 NA").unwrap();
        assert_eq!(downloaded, 100);
        assert_eq!(total, Some(5000));
        assert_eq!(speed, 42);
        assert_eq!(eta, None);
        // non-progress lines never parse
        assert!(parse_unidm_progress("[download] Destination: /x/y.mp4").is_none());
        assert!(parse_unidm_progress("").is_none());
    }

    #[test]
    fn ffmpeg_progress_lines_parse_microseconds() {
        assert_eq!(
            parse_ffmpeg_out_time_us("out_time_ms=1234567").unwrap(),
            1_234_567
        );
        assert_eq!(parse_ffmpeg_out_time_us("out_time_ms=-5"), None);
        assert_eq!(parse_ffmpeg_out_time_us("progress=continue"), None);
        assert_eq!(parse_ffmpeg_out_time_us("out_time_ms=NA"), None);
    }
}
