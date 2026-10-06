//! Resumable download engine — one task per active job.
//!
//! Resume safety (data integrity outranks everything):
//!  - probe with `Range: bytes=0-0` captures size/validators/accept-ranges;
//!  - resume sends `Range: bytes=N-` **with** `If-Range: <validator>`; a 200 answer means the
//!    source changed → the part file is truncated and the job restarts from zero instead of
//!    producing a corrupt hybrid file;
//!  - validators (ETag / Last-Modified) and the header set persist in the DB across runs;
//!  - completion fsyncs the file before the atomic `.part` → final rename.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dc_protocol::job::DownloadJob;
use dc_protocol::{new_ulid, ContractError, ErrorCode, EventEnvelope};
use dc_storage::JobStore;
use futures_util::StreamExt;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

pub type EventsTx = mpsc::UnboundedSender<EventEnvelope>;

#[derive(Debug, Clone)]
pub struct CreateJobParams {
    pub url: String,
    pub destination_dir: String,
    pub filename: Option<String>,
    pub overwrite: bool,
    pub headers: Option<HashMap<String, String>>,
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
    fn to_contract(&self) -> ContractError {
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

pub struct Engine {
    pub store: Arc<JobStore>,
    pub client: reqwest::Client,
    pub events: EventsTx,
}

impl Engine {
    pub fn new(store: Arc<JobStore>, events: EventsTx) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(concat!("UniDM/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client builds");
        Self {
            store,
            client,
            events,
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
            created_at: ts,
            updated_at: ts,
        };
        self.store.insert_job(&job)?;
        Ok(job)
    }

    /// The per-job task: probe → download loop. Runs until terminal/paused or stop token.
    pub async fn run_job(
        self: Arc<Self>,
        mut job: DownloadJob,
        mut cmd_rx: mpsc::Receiver<JobCommand>,
        stop: CancellationToken,
    ) {
        match self.drive(&mut job, &mut cmd_rx, &stop).await {
            Ok(()) => {}
            Err(err) => {
                if !stop.is_cancelled() {
                    let cerr = err.to_contract();
                    tracing::warn!(job = %job.id, error = %cerr, "job failed");
                    set_error(&mut job, &cerr);
                    if self.store.update_job(&job).is_ok() {
                        self.emit_job(&job);
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
    ) -> Result<(), EngineError> {
        // Resume safety: If-Range must carry the validators of the SOURCE THE PART CAME FROM
        // (persisted before this run), never the freshly probed ones — otherwise a changed
        // source would answer 206 against the new validator and the part would be spliced
        // with foreign bytes. A mismatch then yields 200 → restart from zero below.
        // Capture them BEFORE the probe overwrites job.etag/last_modified.
        let part_etag = job.etag.clone();
        let part_last_modified = job.last_modified.clone();

        // ---- probing ----
        job.status = "probing".into();
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);

        let probe = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            r = self.probe(job) => r?,
        };

        // ---- destination resolution ----
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

        // ---- download ----
        job.status = "downloading".into();
        touch(job);
        self.store.update_job(job)?;
        self.emit_job(job);

        let received_start = match tokio::fs::metadata(&part_path).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };
        job.received_bytes = received_start;

        let mut request = self.client.get(&job.url);
        if let Some(headers) = &job.headers {
            for (k, v) in headers {
                request = request.header(k, v);
            }
        }
        if received_start > 0 && probe.ranges_supported {
            request = request.header(reqwest::header::RANGE, format!("bytes={received_start}-"));
            if let Some(etag) = &part_etag {
                request = request.header(reqwest::header::IF_RANGE, etag);
            } else if let Some(lm) = &part_last_modified {
                request = request.header(reqwest::header::IF_RANGE, lm);
            }
        }

        let response = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            r = request.send() => r.map_err(EngineError::Http)?,
        };
        let status = response.status();
        let headers = response.headers().clone();
        let mut stream = response.bytes_stream();

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .open(&part_path)
            .await
            .map_err(EngineError::Io)?;

        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            file.seek(SeekFrom::End(0)).await.map_err(EngineError::Io)?;
            if let Some(total) = headers
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_total_from_content_range)
            {
                job.total_bytes = Some(total);
            }
        } else if status == reqwest::StatusCode::OK {
            // 200 after a ranged request ⇒ source changed (If-Range mismatch) ⇒ integrity
            // policy: discard the stale part and restart from zero rather than corrupting.
            if received_start > 0 && probe.ranges_supported {
                tracing::info!(job = %job.id, "source changed (If-Range mismatch) — restarting from zero");
            }
            file.set_len(0).await.map_err(EngineError::Io)?;
            job.received_bytes = 0;
            if let Some(len) = headers
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
            {
                job.total_bytes = Some(len);
            }
        } else {
            let code = if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
                ErrorCode::RangeNotSatisfiable
            } else {
                ErrorCode::HttpError
            };
            return Err(EngineError::Contract(
                ContractError::new(code, format!("unexpected HTTP status {status}"))
                    .with_data(serde_json::json!({ "status": status.as_u16() })),
            ));
        }
        self.store.update_job(job)?;

        let mut last_tick = Instant::now();
        let mut last_bytes = job.received_bytes;

        loop {
            tokio::select! {
                _ = stop.cancelled() => {
                    file.flush().await.ok();
                    return Ok(());
                }
                cmd = cmd_rx.recv() => {
                    file.flush().await.ok();
                    match cmd {
                        Some(JobCommand::Pause) => {
                            job.status = "paused".into();
                            job.speed_bps = None;
                            job.eta_seconds = None;
                            touch(job);
                            self.store.update_job(job)?;
                            self.emit_job(job);
                            return Ok(());
                        }
                        Some(JobCommand::Cancel) => {
                            job.status = "canceled".into();
                            job.speed_bps = None;
                            job.eta_seconds = None;
                            touch(job);
                            self.store.update_job(job)?;
                            self.emit_job(job);
                            return Ok(());
                        }
                        None => return Ok(()),
                    }
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            file.write_all(&bytes).await.map_err(EngineError::Io)?;
                            job.received_bytes += bytes.len() as u64;

                            if last_tick.elapsed() >= PROGRESS_INTERVAL {
                                let dt = last_tick.elapsed().as_secs_f64().max(0.001);
                                let speed = ((job.received_bytes - last_bytes) as f64 / dt) as u64;
                                job.speed_bps = Some(speed);
                                job.eta_seconds = match (job.total_bytes, speed) {
                                    (Some(total), s) if s > 0 && total > job.received_bytes => {
                                        Some((total - job.received_bytes) / s)
                                    }
                                    _ => None,
                                };
                                last_tick = Instant::now();
                                last_bytes = job.received_bytes;
                                let _ = self.store.update_progress(
                                    job.id.as_str(),
                                    job.received_bytes,
                                    speed,
                                    job.eta_seconds,
                                );
                                self.emit_progress(job);
                            }
                        }
                        Some(Err(e)) => return Err(EngineError::Http(e)),
                        None => {
                            // stream complete — flush, fsync, atomic rename
                            file.flush().await.map_err(EngineError::Io)?;
                            file.sync_all().await.map_err(EngineError::Io)?;
                            drop(file);

                            let final_path = PathBuf::from(job.destination_path.clone().unwrap_or_default());
                            let target = if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
                                uniquify(&final_path).await
                            } else {
                                final_path
                            };
                            tokio::fs::rename(&part_path, &target).await.map_err(EngineError::Io)?;
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
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    async fn probe(&self, job: &DownloadJob) -> Result<Probe, EngineError> {
        let mut request = self
            .client
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
                        ErrorCode::HttpError
                    },
                    format!("probe failed with HTTP {status}"),
                )
                .with_data(serde_json::json!({ "status": status.as_u16() })),
            ))
        }
    }
}

fn filename_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let last = parsed
        .path_segments()?
        .filter(|s| !s.is_empty())
        .last()?
        .to_string();
    if last.is_empty() {
        None
    } else {
        Some(last)
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
