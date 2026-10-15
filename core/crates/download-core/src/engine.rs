//! Segmented multi-connection resumable download engine (v2).
//!
//! Data-integrity rules (they outrank everything else):
//!  - the per-segment journal NEVER leads the file: `written` is persisted after the bytes
//!    reach the OS, so a crash can only cost a small re-download, never a hole;
//!  - resume requests carry `If-Range` with the validator of the source the part came from;
//!    a 200 answer means the source changed → the whole run restarts from zero (bounded);
//!  - `206` answers are validated against the requested offset and total before any write;
//!  - writes are hard-capped at the planned window end — server surplus bytes are dropped;
//!  - completion verifies Σ written == total, then hashes the part file with SHA-256 and —
//!    when the job carries an expected checksum — refuses to declare success on mismatch;
//!  - the final rename happens only after fsync.
//!
//! Phase 7 (recovery engine): an expired URL never destroys the job or the bytes. When a
//! run resumes bytes from a previous run, the part's provenance is revalidated against the
//! fresh source with multiple signals (`recover::revalidate`): proven identity resumes with
//! If-Range; equal-size changes with an expected checksum run a checksum-arbitrated
//! gap-fill (no If-Range); anything else wipes the part and restarts clean (bounded).
//!
//! Jobs whose source does not support ranges (or whose size is unknown) run as a single
//! append-mode window; the model is identical, only the window is open-ended. A v1-era part
//! (bytes on disk, validators persisted, no journal rows) is migrated forward instead of
//! being discarded.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dc_protocol::job::{ChecksumAlgorithm, DownloadJob};
use dc_protocol::{
    new_ulid, ContractError, ErrorCode, EventEnvelope, MediaInspectParams, MediaInspectResult,
};
use dc_storage::{JobStore, SegmentRow};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::media::{self, InspectLimits};
use crate::proxy::{host_matches_bypass, host_of, proxy_url, ProxyMap, RuntimeProxy};
use crate::rate_limit::Bucket;
use crate::recover::{classify_source_failure, revalidate, RevalidateVerdict, SourceSignals};
use crate::segments::{
    journal_from_plan, journal_matches_plan, normalize_expected, plan_windows, to_hex, Window,
    MAX_CONNECTIONS_CAP, MIN_SEGMENT_BYTES,
};
use crate::toolkit::ToolkitMap;

pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
/// Journal flush cadence per segment (the durable cursor trails in-memory by at most ~1 MiB).
const JOURNAL_FLUSH_BYTES: u64 = 1024 * 1024;
/// Attempts per segment against transient network/stream errors before the job fails.
const MAX_SEGMENT_ATTEMPTS: usize = 3;
/// Linear backoff between segment attempts.
const RETRY_BACKOFF_MS: u64 = 300;
/// How often a source change (200 on a ranged request) may trigger a clean restart.
const MAX_SOURCE_RESTARTS: usize = 2;
/// Chunk size for the completion hash pass.
const HASH_CHUNK: usize = 256 * 1024;

pub type EventsTx = mpsc::UnboundedSender<EventEnvelope>;

/// Expected checksum supplied at creation (validated + normalized by the caller).
#[derive(Debug, Clone, PartialEq)]
pub struct ChecksumSpec {
    pub algorithm: ChecksumAlgorithm,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct CreateJobParams {
    pub url: String,
    pub destination_dir: String,
    pub filename: Option<String>,
    pub overwrite: bool,
    pub headers: Option<HashMap<String, String>>,
    pub checksum: Option<ChecksumSpec>,
    /// v1.4 (Phase 9): proxy profile this job routes through (None = direct).
    pub proxy_profile_id: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum JobCommand {
    Pause,
    Cancel,
}

/// Probe result of `GET Range bytes=0-0`.
#[derive(Debug, Clone)]
struct Probe {
    total_bytes: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    content_type: Option<String>,
    ranges_supported: bool,
    filename_hint: Option<String>,
}

#[derive(thiserror::Error, Debug)]
pub enum EngineError {
    #[error("contract: {0}")]
    Contract(#[from] ContractError),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl EngineError {
    pub fn to_contract(&self) -> ContractError {
        match self {
            EngineError::Contract(c) => c.clone(),
            EngineError::Http(e) => {
                let status = e.status().map(|s| s.as_u16());
                let code = if e.is_timeout() || e.is_connect() {
                    ErrorCode::NetworkError
                } else if status.is_some() {
                    match status {
                        Some(416) => ErrorCode::RangeNotSatisfiable,
                        _ => ErrorCode::HttpError,
                    }
                } else {
                    ErrorCode::NetworkError
                };
                ContractError::new(code, format!("{e}"))
                    .with_data(serde_json::json!({ "status": status }))
            }
            EngineError::Io(e) => {
                let code = if e.kind() == std::io::ErrorKind::StorageFull {
                    ErrorCode::DiskFull
                } else {
                    ErrorCode::IoError
                };
                ContractError::new(code, format!("{e}"))
            }
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn touch(job: &mut DownloadJob) {
    job.updated_at = now_ms();
}

fn set_error(job: &mut DownloadJob, err: &ContractError) {
    job.status = "failed".into();
    job.error_code = Some(err.code.as_str().into());
    job.speed_bps = None;
    job.eta_seconds = None;
    touch(job);
}

/// Outcome of one segment task.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SegmentOutcome {
    /// The window is fully on disk.
    Done,
    /// The source changed under us (200 on a ranged request / total mismatch):
    /// the caller wipes the journal and restarts the run.
    Restart,
    /// Supervisor teardown observed inside the task; the run must not continue.
    Stopped,
}

/// Per-run shared state across the segment tasks.
#[derive(Debug)]
struct RunState {
    /// Σ of every segment's in-memory write cursor (authoritative live received count).
    received: Arc<AtomicU64>,
    /// Set by the first task that detects a source change; peers exit early.
    restart: Arc<AtomicBool>,
    /// In-memory write cursors per segment index — flushed to the journal on pause/cancel
    /// so a user-initiated pause resumes exactly where the UI says it did.
    cursors: Arc<Mutex<Vec<u64>>>,
}

pub struct Engine {
    pub store: Arc<JobStore>,
    pub client: reqwest::Client,
    pub events: EventsTx,
    max_connections: Arc<AtomicU64>,
    /// Global bandwidth bucket shared by every segment of every job (0 = unlimited).
    global_bucket: Arc<Bucket>,
    /// Per-job bandwidth buckets, live while a run is active (0 = unlimited).
    job_buckets: Mutex<HashMap<String, Arc<Bucket>>>,
    /// Runtime proxy endpoints pushed by main (v1.4); secrets stay in memory only.
    /// Shared with the media pipeline manager (Phase 12).
    proxies: Arc<ProxyMap>,
    /// Bundled media tool executables pushed by main (v1.5); only checksum-proven paths.
    /// Shared with the media pipeline manager (Phase 12).
    toolkit: Arc<ToolkitMap>,
    /// Caps concurrent media inspections (Phase 11) — no process storms. Shared with the
    /// media pipeline manager, whose extraction step consumes the same budget.
    inspect_limiter: Arc<Semaphore>,
}

impl Engine {
    pub fn new(
        store: Arc<JobStore>,
        events: EventsTx,
        toolkit: Arc<ToolkitMap>,
        proxies: Arc<ProxyMap>,
        inspect_limiter: Arc<Semaphore>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(concat!(
                "Syntax Download Manager/",
                env!("CARGO_PKG_VERSION")
            ))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client builds");
        Self {
            store,
            client,
            events,
            max_connections: Arc::new(AtomicU64::new(4)),
            global_bucket: Bucket::new(0),
            job_buckets: Mutex::new(HashMap::new()),
            proxies,
            toolkit,
            inspect_limiter,
        }
    }

    /// Full replace of the runtime proxy map (main is the single source of truth).
    pub fn set_runtime_proxies(&self, profiles: Vec<RuntimeProxy>) {
        self.proxies.replace(profiles);
    }

    /// Full replace of the toolkit path map (Phase 10; main pushes only verified tools).
    pub fn set_toolkit_paths(
        &self,
        tools: Vec<dc_protocol::ToolkitPathEntry>,
    ) -> Result<(), dc_protocol::ContractError> {
        self.toolkit.replace(tools)
    }

    /// Media inspection (Phase 11): run the bundled yt-dlp against a media page and
    /// normalize its JSON into a contract manifest. Fail-closed on unverified/missing tools.
    pub async fn inspect_media(
        &self,
        params: MediaInspectParams,
    ) -> Result<MediaInspectResult, dc_protocol::ContractError> {
        media::inspect(
            &self.toolkit,
            &self.proxies,
            &self.inspect_limiter,
            params,
            &InspectLimits::default(),
        )
        .await
    }

    /// Connections per download (segmentation ceiling); clamped to the contract range.
    pub fn set_max_connections(&self, max: usize) {
        self.max_connections
            .store(max.clamp(1, MAX_CONNECTIONS_CAP) as u64, Ordering::SeqCst);
    }

    /// Global bandwidth cap in KiB/s (0 = unlimited). Applies live to running runs.
    pub fn set_global_speed_kbps(&self, kbps: u64) {
        self.global_bucket.set_limit(kbps.saturating_mul(1024));
    }

    /// Live per-job cap; creates the bucket when the job has no active run yet.
    pub fn set_job_speed_kbps(&self, id: &str, kbps: u64) {
        let bps = kbps.saturating_mul(1024);
        let mut buckets = self.job_buckets.lock().expect("job_buckets mutex poisoned");
        match buckets.get(id) {
            Some(bucket) => bucket.set_limit(bps),
            None => {
                buckets.insert(id.to_string(), Bucket::new(bps));
            }
        }
    }

    /// The per-job bucket for a run, seeded from the persisted row (used at run start).
    fn job_bucket(&self, id: &str, seed_kbps: Option<u64>) -> Arc<Bucket> {
        let mut buckets = self.job_buckets.lock().expect("job_buckets mutex poisoned");
        buckets
            .entry(id.to_string())
            .or_insert_with(|| Bucket::new(seed_kbps.unwrap_or(0).saturating_mul(1024)))
            .clone()
    }

    /// Drop the per-job bucket when the run ends (memory hygiene; the row persists the cap).
    fn remove_job_bucket(&self, id: &str) {
        self.job_buckets
            .lock()
            .expect("job_buckets mutex poisoned")
            .remove(id);
    }

    /// The HTTP client a job's run must use (v1.4 proxy routing).
    ///
    /// Resolution order: no profile → the shared direct client; profile present →
    /// resolve in the runtime map (missing → `proxy_profile_not_found`, fail-closed);
    /// the job URL's host in the profile's bypass list → direct; otherwise build a
    /// per-run client with the proxy + basic auth (scheme http/https/socks5).
    fn client_for_job(&self, job: &DownloadJob) -> Result<reqwest::Client, ContractError> {
        let Some(profile_id) = job.proxy_profile_id.as_deref() else {
            return Ok(self.client.clone());
        };
        let profile = self
            .proxies
            .get(profile_id)
            .ok_or_else(|| {
                ContractError::new(
                    ErrorCode::ProxyProfileNotFound,
                    format!(
                        "proxy profile {profile_id} is not available; resume after main re-pushes the runtime set"
                    ),
                )
            })?;
        let direct = self.client.clone();
        let Some(url_host) = host_of(&job.url) else {
            return Ok(direct);
        };
        if host_matches_bypass(&url_host, 0, &profile.bypass_list) {
            return Ok(direct);
        }
        let endpoint = proxy_url(&profile)?;
        let mut proxy = reqwest::Proxy::all(&endpoint).map_err(|e| {
            ContractError::new(ErrorCode::InvalidParams, format!("proxy endpoint: {e}"))
        })?;
        if profile.username.is_some() || profile.password.is_some() {
            proxy = proxy.basic_auth(
                profile.username.as_deref().unwrap_or_default(),
                profile.password.as_deref().unwrap_or_default(),
            );
        }
        reqwest::Client::builder()
            .user_agent(concat!(
                "Syntax Download Manager/",
                env!("CARGO_PKG_VERSION")
            ))
            .connect_timeout(Duration::from_secs(20))
            .proxy(proxy)
            .build()
            .map_err(|e| ContractError::new(ErrorCode::InvalidParams, format!("proxy client: {e}")))
    }

    /// Connectivity probe through a runtime profile (v1.4 `proxy.test`).
    pub async fn test_proxy(
        &self,
        profile_id: &str,
        url_override: Option<&str>,
    ) -> Result<serde_json::Value, ContractError> {
        let profile = self.proxies.get(profile_id).ok_or_else(|| {
            ContractError::new(
                ErrorCode::ProxyProfileNotFound,
                format!("proxy profile {profile_id} is not available"),
            )
        })?;
        let probe_url = match url_override {
            Some(u) => {
                if !u.starts_with("http://") && !u.starts_with("https://") {
                    return Err(ContractError::new(
                        ErrorCode::UrlInvalid,
                        "probe url must be http(s)",
                    ));
                }
                u.to_string()
            }
            None => "https://api.ipify.org".to_string(),
        };
        let endpoint = proxy_url(&profile)?;
        let mut proxy = reqwest::Proxy::all(&endpoint).map_err(|e| {
            ContractError::new(ErrorCode::InvalidParams, format!("proxy endpoint: {e}"))
        })?;
        if profile.username.is_some() || profile.password.is_some() {
            proxy = proxy.basic_auth(
                profile.username.as_deref().unwrap_or_default(),
                profile.password.as_deref().unwrap_or_default(),
            );
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!(
                "Syntax Download Manager/",
                env!("CARGO_PKG_VERSION")
            ))
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(12))
            .proxy(proxy)
            .build()
            .map_err(|e| {
                ContractError::new(ErrorCode::InternalError, format!("proxy client: {e}"))
            })?;

        let started = std::time::Instant::now();
        match client.get(&probe_url).send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let latency = started.elapsed().as_millis() as u64;
                if !resp.status().is_success() {
                    return Ok(serde_json::json!({
                        "ok": false, "latencyMs": latency, "exitIp": null,
                        "status": status, "errorCode": "http_error"
                    }));
                }
                // Read at most 64 bytes — enough for an IP echo, bounded by contract.
                let body: Vec<u8> = resp
                    .bytes()
                    .await
                    .map(|b| b.slice(..b.len().min(64)).to_vec())
                    .unwrap_or_default();
                let exit_ip = String::from_utf8_lossy(&body).trim().to_string();
                Ok(serde_json::json!({
                    "ok": true, "latencyMs": latency,
                    "exitIp": if exit_ip.is_empty() { None } else { Some(exit_ip) },
                    "status": status, "errorCode": null
                }))
            }
            Err(e) => {
                let code = if e.is_timeout() || e.is_connect() {
                    "network_error"
                } else {
                    "http_error"
                };
                Ok(serde_json::json!({
                    "ok": false, "latencyMs": null, "exitIp": null,
                    "status": e.status().map(|s| s.as_u16()), "errorCode": code
                }))
            }
        }
    }

    pub fn emit_job(&self, job: &DownloadJob) {
        let _ = self.events.send(EventEnvelope {
            v: dc_protocol::PROTOCOL_VERSION,
            event: "download.updated".into(),
            payload: Some(serde_json::json!({ "job": job })),
        });
    }

    pub fn emit_progress(&self, job: &DownloadJob) {
        let _ = self.events.send(EventEnvelope {
            v: dc_protocol::PROTOCOL_VERSION,
            event: "download.progress".into(),
            payload: Some(serde_json::json!({
                "jobId": job.id.as_str(),
                "receivedBytes": job.received_bytes,
                "totalBytes": job.total_bytes,
                "speedBps": job.speed_bps.unwrap_or(0),
                "etaSeconds": job.eta_seconds,
            })),
        });
    }

    /// Create + persist a queued job; the destination dir is authoritative from creation.
    pub async fn create_job(&self, params: CreateJobParams) -> Result<DownloadJob, ContractError> {
        if !params.url.starts_with("http://") && !params.url.starts_with("https://") {
            return Err(ContractError::new(
                ErrorCode::UrlInvalid,
                "only http(s) URLs are supported",
            ));
        }
        let checksum = match &params.checksum {
            Some(spec) => {
                let value = normalize_expected(spec.algorithm, &spec.value)
                    .map_err(|msg| ContractError::new(ErrorCode::InvalidParams, msg))?;
                Some((spec.algorithm, value))
            }
            None => None,
        };
        let ts = now_ms();
        let job = DownloadJob {
            id: new_ulid(),
            url: params.url,
            destination_dir: params.destination_dir,
            destination_path: None, // resolved by the probe
            filename: params.filename,
            status: "queued".into(),
            total_bytes: None,
            received_bytes: 0,
            etag: None,
            last_modified: None,
            content_type: None,
            speed_bps: None,
            eta_seconds: None,
            error_code: None,
            headers: params.headers.clone(),
            segment_count: None,
            checksum_algorithm: checksum.as_ref().map(|(a, _)| *a),
            checksum_expected: checksum.as_ref().map(|(_, v)| v.clone()),
            checksum_actual: None,
            checksum_verified: None,
            recovery_count: None,
            rebound_at: None,
            queue_position: None,
            speed_limit_kbps: None,
            proxy_profile_id: params.proxy_profile_id.clone(),
            created_at: ts,
            updated_at: ts,
        };
        self.store.insert_job(&job)?;
        Ok(job)
    }

    /// The per-job task: probe → segmented download → verify. Runs until terminal/paused.
    pub async fn run_job(
        self: Arc<Self>,
        mut job: DownloadJob,
        mut cmd_rx: mpsc::Receiver<JobCommand>,
        stop: CancellationToken,
    ) {
        // Per-job bandwidth bucket for the lifetime of the run (seeded from the row).
        let job_bucket = self.job_bucket(job.id.as_str(), job.speed_limit_kbps);
        let result = self.drive(&mut job, &mut cmd_rx, &stop, &job_bucket).await;
        self.remove_job_bucket(job.id.as_str());
        match result {
            Ok(()) => {}
            Err(err) => {
                if !stop.is_cancelled() {
                    let cerr = err.to_contract();
                    if cerr.code == ErrorCode::ProxyProfileNotFound {
                        // v1.4 fail-closed: the profile is gone from the runtime map — the job
                        // PAUSES (recoverable by resume once main re-pushes), never fails and
                        // never falls back to a direct connection (that would leak the real IP).
                        tracing::warn!(job = %job.id, error = %cerr, "job paused: proxy unavailable");
                        job.status = "paused".into();
                        job.error_code = Some(cerr.code.as_str().into());
                        job.speed_bps = None;
                        job.eta_seconds = None;
                        touch(&mut job);
                        if self.store.update_job(&job).is_ok() {
                            self.emit_job(&job);
                        }
                    } else {
                        tracing::warn!(job = %job.id, error = %cerr, "job failed");
                        set_error(&mut job, &cerr);
                        if self.store.update_job(&job).is_ok() {
                            self.emit_job(&job);
                        }
                    }
                }
            }
        }
    }

    async fn drive(
        &self,
        job: &mut DownloadJob,
        cmd_rx: &mut mpsc::Receiver<JobCommand>,
        stop: &CancellationToken,
        job_bucket: &Arc<Bucket>,
    ) -> Result<(), EngineError> {
        // Resume safety: If-Range must carry the validators of the SOURCE THE PART CAME FROM
        // (persisted before this run), never the freshly probed ones — otherwise a changed
        // source would answer 206 against the new validator and the part would be spliced
        // with foreign bytes. Captured BEFORE the probe overwrites job.etag/last_modified.
        // Phase 7 adds the full multi-signal provenance (size + content type) for revalidation.
        let mut part_etag = job.etag.clone();
        let mut part_last_modified = job.last_modified.clone();
        let mut part_total = job.total_bytes;
        let mut part_content_type = job.content_type.clone();

        // ---- proxy routing (v1.4, fail-closed BEFORE any network I/O) ----
        let client = self.client_for_job(job)?;

        // ---- probing ----
        job.status = "probing".into();
        // Leaving the queue: the slot is consumed, the position is released.
        job.queue_position = None;
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);

        let mut probe = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            r = self.probe(job, &client) => r?,
        };

        // ---- destination resolution (once; the part file is bound to this path) ----
        let base_name = job
            .filename
            .clone()
            .or_else(|| probe.filename_hint.clone())
            .or_else(|| filename_from_url(&job.url))
            .unwrap_or_else(|| "download.bin".into());
        let dir = PathBuf::from(&job.destination_dir);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(EngineError::Io)?;
        let candidate = dir.join(sanitize_filename(&base_name));
        let final_path = if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            uniquify(&candidate).await
        } else {
            candidate
        };
        let part_path = part_file(&final_path);

        job.destination_path = Some(final_path.display().to_string());
        job.total_bytes = probe.total_bytes;
        job.etag = probe.etag.clone();
        job.last_modified = probe.last_modified.clone();
        job.content_type = probe.content_type.clone();
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);

        // ---- segmented run loop (bounded clean restarts on source change) ----
        let mut restarts_used = 0usize;
        loop {
            let max_conn = self.max_connections.load(Ordering::SeqCst) as usize;
            let windows = plan_windows(
                job.total_bytes,
                probe.ranges_supported,
                max_conn,
                MIN_SEGMENT_BYTES,
            );

            // Journal reconciliation. A v1-era part (no journal rows) is migrated forward
            // instead of thrown away; a plan change resets the journal.
            let mut journal = self.store.list_segments(job.id.as_str())?;
            if journal.is_empty() {
                journal = self.migrate_v1_part(job, &part_path, &windows).await?;
            }
            if !journal_matches_plan(&journal, &windows) {
                tracing::info!(job = %job.id, "plan changed — resetting segment journal");
                journal = journal_from_plan(&windows);
                self.store
                    .replace_segments(job.id.as_str(), &journal)
                    .map_err(EngineError::Contract)?;
            }
            // A part with bytes but no provable identity is now decided by multi-signal
            // revalidation (Phase 7) instead of an unconditional discard: an expected
            // checksum may arbitrate an equal-size change; without proof the part is wiped.
            let part_validators = part_etag.clone().or_else(|| part_last_modified.clone());
            let has_written = journal.iter().any(|s| s.written_bytes > 0);
            let mut checksum_arbitrated = false;
            if has_written {
                let part_signals = SourceSignals::new(
                    part_total,
                    part_etag.clone(),
                    part_last_modified.clone(),
                    part_content_type.clone(),
                );
                let fresh_signals = SourceSignals::new(
                    job.total_bytes,
                    job.etag.clone(),
                    job.last_modified.clone(),
                    job.content_type.clone(),
                );
                match revalidate(
                    &part_signals,
                    &fresh_signals,
                    job.checksum_expected.is_some(),
                ) {
                    RevalidateVerdict::Identical => {}
                    RevalidateVerdict::ChecksumArbitrated => {
                        checksum_arbitrated = true;
                        tracing::info!(
                            job = %job.id,
                            "revalidation: gap-fill with checksum arbitration — part kept, no If-Range"
                        );
                    }
                    RevalidateVerdict::Restart => {
                        if restarts_used >= MAX_SOURCE_RESTARTS {
                            return Err(EngineError::Contract(ContractError::new(
                                ErrorCode::SourceChanged,
                                "source revalidation failed repeatedly — recover or replace the URL",
                            )));
                        }
                        restarts_used += 1;
                        tracing::info!(
                            job = %job.id,
                            restart = restarts_used,
                            "revalidation: representation changed — clean restart"
                        );

                        // Wipe the journal and the part BEFORE anything can re-migrate the
                        // stale bytes, then loop with the already-probed fresh signals.
                        self.store.delete_segments(job.id.as_str())?;
                        let file = OpenOptions::new()
                            .create(true)
                            .truncate(false)
                            .write(true)
                            .open(&part_path)
                            .await
                            .map_err(EngineError::Io)?;
                        file.set_len(0).await.map_err(EngineError::Io)?;
                        drop(file);
                        part_etag = None;
                        part_last_modified = None;
                        part_total = None;
                        part_content_type = None;
                        continue;
                    }
                }
            }

            let offset_mode = windows.iter().all(|w| w.end.is_some());
            let initial_written: u64 = journal.iter().map(|s| s.written_bytes).sum();

            // Align the part file with the journal before any writer opens it.
            if offset_mode {
                // Sparse pre-size: the windows tile [0, total) exactly.
                let file = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(&part_path)
                    .await
                    .map_err(EngineError::Io)?;
                file.set_len(job.total_bytes.unwrap_or(0))
                    .await
                    .map_err(EngineError::Io)?;
            } else {
                // Append mode: truncate to the durable cursor (drops any stale crash tail).
                let file = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(&part_path)
                    .await
                    .map_err(EngineError::Io)?;
                file.set_len(initial_written)
                    .await
                    .map_err(EngineError::Io)?;
            }

            // The If-Range validator for every request of this run: the PART's validators
            // when resuming written data, otherwise the freshly probed ones. A
            // checksum-arbitrated recovery run sends NO If-Range (the part's validators
            // differ from the fresh source by definition); integrity is arbitrated by the
            // expected checksum at completion plus the 206 Content-Range gates.
            let if_range = if has_written && checksum_arbitrated {
                None
            } else if has_written {
                part_validators.clone()
            } else {
                job.etag.clone().or_else(|| job.last_modified.clone())
            };

            job.segment_count = Some(windows.len().max(1) as u64);
            job.status = "downloading".into();
            job.received_bytes = initial_written;
            job.speed_bps = None;
            touch(job);
            self.store.update_job(job)?;
            self.emit_job(job);

            let state = Arc::new(RunState {
                received: Arc::new(AtomicU64::new(initial_written)),
                restart: Arc::new(AtomicBool::new(false)),
                cursors: Arc::new(Mutex::new(
                    journal.iter().map(|s| s.written_bytes).collect(),
                )),
            });

            // Progress ticker: one throttled stream of updates for the whole run.
            let ticker_stop = CancellationToken::new();
            let ticker = self.spawn_ticker(
                job.id.as_str().to_string(),
                job.total_bytes,
                state.received.clone(),
                ticker_stop.clone(),
            );

            // One task per window.
            let mut tasks: JoinSet<Result<SegmentOutcome, EngineError>> = JoinSet::new();
            for (idx, window) in windows.iter().enumerate() {
                let row = journal[idx].clone();
                tasks.spawn(Self::run_segment(
                    self.store.clone(),
                    client.clone(),
                    job.clone(),
                    idx,
                    *window,
                    row,
                    part_path.clone(),
                    if_range.clone(),
                    state.clone(),
                    stop.clone(),
                    self.global_bucket.clone(),
                    job_bucket.clone(),
                ));
            }

            let mut run_result: Result<(), EngineError> = Ok(());
            let mut source_changed = false;
            while !tasks.is_empty() {
                tokio::select! {
                    _ = stop.cancelled() => {
                        tasks.abort_all();
                        ticker_stop.cancel();
                        let _ = ticker.await;
                        return Ok(());
                    }
                    cmd = cmd_rx.recv() => {
                        tasks.abort_all();
                        ticker_stop.cancel();
                        let _ = ticker.await;
                        self.finalize_run(job, &state, "commanded stop");
                        if let Some(cmd) = cmd {
                            match cmd {
                                JobCommand::Pause => {
                                    job.status = "paused".into();
                                    job.speed_bps = None;
                                    job.eta_seconds = None;
                                    touch(job);
                                    self.store.update_job(job)?;
                                    self.emit_job(job);
                                }
                                JobCommand::Cancel => {
                                    job.status = "canceled".into();
                                    job.speed_bps = None;
                                    job.eta_seconds = None;
                                    touch(job);
                                    self.store.update_job(job)?;
                                    self.emit_job(job);
                                }
                            }
                        }
                        return Ok(());
                    }
                    done = tasks.join_next(), if !tasks.is_empty() => {
                        match done {
                            Some(Ok(Ok(SegmentOutcome::Done))) => {}
                            Some(Ok(Ok(SegmentOutcome::Stopped))) => {
                                tasks.abort_all();
                                ticker_stop.cancel();
                                let _ = ticker.await;
                                return Ok(());
                            }
                            Some(Ok(Ok(SegmentOutcome::Restart))) => {
                                source_changed = true;
                                tasks.abort_all();
                            }
                            Some(Ok(Err(err))) => {
                                run_result = Err(err);
                                tasks.abort_all();
                            }
                            Some(Err(join)) => {
                                run_result = Err(EngineError::Contract(ContractError::new(
                                    ErrorCode::InternalError,
                                    format!("segment task panicked: {join}"),
                                )));
                                tasks.abort_all();
                            }
                            None => {}
                        }
                    }
                }
            }
            ticker_stop.cancel();
            let _ = ticker.await;
            if stop.is_cancelled() {
                return Ok(());
            }

            if let Err(err) = run_result {
                self.finalize_run(job, &state, "failure");
                return Err(err);
            }

            if source_changed {
                if restarts_used >= MAX_SOURCE_RESTARTS {
                    return Err(EngineError::Contract(ContractError::new(
                        ErrorCode::SourceChanged,
                        "source changed repeatedly — recover or replace the URL",
                    )));
                }
                restarts_used += 1;
                tracing::info!(job = %job.id, restart = restarts_used, "source changed — clean restart");

                // Wipe the journal and the part BEFORE anything can re-migrate the stale
                // bytes, then re-probe so the next pass carries fresh validators.
                state.received.store(0, Ordering::SeqCst);
                self.store.delete_segments(job.id.as_str())?;
                let file = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(&part_path)
                    .await
                    .map_err(EngineError::Io)?;
                file.set_len(0).await.map_err(EngineError::Io)?;
                part_etag = None;
                part_last_modified = None;
                part_total = None;
                part_content_type = None;

                job.status = "probing".into();
                touch(job);
                self.store.update_job(job)?;
                probe = self.probe(job, &client).await?;
                job.total_bytes = probe.total_bytes;
                job.etag = probe.etag.clone();
                job.last_modified = probe.last_modified.clone();
                job.content_type = probe.content_type.clone();
                job.received_bytes = 0;
                touch(job);
                self.store.update_job(job)?;
                continue;
            }

            // ---- completion verification ----
            return self.complete(job, &state, &part_path, offset_mode).await;
        }
    }

    /// Persist cursors + received count when a run stops without completing.
    fn finalize_run(&self, job: &mut DownloadJob, state: &RunState, context: &str) {
        let cursors = state.cursors.lock().expect("cursors mutex poisoned");
        for (idx, written) in cursors.iter().enumerate() {
            let _ = self.store.update_segment_progress(
                job.id.as_str(),
                idx as u64,
                *written,
                "downloading",
            );
        }
        drop(cursors);
        job.received_bytes = state.received.load(Ordering::SeqCst);
        let _ = self
            .store
            .update_progress(job.id.as_str(), job.received_bytes, 0, None);
        tracing::debug!(job = %job.id, context, "run stopped without completing");
    }

    /// v1 → v2 journal migration: a legacy single-stream part (bytes on disk, validators
    /// persisted, no journal rows) becomes one window covering the file so the bytes are
    /// kept instead of re-downloaded.
    async fn migrate_v1_part(
        &self,
        job: &DownloadJob,
        part_path: &Path,
        windows: &[Window],
    ) -> Result<Vec<SegmentRow>, EngineError> {
        let part_len = match tokio::fs::metadata(part_path).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };
        let has_validators = job.etag.is_some() || job.last_modified.is_some();
        let first_window_covers_start = windows.first().map(|w| w.start).unwrap_or(1) == 0;

        if part_len == 0 || !has_validators || !first_window_covers_start {
            let fresh = journal_from_plan(windows);
            self.store
                .replace_segments(job.id.as_str(), &fresh)
                .map_err(EngineError::Contract)?;
            return Ok(fresh);
        }

        let mut rows = journal_from_plan(windows);
        let window_len = rows[0].end_offset.map(|e| e - rows[0].start_offset + 1);
        let written = match window_len {
            Some(len) => part_len.min(len),
            None => part_len, // open-ended window: keep everything the file has
        };
        rows[0].written_bytes = written;
        rows[0].status = if written > 0 {
            "downloading".into()
        } else {
            "pending".into()
        };
        if written > 0 {
            tracing::info!(job = %job.id, written, "migrated v1 part into segment journal");
        }
        self.store
            .replace_segments(job.id.as_str(), &rows)
            .map_err(EngineError::Contract)?;
        Ok(rows)
    }

    /// Phase 7 recovery cycle for a failed/paused/canceled job: re-acquire the current
    /// source, revalidate the part's provenance with multiple signals, rebind the job to
    /// the source, and requeue it so the next run fills only the missing ranges.
    ///
    /// All probe/revalidation outcomes are persisted and emitted; the method returns Ok(())
    /// even when the source is still dead (the job then carries the classified error code —
    /// `source_gone` / `source_forbidden` / `network_error` / `http_error` — for the UI to
    /// act on). Only storage/IO faults propagate as Err.
    pub async fn recover(&self, job: &mut DownloadJob) -> Result<(), EngineError> {
        // Fail-closed proxy resolution (v1.4): an unavailable profile pauses the recovery
        // cycle with an actionable code instead of probing direct (which would leak the IP).
        let client = match self.client_for_job(job) {
            Ok(c) => c,
            Err(cerr) if cerr.code == ErrorCode::ProxyProfileNotFound => {
                tracing::warn!(job = %job.id, error = %cerr, "recovery paused: proxy unavailable");
                job.status = "paused".into();
                job.error_code = Some(cerr.code.as_str().into());
                job.speed_bps = None;
                job.eta_seconds = None;
                touch(job);
                let _ = self.store.update_job(job);
                self.emit_job(job);
                return Ok(());
            }
            Err(e) => return Err(EngineError::Contract(e)),
        };

        job.status = "probing".into();
        job.speed_bps = None;
        job.eta_seconds = None;
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);

        let probe = match self.probe(job, &client).await {
            Ok(probe) => probe,
            Err(err) => {
                let cerr = err.to_contract();
                tracing::warn!(job = %job.id, error = %cerr, "recovery probe failed");
                set_error(job, &cerr);
                let _ = self.store.update_job(job);
                self.emit_job(job);
                return Ok(());
            }
        };

        // The part's provenance is the persisted job row (Phase 6 discipline: validators
        // are persisted before segments start, so the row describes what is on disk).
        let part_signals = SourceSignals::new(
            job.total_bytes,
            job.etag.clone(),
            job.last_modified.clone(),
            job.content_type.clone(),
        );
        let fresh_signals = SourceSignals::new(
            probe.total_bytes,
            probe.etag.clone(),
            probe.last_modified.clone(),
            probe.content_type.clone(),
        );
        // A previously failed checksum verdict means the on-disk bytes are KNOWN bad:
        // no signal can rehabilitate them, so force the clean-restart path.
        let bytes_known_bad =
            job.error_code.as_deref() == Some(ErrorCode::ChecksumMismatch.as_str());
        let verdict = if bytes_known_bad {
            RevalidateVerdict::Restart
        } else {
            revalidate(
                &part_signals,
                &fresh_signals,
                job.checksum_expected.is_some(),
            )
        };
        tracing::info!(job = %job.id, verdict = ?verdict, "recovery revalidation");

        match verdict {
            RevalidateVerdict::Identical | RevalidateVerdict::ChecksumArbitrated => {
                self.rebind(job, probe, false).await?;
            }
            RevalidateVerdict::Restart => {
                // The representation changed (or the bytes are known bad): wipe journal +
                // part, then rebind onto the fresh source so the next run starts clean.
                self.store.delete_segments(job.id.as_str())?;
                if let Some(path) = job.destination_path.clone() {
                    let part = PathBuf::from(format!("{path}.part"));
                    let file = OpenOptions::new()
                        .create(true)
                        .truncate(false)
                        .write(true)
                        .open(&part)
                        .await
                        .map_err(EngineError::Io)?;
                    file.set_len(0).await.map_err(EngineError::Io)?;
                    drop(file);
                }
                job.received_bytes = 0;
                self.rebind(job, probe, true).await?;
            }
        }
        Ok(())
    }

    /// Rebind the job onto a freshly probed source: persist the new signals, stamp the
    /// recovery audit trail, clear the error and requeue. `wiped` additionally clears the
    /// completion-checksum artifacts of a discarded part.
    async fn rebind(
        &self,
        job: &mut DownloadJob,
        probe: Probe,
        wiped: bool,
    ) -> Result<(), EngineError> {
        job.total_bytes = probe.total_bytes;
        job.etag = probe.etag;
        job.last_modified = probe.last_modified;
        job.content_type = probe.content_type;
        job.recovery_count = Some(job.recovery_count.unwrap_or(0) + 1);
        job.rebound_at = Some(now_ms());
        job.status = "queued".into();
        job.error_code = None;
        job.speed_bps = None;
        job.eta_seconds = None;
        if wiped {
            job.checksum_actual = None;
            job.checksum_verified = None;
        }
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);
        Ok(())
    }

    /// Spawn the throttled progress ticker for one run; returns its join handle.
    fn spawn_ticker(
        &self,
        job_id: String,
        total: Option<u64>,
        received: Arc<AtomicU64>,
        stop: CancellationToken,
    ) -> tokio::task::JoinHandle<()> {
        let store = self.store.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            let mut last_tick = Instant::now();
            let mut last_bytes = received.load(Ordering::SeqCst);
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tokio::time::sleep(PROGRESS_INTERVAL) => {
                        let now_bytes = received.load(Ordering::SeqCst);
                        let dt = last_tick.elapsed().as_secs_f64().max(0.001);
                        let speed = ((now_bytes.saturating_sub(last_bytes)) as f64 / dt) as u64;
                        let eta = match (total, speed) {
                            (Some(t), s) if s > 0 && t > now_bytes => Some((t - now_bytes) / s),
                            _ => None,
                        };
                        let _ = store.update_progress(&job_id, now_bytes, speed, eta);
                        let _ = events.send(EventEnvelope {
                            v: dc_protocol::PROTOCOL_VERSION,
                            event: "download.progress".into(),
                            payload: Some(serde_json::json!({
                                "jobId": job_id,
                                "receivedBytes": now_bytes,
                                "totalBytes": total,
                                "speedBps": speed,
                                "etaSeconds": eta,
                            })),
                        });
                        last_tick = Instant::now();
                        last_bytes = now_bytes;
                    }
                }
            }
        })
    }

    /// Completion: size check → SHA-256 pass → expected-checksum verdict → fsync → rename.
    async fn complete(
        &self,
        job: &mut DownloadJob,
        state: &RunState,
        part_path: &Path,
        offset_mode: bool,
    ) -> Result<(), EngineError> {
        let received = state.received.load(Ordering::SeqCst);
        job.received_bytes = received;

        if offset_mode {
            if let Some(total) = job.total_bytes {
                if received != total {
                    return Err(EngineError::Contract(ContractError::new(
                        ErrorCode::InternalError,
                        format!("segmented size mismatch: {received} of {total}"),
                    )));
                }
            }
        }

        // Streaming SHA-256 over the finished part file.
        let mut file = tokio::fs::File::open(part_path)
            .await
            .map_err(EngineError::Io)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; HASH_CHUNK];
        loop {
            let n = file.read(&mut buf).await.map_err(EngineError::Io)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        drop(file);
        let digest = to_hex(&hasher.finalize());
        job.checksum_actual = Some(digest);

        if let Some(expected) = job.checksum_expected.clone() {
            let matches =
                expected.to_lowercase() == *job.checksum_actual.clone().unwrap_or_default();
            job.checksum_verified = Some(matches);
            if !matches {
                job.status = "failed".into();
                job.error_code = Some(ErrorCode::ChecksumMismatch.as_str().into());
                job.speed_bps = None;
                job.eta_seconds = None;
                touch(job);
                self.store.update_job(job)?;
                self.emit_job(job);
                tracing::warn!(job = %job.id, "checksum mismatch — part kept for inspection");
                return Ok(());
            }
        }

        // fsync before the atomic rename (completion must be durable before visible).
        let file = OpenOptions::new()
            .write(true)
            .open(part_path)
            .await
            .map_err(EngineError::Io)?;
        file.sync_all().await.map_err(EngineError::Io)?;
        drop(file);

        let final_path = PathBuf::from(job.destination_path.clone().unwrap_or_default());
        let target = if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
            uniquify(&final_path).await
        } else {
            final_path
        };
        tokio::fs::rename(part_path, &target)
            .await
            .map_err(EngineError::Io)?;
        job.destination_path = Some(target.display().to_string());
        job.status = "completed".into();
        job.speed_bps = None;
        job.eta_seconds = None;
        if let Some(total) = job.total_bytes {
            job.received_bytes = total.max(job.received_bytes);
        }
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);
        Ok(())
    }

    /// One segment task: fetch its window with resume + integrity guards.
    #[allow(clippy::too_many_arguments)]
    async fn run_segment(
        store: Arc<JobStore>,
        client: reqwest::Client,
        job: DownloadJob,
        seg_index: usize,
        window: Window,
        row: SegmentRow,
        part_path: PathBuf,
        if_range: Option<String>,
        state: Arc<RunState>,
        stop: CancellationToken,
        global_bucket: Arc<Bucket>,
        job_bucket: Arc<Bucket>,
    ) -> Result<SegmentOutcome, EngineError> {
        let mut written = row.written_bytes;
        let mut attempts = 0usize;
        let open_ended = window.end.is_none();

        loop {
            if state.restart.load(Ordering::SeqCst) {
                return Ok(SegmentOutcome::Restart);
            }

            // Window already satisfied?
            if let Some(len) = window.byte_len() {
                if written >= len {
                    // Mark done in the journal too (e.g. migrated/already-fetched windows).
                    let _ = store.update_segment_progress(
                        job.id.as_str(),
                        seg_index as u64,
                        written,
                        "done",
                    );
                    return Ok(SegmentOutcome::Done);
                }
            }

            let (req_start, remaining) = match window.end {
                Some(end) => {
                    let win_len = end - window.start + 1;
                    (window.start + written, win_len - written)
                }
                None => (window.start + written, u64::MAX),
            };
            let ranged = window.end.is_some() || written > 0;

            let mut request = client.get(&job.url);
            if let Some(headers) = &job.headers {
                for (k, v) in headers {
                    request = request.header(k, v);
                }
            }
            if ranged {
                let range = match window.end {
                    Some(end) => format!("bytes={req_start}-{end}"),
                    None => format!("bytes={req_start}-"),
                };
                request = request.header(reqwest::header::RANGE, range);
                if let Some(v) = &if_range {
                    request = request.header(reqwest::header::IF_RANGE, v);
                }
            }

            let response = match request.send().await {
                Ok(r) => r,
                Err(err) => {
                    attempts += 1;
                    flush_segment_cursor(&store, &job, seg_index, written);
                    if attempts > MAX_SEGMENT_ATTEMPTS {
                        return Err(EngineError::Http(err));
                    }
                    backoff_sleep(attempts).await;
                    continue;
                }
            };
            let status = response.status();

            // Shared streaming block after the per-status validation below.
            enum Fetch {
                /// Bounded window write (206): cap at `remaining`.
                Window,
                /// Open-ended append (200 fresh / 206 open): stream until EOF.
                Append,
            }

            let fetch: Fetch = if status == reqwest::StatusCode::PARTIAL_CONTENT {
                // Integrity gate: the answer must start exactly where we asked.
                let headers = response.headers().clone();
                let Some((cr_start, cr_total)) = headers
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range)
                else {
                    return Err(EngineError::Contract(ContractError::new(
                        ErrorCode::HttpError,
                        "206 without a parseable Content-Range",
                    )));
                };
                if cr_start != req_start {
                    return Err(EngineError::Contract(ContractError::new(
                        ErrorCode::HttpError,
                        format!(
                            "Content-Range start {cr_start} does not match requested {req_start}"
                        ),
                    )));
                }
                if let (Some(job_total), Some(cr_total)) = (job.total_bytes, cr_total) {
                    if cr_total != job_total {
                        // The representation changed size under us → clean restart.
                        state.restart.store(true, Ordering::SeqCst);
                        return Ok(SegmentOutcome::Restart);
                    }
                }
                if open_ended {
                    Fetch::Append
                } else {
                    Fetch::Window
                }
            } else if status == reqwest::StatusCode::OK {
                if ranged {
                    // If-Range mismatch (or a Range-ignoring server): the source changed
                    // under a part that came from a different representation.
                    state.restart.store(true, Ordering::SeqCst);
                    return Ok(SegmentOutcome::Restart);
                }
                Fetch::Append
            } else if status.as_u16() == 416 {
                return Err(EngineError::Contract(ContractError::new(
                    ErrorCode::RangeNotSatisfiable,
                    format!("segment request rejected with HTTP 416 (start {req_start})"),
                )));
            } else if status.is_server_error() {
                attempts += 1;
                flush_segment_cursor(&store, &job, seg_index, written);
                if attempts > MAX_SEGMENT_ATTEMPTS {
                    return Err(EngineError::Contract(
                        ContractError::new(
                            ErrorCode::HttpError,
                            format!("segment failed with HTTP {status}"),
                        )
                        .with_data(serde_json::json!({ "status": status.as_u16() })),
                    ));
                }
                backoff_sleep(attempts).await;
                continue;
            } else {
                return Err(EngineError::Contract(
                    ContractError::new(
                        ErrorCode::HttpError,
                        format!("unexpected HTTP status {status}"),
                    )
                    .with_data(serde_json::json!({ "status": status.as_u16() })),
                ));
            };

            let is_window_fetch = matches!(fetch, Fetch::Window);

            let mut stream = response.bytes_stream();
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .read(true)
                .open(&part_path)
                .await
                .map_err(EngineError::Io)?;
            file.seek(SeekFrom::Start(req_start))
                .await
                .map_err(EngineError::Io)?;

            let mut left = remaining;
            let mut since_flush = 0u64;
            let mut stream_error: Option<reqwest::Error> = None;
            let mut ended_at_eof = false;
            while left > 0 {
                let next = tokio::select! {
                    _ = stop.cancelled() => {
                        drop(file);
                        flush_segment_cursor(&store, &job, seg_index, written);
                        return Ok(SegmentOutcome::Stopped);
                    }
                    chunk = stream.next() => chunk,
                };
                match next {
                    Some(Ok(bytes)) => {
                        let take = (bytes.len() as u64).min(left) as usize;
                        // Bandwidth gates (Phase 8): both the global and the per-job
                        // bucket must grant the chunk before it touches the disk.
                        // Cancellation-aware — a stop during the wait unwinds cleanly.
                        let granted = tokio::select! {
                            _ = stop.cancelled() => false,
                            g = global_bucket.acquire(take as u64, &stop) => g,
                        } && tokio::select! {
                            _ = stop.cancelled() => false,
                            g = job_bucket.acquire(take as u64, &stop) => g,
                        };
                        if !granted {
                            drop(file);
                            flush_segment_cursor(&store, &job, seg_index, written);
                            return Ok(SegmentOutcome::Stopped);
                        }
                        file.write_all(&bytes[..take])
                            .await
                            .map_err(EngineError::Io)?;
                        written += take as u64;
                        left -= take as u64;
                        state.received.fetch_add(take as u64, Ordering::SeqCst);
                        *state
                            .cursors
                            .lock()
                            .expect("cursors mutex poisoned")
                            .get_mut(seg_index)
                            .expect("cursor slot") = written;
                        since_flush += take as u64;
                        if take < bytes.len() || left == 0 {
                            // Window cap reached — surplus bytes are dropped on purpose.
                            break;
                        }
                        if since_flush >= JOURNAL_FLUSH_BYTES {
                            file.flush().await.map_err(EngineError::Io)?;
                            flush_segment_cursor(&store, &job, seg_index, written);
                            since_flush = 0;
                        }
                    }
                    Some(Err(err)) => {
                        stream_error = Some(err);
                        break;
                    }
                    None => {
                        ended_at_eof = true;
                        break;
                    }
                }
            }
            file.flush().await.map_err(EngineError::Io)?;
            drop(file);

            if state.restart.load(Ordering::SeqCst) {
                return Ok(SegmentOutcome::Restart);
            }

            // Window satisfied when: cap hit (left == 0) or, for an open-ended window,
            // the server closed the stream (EOF is the natural end).
            if left == 0 || (open_ended && ended_at_eof) {
                let _ = store.update_segment_progress(
                    job.id.as_str(),
                    seg_index as u64,
                    written,
                    "done",
                );
                return Ok(SegmentOutcome::Done);
            }

            // Short stream / transient failure: bounded retry.
            attempts += 1;
            flush_segment_cursor(&store, &job, seg_index, written);
            if let Some(err) = stream_error {
                if attempts > MAX_SEGMENT_ATTEMPTS {
                    return Err(EngineError::Http(err));
                }
            } else if attempts > MAX_SEGMENT_ATTEMPTS {
                if is_window_fetch {
                    return Err(EngineError::Contract(ContractError::new(
                        ErrorCode::NetworkError,
                        "segment stream ended before the window was filled",
                    )));
                }
                return Ok(SegmentOutcome::Done); // open-ended EOF handled above; defensive
            }
            backoff_sleep(attempts).await;
        }
    }

    async fn probe(
        &self,
        job: &DownloadJob,
        client: &reqwest::Client,
    ) -> Result<Probe, EngineError> {
        let mut request = client
            .get(&job.url)
            .header(reqwest::header::RANGE, "bytes=0-0");
        if let Some(headers) = &job.headers {
            for (k, v) in headers {
                request = request.header(k, v);
            }
        }
        let response = request.send().await.map_err(EngineError::Http)?;
        let status = response.status();
        let headers = response.headers().clone();
        let _unused = response.bytes().await.map_err(EngineError::Http)?;

        let get = |name: reqwest::header::HeaderName| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(String::from)
        };

        let etag = get(reqwest::header::ETAG);
        let last_modified = get(reqwest::header::LAST_MODIFIED);
        let content_type = get(reqwest::header::CONTENT_TYPE);
        let filename_hint =
            get(reqwest::header::CONTENT_DISPOSITION).and_then(|v| parse_content_disposition(&v));
        let accept_ranges = headers
            .get(reqwest::header::ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .unwrap_or(false);

        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            Ok(Probe {
                total_bytes: get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| parse_total_from_content_range(&v)),
                etag,
                last_modified,
                content_type,
                ranges_supported: true,
                filename_hint,
            })
        } else if status == reqwest::StatusCode::OK {
            Ok(Probe {
                total_bytes: get(reqwest::header::CONTENT_LENGTH).and_then(|v| v.parse().ok()),
                etag,
                last_modified,
                content_type,
                ranges_supported: accept_ranges,
                filename_hint,
            })
        } else {
            Err(EngineError::Contract(
                ContractError::new(
                    if status.as_u16() == 416 {
                        ErrorCode::RangeNotSatisfiable
                    } else {
                        // Phase 7: dead/expired or unauthorized sources classify into
                        // recoverable, actionable codes instead of a generic http_error.
                        classify_source_failure(status.as_u16())
                    },
                    format!("probe failed with HTTP {status}"),
                )
                .with_data(serde_json::json!({ "status": status.as_u16() })),
            ))
        }
    }
}

async fn backoff_sleep(attempt: usize) {
    tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS * attempt as u64)).await;
}

/// Durable journal cursor for one segment. Callers invoke this AFTER the bytes reached the
/// OS, so the journal can never lead the file.
fn flush_segment_cursor(store: &Arc<JobStore>, job: &DownloadJob, seg_index: usize, written: u64) {
    let _ =
        store.update_segment_progress(job.id.as_str(), seg_index as u64, written, "downloading");
}

fn filename_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let segments: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    let last = segments.last()?;
    if last.is_empty() {
        None
    } else {
        Some((*last).to_string())
    }
}

fn sanitize_filename(name: &str) -> String {
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
        "download.bin".into()
    } else {
        trimmed.into()
    }
}

fn part_file(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

pub async fn uniquify(candidate: &Path) -> PathBuf {
    if !tokio::fs::try_exists(candidate).await.unwrap_or(false) {
        return candidate.to_path_buf();
    }
    let stem = candidate
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let ext = candidate
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()));
    let dir = candidate
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    for n in 2..=9999 {
        let name = match &ext {
            Some(ext) => format!("{stem} ({n}){ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(name);
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }
    candidate.to_path_buf()
}

fn parse_total_from_content_range(value: &str) -> Option<u64> {
    let total = value.rsplit('/').next()?;
    if total == "*" {
        None
    } else {
        total.parse().ok()
    }
}

/// Parse `bytes {start}-{end}/{total}` → (start, Option<total>); total None for `*`.
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let start = range.split('-').next()?.trim().parse().ok()?;
    let total = if total.trim() == "*" {
        None
    } else {
        Some(total.trim().parse().ok()?)
    };
    Some((start, total))
}

fn parse_content_disposition(value: &str) -> Option<String> {
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            let name = rest.split("''").nth(1).unwrap_or(rest);
            return percent_decode(name);
        }
        if let Some(rest) = part.strip_prefix("filename=") {
            return percent_decode(rest.trim_matches('"'));
        }
    }
    None
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (*bytes.get(i + 1)? as char).to_digit(16)?;
            let lo = (*bytes.get(i + 2)? as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_total_parsing() {
        assert_eq!(
            parse_total_from_content_range("bytes 0-0/12345"),
            Some(12345)
        );
        assert_eq!(parse_total_from_content_range("bytes 0-0/*"), None);
    }

    #[test]
    fn content_range_start_total_parsing() {
        assert_eq!(
            parse_content_range("bytes 100-999/12345"),
            Some((100, Some(12345)))
        );
        assert_eq!(parse_content_range("bytes 0-0/*"), Some((0, None)));
        assert_eq!(parse_content_range("garbage"), None);
    }

    #[test]
    fn content_disposition_parsing() {
        assert_eq!(
            parse_content_disposition("attachment; filename=\"setup.zip\"").as_deref(),
            Some("setup.zip")
        );
        assert_eq!(
            parse_content_disposition("attachment; filename*=UTF-8''%D9%81%D8%A7%DB%8C%D9%84.zip")
                .as_deref(),
            Some("فایل.zip")
        );
    }

    #[test]
    fn part_file_naming() {
        assert_eq!(
            part_file(Path::new("/tmp/a.zip")),
            PathBuf::from("/tmp/a.zip.part")
        );
    }

    #[test]
    fn sanitize_keeps_paths_safe() {
        assert_eq!(sanitize_filename("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_filename(""), "download.bin");
        assert_eq!(sanitize_filename(".."), "download.bin");
    }
}
