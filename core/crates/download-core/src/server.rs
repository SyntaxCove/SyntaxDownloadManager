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
use crate::manager::JobManager;
use crate::segments::normalize_expected;
use dc_protocol::ChecksumAlgorithm;

#[derive(Deserialize)]
struct JobIdParams {
    id: String,
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
}

#[derive(Deserialize)]
struct SetConcurrencyParams {
    max: usize,
    #[serde(rename = "maxConnectionsPerDownload")]
    max_connections_per_download: Option<usize>,
}

pub type OutboundTx = mpsc::UnboundedSender<String>;

/// Serve requests from `stdin` until EOF. Responses are written through `outbound` — the
/// caller owns the writer task, which also carries engine events (single-writer principle).
pub async fn serve(
    stdin: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    manager: Arc<JobManager>,
    outbound: OutboundTx,
) {
    let tx = outbound;
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let manager = manager.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
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
                            ContractError::new(ErrorCode::ParseError, "malformed request envelope"),
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

fn parse<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T, ContractError> {
    serde_json::from_value(params.clone())
        .map_err(|e| ContractError::new(ErrorCode::InvalidParams, format!("invalid params: {e}")))
}
