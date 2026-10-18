//! JSONL RPC server over stdio.
//!
//! One JSON message per line. Requests arrive on stdin; responses and events leave on stdout
//! (all stdout traffic goes through a single writer task — logs go to stderr only).

use std::sync::Arc;

use dc_protocol::job::DownloadJob;
use dc_protocol::{
    make_error, make_success, ContractError, ErrorCode, RequestEnvelope, ResponseEnvelope,
    CONTRACT_VERSION, PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::engine::{ChecksumSpec, CreateJobParams};
use crate::manager::{JobManager, QueueDirection, SetPolicyParams};
use crate::segments::normalize_expected;
use dc_protocol::ChecksumAlgorithm;

#[derive(Deserialize)]
struct JobIdParams {
    id: String,
}

#[derive(Deserialize)]
struct ReplaceUrlParams {
    id: String,
    url: String,
}

#[derive(Deserialize)]
struct RemoveParams {
    id: String,
    #[serde(default)]
    delete_partial_file: bool,
}

#[derive(Deserialize)]
struct ChecksumParams {
    algorithm: ChecksumAlgorithm,
    value: String,
}

#[derive(Deserialize)]
struct CreateParams {
    url: String,
    #[serde(rename = "destinationDir")]
    destination_dir: String,
    filename: Option<String>,
    #[serde(default)]
    overwrite: bool,
    headers: Option<std::collections::HashMap<String, String>>,
    checksum: Option<ChecksumParams>,
    #[serde(rename = "proxyProfileId", default)]
    proxy_profile_id: Option<String>,
}

#[derive(Deserialize)]
struct SetConcurrencyParams {
    max: usize,
    #[serde(rename = "maxConnectionsPerDownload")]
    max_connections_per_download: Option<usize>,
}

#[derive(Deserialize)]
struct QueueMoveParams {
    id: String,
    direction: QueueDirection,
}

#[derive(Deserialize)]
struct SetSpeedLimitParams {
    id: String,
    kbps: u64,
}

#[derive(Deserialize)]
struct SetProxyParams {
    id: String,
    #[serde(rename = "proxyProfileId")]
    proxy_profile_id: Option<String>,
}

#[derive(Deserialize)]
struct SetRuntimeParams {
    profiles: Vec<crate::proxy::RuntimeProxy>,
}

#[derive(Deserialize)]
struct TestProxyParams {
    #[serde(rename = "profileId")]
    profile_id: String,
    url: Option<String>,
}

pub type OutboundTx = mpsc::UnboundedSender<String>;

/// Phase 24 hardening (F-1): request framing limits.
///
/// A single stdin line carries exactly one JSON request. Legitimate requests (URL lists,
/// checksum manifests, job rows) stay orders of magnitude below `MAX_LINE_BYTES`; anything
/// larger is a bug or an attack and is answered with a bounded `parse_error` instead of
/// being buffered into memory. `MAX_INFLIGHT_REQUESTS` bounds the tasks spawned per
/// request: the read loop stalls on the semaphore (natural backpressure) instead of
/// letting a flood allocate unbounded futures.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_INFLIGHT_REQUESTS: usize = 64;

/// Outcome of one bounded framing read: a request line, a framing violation (oversized or
/// not valid UTF-8 — never echoed back), or a clean EOF.
enum FramedLine {
    Line(String),
    Violated(&'static str),
    Eof,
}

/// Read one `\n`-terminated line, bounding buffered bytes at `max`. A line that outgrows
/// the limit is drained (consumed through its newline) but never buffered, so the stream
/// stays framed and subsequent requests keep working.
async fn read_framed_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> tokio::io::Result<FramedLine> {
    let mut buf: Vec<u8> = Vec::new();
    let mut violation: Option<&'static str> = None;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            break;
        }
        if let Some(nl) = chunk.iter().position(|&b| b == b'\n') {
            if violation.is_none() {
                buf.extend_from_slice(&chunk[..nl]);
            }
            reader.consume(nl + 1);
            return Ok(match violation {
                Some(why) => FramedLine::Violated(why),
                None => match String::from_utf8(buf) {
                    Ok(line) => FramedLine::Line(line),
                    Err(_) => FramedLine::Violated("request line is not valid UTF-8"),
                },
            });
        }
        let n = chunk.len();
        if violation.is_none() {
            buf.extend_from_slice(chunk);
            if buf.len() > max {
                violation = Some("request line exceeds the framing limit");
                buf.clear(); // never buffer what we will not parse
            }
        }
        reader.consume(n);
    }
    Ok(match (buf.is_empty(), violation) {
        (true, None) => FramedLine::Eof,
        (_, Some(why)) => FramedLine::Violated(why),
        // EOF without a trailing newline: still try to parse the trailing bytes.
        (false, None) => match String::from_utf8(buf) {
            Ok(line) => FramedLine::Line(line),
            Err(_) => FramedLine::Violated("request line is not valid UTF-8"),
        },
    })
}

/// Serve requests from `stdin` until EOF. Responses are written through `outbound` — the
/// caller owns the writer task, which also carries engine events (single-writer principle).
pub async fn serve(
    stdin: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    manager: Arc<JobManager>,
    outbound: OutboundTx,
) {
    let tx = outbound;
    let mut reader = BufReader::new(stdin);
    let inflight = Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_REQUESTS));
    loop {
        match read_framed_line(&mut reader, MAX_LINE_BYTES).await {
            Err(_) => break, // stdin read failure: treat as EOF, same teardown path
            Ok(FramedLine::Eof) => break,
            Ok(FramedLine::Violated(why)) => {
                // Bounded refusal — the framing violation itself is never echoed.
                let error = ResponseEnvelope::Error(make_error(
                    "unknown",
                    ContractError::new(ErrorCode::ParseError, why),
                ));
                if let Ok(mut json) = serde_json::to_string(&error) {
                    json.push('\n');
                    let _ = tx.send(json);
                }
                continue;
            }
            Ok(FramedLine::Line(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                // Phase 24: bounded in-flight requests — acquire before spawning.
                let permit = match inflight.clone().acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => continue, // semaphore closed only on teardown
                };
                let manager = manager.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let raw: Result<Value, _> = serde_json::from_str(&line);
                    let response = match raw {
                        Err(e) => {
                            // No envelope → no id; parse_error with a synthetic id.
                            ResponseEnvelope::Error(make_error(
                                "unknown",
                                ContractError::new(ErrorCode::ParseError, format!("{e}")),
                            ))
                        }
                        Ok(value) => {
                            let request = serde_json::from_value::<RequestEnvelope>(value);
                            match request {
                                Err(_) => ResponseEnvelope::Error(make_error(
                                    id_of(&line),
                                    ContractError::new(
                                        ErrorCode::ParseError,
                                        "malformed request envelope",
                                    ),
                                )),
                                Ok(req) => handle(req, manager).await,
                            }
                        }
                    };
                    let json = match response {
                        ResponseEnvelope::Success(s) => serde_json::to_string(&s),
                        ResponseEnvelope::Error(e) => serde_json::to_string(&e),
                    };
                    if let Ok(mut json) = json {
                        json.push('\n');
                        let _ = tx.send(json);
                    }
                });
            }
        }
    }

    // stdin EOF: persist job state; the caller owns the writer lifecycle.
    manager.shutdown().await;
}

fn id_of(line: &str) -> String {
    serde_json::from_str::<RequestEnvelope>(line)
        .map(|r| r.id)
        .unwrap_or_else(|_| "unknown".into())
}

async fn handle(req: RequestEnvelope, manager: Arc<JobManager>) -> ResponseEnvelope {
    if req.v != PROTOCOL_VERSION {
        return ResponseEnvelope::Error(make_error(
            req.id,
            ContractError::new(
                ErrorCode::UnsupportedVersion,
                format!("protocol version {} unsupported", req.v),
            ),
        ));
    }

    let result = dispatch(&req, manager).await;
    match result {
        Ok(value) => ResponseEnvelope::Success(make_success(req.id, value)),
        Err(err) => ResponseEnvelope::Error(make_error(req.id, err)),
    }
}

async fn dispatch(req: &RequestEnvelope, manager: Arc<JobManager>) -> Result<Value, ContractError> {
    let params = req.params.clone().unwrap_or_else(|| serde_json::json!({}));
    match req.method.as_str() {
        "core.ping" => Ok(serde_json::json!({
            "pong": true,
            "contractVersion": CONTRACT_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "now": crate::engine::now_ms(),
        })),
        "core.shutdown" => {
            manager.shutdown().await;
            Ok(serde_json::json!({ "ok": true }))
        }
        // ---- Phase 20: diagnostics (read-only health snapshot) ----
        "diagnostics.health" => {
            let health = manager.health_snapshot()?;
            serde_json::to_value(serde_json::json!({ "health": health })).map_err(|e| {
                ContractError::new(
                    ErrorCode::InternalError,
                    format!("serialize health snapshot: {e}"),
                )
            })
        }
        "download.setConcurrency" => {
            let p: SetConcurrencyParams = parse(&params)?;
            manager.set_max_concurrent(p.max);
            if let Some(per_job) = p.max_connections_per_download {
                manager.set_max_connections(per_job);
            }
            Ok(serde_json::json!({ "applied": true }))
        }
        "download.create" => {
            let p: CreateParams = parse(&params)?;
            let checksum = match p.checksum {
                Some(c) => {
                    // Boundary validation: hex + length must match the algorithm.
                    let value = normalize_expected(c.algorithm, &c.value)
                        .map_err(|msg| ContractError::new(ErrorCode::InvalidParams, msg))?;
                    Some(ChecksumSpec {
                        algorithm: c.algorithm,
                        value,
                    })
                }
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
            job_json(job)
        }
        "download.list" => {
            let jobs = manager.list()?;
            Ok(serde_json::json!({ "jobs": jobs }))
        }
        "download.get" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.get(&p.id)?;
            Ok(serde_json::json!({ "job": job }))
        }
        "download.pause" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.pause(&p.id).await?;
            job_json(job)
        }
        "download.resume" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.resume(&p.id).await?;
            job_json(job)
        }
        // ---- Phase 7: recovery engine ----
        "download.recover" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.recover(&p.id).await?;
            job_json(job)
        }
        "download.replaceUrl" => {
            let p: ReplaceUrlParams = parse(&params)?;
            let job = manager.replace_url(&p.id, p.url).await?;
            job_json(job)
        }
        "download.retry" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.retry(&p.id).await?;
            job_json(job)
        }
        // ---- Phase 8: queue management + bandwidth/scheduler policy ----
        "download.queueMove" => {
            let p: QueueMoveParams = parse(&params)?;
            let job = manager.queue_move(&p.id, p.direction)?;
            job_json(job)
        }
        "download.startAll" => {
            let started = manager.start_all().await?;
            Ok(serde_json::json!({ "started": started }))
        }
        "download.pauseAll" => {
            let paused = manager.pause_all().await?;
            Ok(serde_json::json!({ "paused": paused }))
        }
        "download.setSpeedLimit" => {
            let p: SetSpeedLimitParams = parse(&params)?;
            let job = manager.set_speed_limit(&p.id, p.kbps)?;
            job_json(job)
        }
        "download.setPolicy" => {
            let p: SetPolicyParams = parse(&params)?;
            manager.set_policy(p).await;
            Ok(serde_json::json!({ "applied": true }))
        }
        // ---- Phase 9: proxy routing ----
        "download.setProxy" => {
            let p: SetProxyParams = parse(&params)?;
            let job = manager.set_job_proxy(&p.id, p.proxy_profile_id)?;
            job_json(job)
        }
        "proxy.setRuntime" => {
            let p: SetRuntimeParams = parse(&params)?;
            manager.set_runtime_proxies(p.profiles);
            Ok(serde_json::json!({ "applied": true }))
        }
        "proxy.test" => {
            let p: TestProxyParams = parse(&params)?;
            let result = manager.test_proxy(&p.profile_id, p.url).await?;
            Ok(result)
        }
        // ---- Phase 10: bundled media toolkit paths ----
        "toolkit.setPaths" => {
            let p: dc_protocol::ToolkitSetPathsParams = parse(&params)?;
            manager.set_toolkit_paths(p.tools)?;
            Ok(serde_json::json!({ "applied": true }))
        }
        // ---- Phase 11: media inspector ----
        "media.inspect" => {
            let p: dc_protocol::MediaInspectParams = parse(&params)?;
            let result = manager.inspect_media(p).await?;
            serde_json::to_value(result).map_err(|e| {
                ContractError::new(ErrorCode::InternalError, format!("serialize manifest: {e}"))
            })
        }
        // ---- Phase 12: persistent media download & merge pipeline ----
        "media.download" => {
            let p: dc_protocol::MediaDownloadParams = parse(&params)?;
            let job = manager.media_download(p).await?;
            serde_json::to_value(dc_protocol::MediaDownloadResult { job }).map_err(|e| {
                ContractError::new(
                    ErrorCode::InternalError,
                    format!("serialize media job: {e}"),
                )
            })
        }
        "media.list" => {
            let jobs = manager.media_list()?;
            serde_json::to_value(dc_protocol::MediaListResult { jobs }).map_err(|e| {
                ContractError::new(
                    ErrorCode::InternalError,
                    format!("serialize media jobs: {e}"),
                )
            })
        }
        "media.get" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.media_get(&p.id)?;
            Ok(serde_json::json!({ "job": job }))
        }
        "media.pause" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.media_pause(&p.id).await?;
            media_job_json(job)
        }
        "media.resume" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.media_resume(&p.id).await?;
            media_job_json(job)
        }
        "media.cancel" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.media_cancel(&p.id).await?;
            media_job_json(job)
        }
        "media.remove" => {
            let p: dc_protocol::MediaRemoveParams = parse(&params)?;
            manager.media_remove(&p.id, p.delete_files).await?;
            Ok(serde_json::json!({ "removed": true }))
        }
        // ---- Phase 13: native torrent engine ----
        "torrent.add" => {
            let p: dc_protocol::TorrentAddParams = parse(&params)?;
            let job = manager.torrent_add(p).await?;
            serde_json::to_value(dc_protocol::TorrentAddResult { job }).map_err(|e| {
                ContractError::new(
                    ErrorCode::InternalError,
                    format!("serialize torrent job: {e}"),
                )
            })
        }
        "torrent.list" => {
            let jobs = manager.torrent_list()?;
            serde_json::to_value(dc_protocol::TorrentListResult { jobs }).map_err(|e| {
                ContractError::new(
                    ErrorCode::InternalError,
                    format!("serialize torrent jobs: {e}"),
                )
            })
        }
        "torrent.get" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.torrent_get(&p.id)?;
            Ok(serde_json::json!({ "job": job }))
        }
        "torrent.pause" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.torrent_pause(&p.id).await?;
            torrent_job_json(job)
        }
        "torrent.resume" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.torrent_resume(&p.id).await?;
            torrent_job_json(job)
        }
        "torrent.cancel" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.torrent_cancel(&p.id).await?;
            torrent_job_json(job)
        }
        "torrent.remove" => {
            let p: dc_protocol::TorrentRemoveParams = parse(&params)?;
            manager.torrent_remove(&p.id, p.delete_files).await?;
            Ok(serde_json::json!({ "removed": true }))
        }
        // ---- Phase 14: browser history + bookmarks ----
        "browser.history.record" => {
            let p: dc_protocol::HistoryRecordParams = parse(&params)?;
            manager.history_record(p)?;
            Ok(serde_json::json!({ "recorded": true }))
        }
        "browser.history.list" => {
            let p: dc_protocol::HistoryListParams = parse(&params)?;
            let entries = manager.history_list(p)?;
            Ok(serde_json::json!({ "entries": entries }))
        }
        "browser.history.delete" => {
            let p: JobIdParams = parse(&params)?;
            manager.history_delete(&p.id)?;
            Ok(serde_json::json!({ "deleted": true }))
        }
        "browser.history.clear" => {
            #[derive(Deserialize)]
            struct ClearParams {
                #[serde(default)]
                before: Option<i64>,
            }
            let p: ClearParams = parse(&params)?;
            let cleared = manager.history_clear(p.before)?;
            Ok(serde_json::json!({ "cleared": cleared }))
        }
        "browser.bookmark.create" => {
            let p: dc_protocol::BookmarkCreateParams = parse(&params)?;
            let bookmark = manager.bookmark_create(p)?;
            Ok(serde_json::json!({ "bookmark": bookmark }))
        }
        "browser.bookmark.list" => {
            let bookmarks = manager.bookmark_list()?;
            Ok(serde_json::json!({ "bookmarks": bookmarks }))
        }
        "browser.bookmark.getByUrl" => {
            #[derive(Deserialize)]
            struct GetByUrlParams {
                url: String,
            }
            let p: GetByUrlParams = parse(&params)?;
            let bookmark = manager.bookmark_get_by_url(&p.url)?;
            Ok(serde_json::json!({ "bookmark": bookmark }))
        }
        "browser.bookmark.update" => {
            let p: dc_protocol::BookmarkUpdateParams = parse(&params)?;
            let bookmark = manager.bookmark_update(p)?;
            Ok(serde_json::json!({ "bookmark": bookmark }))
        }
        "browser.bookmark.remove" => {
            let p: JobIdParams = parse(&params)?;
            manager.bookmark_remove(&p.id)?;
            Ok(serde_json::json!({ "removed": true }))
        }
        // ---- Phase 15: scheduler jobs + automation ----
        "scheduler.list" => {
            let jobs = manager.scheduler_list()?;
            serde_json::to_value(dc_protocol::SchedulerListResult { jobs }).map_err(|e| {
                ContractError::new(
                    ErrorCode::InternalError,
                    format!("serialize scheduler jobs: {e}"),
                )
            })
        }
        "scheduler.create" => {
            let p: dc_protocol::SchedulerCreateParams = parse(&params)?;
            let job = manager.scheduler_create(p)?;
            scheduler_job_json(job)
        }
        "scheduler.update" => {
            let p: dc_protocol::SchedulerUpdateParams = parse(&params)?;
            let job = manager.scheduler_update(p)?;
            scheduler_job_json(job)
        }
        "scheduler.remove" => {
            let p: JobIdParams = parse(&params)?;
            manager.scheduler_remove(&p.id)?;
            Ok(serde_json::json!({ "removed": true }))
        }
        "scheduler.runNow" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.scheduler_run_now(&p.id).await?;
            scheduler_job_json(job)
        }
        "scheduler.setClock" => {
            let p: dc_protocol::SchedulerSetClockParams = parse(&params)?;
            manager.scheduler_set_clock(p.tz_offset_minutes)?;
            Ok(serde_json::json!({ "applied": true }))
        }
        "download.cancel" => {
            let p: JobIdParams = parse(&params)?;
            let job = manager.cancel(&p.id).await?;
            job_json(job)
        }
        "download.remove" => {
            let p: RemoveParams = parse(&params)?;
            manager.remove(&p.id, p.delete_partial_file).await?;
            Ok(serde_json::json!({ "removed": true }))
        }
        other => Err(ContractError::new(
            ErrorCode::MethodNotFound,
            format!("unknown method: {other}"),
        )),
    }
}

fn job_json(job: DownloadJob) -> Result<Value, ContractError> {
    serde_json::to_value(job)
        .map(|v| serde_json::json!({ "job": v }))
        .map_err(|e| ContractError::new(ErrorCode::InternalError, format!("serialize job: {e}")))
}

fn media_job_json(job: dc_protocol::MediaJob) -> Result<Value, ContractError> {
    serde_json::to_value(job)
        .map(|v| serde_json::json!({ "job": v }))
        .map_err(|e| {
            ContractError::new(
                ErrorCode::InternalError,
                format!("serialize media job: {e}"),
            )
        })
}

fn torrent_job_json(job: dc_protocol::TorrentJob) -> Result<Value, ContractError> {
    serde_json::to_value(job)
        .map(|v| serde_json::json!({ "job": v }))
        .map_err(|e| {
            ContractError::new(
                ErrorCode::InternalError,
                format!("serialize torrent job: {e}"),
            )
        })
}

fn scheduler_job_json(job: dc_protocol::SchedulerJob) -> Result<Value, ContractError> {
    serde_json::to_value(job)
        .map(|v| serde_json::json!({ "job": v }))
        .map_err(|e| {
            ContractError::new(
                ErrorCode::InternalError,
                format!("serialize scheduler job: {e}"),
            )
        })
}

fn parse<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T, ContractError> {
    serde_json::from_value(params.clone())
        .map_err(|e| ContractError::new(ErrorCode::InvalidParams, format!("invalid params: {e}")))
}
