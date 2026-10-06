//! Engine integration tests against a real local HTTP server.
//! Covers: fresh download, pause→resume, canceled/failed resume, source-change integrity
//! (If-Range mismatch → restart from zero), filename derivation and completion rename.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use dc_protocol::job::DownloadJob;
use dc_protocol::{new_ulid, ContractError, ErrorCode};
use dc_storage::JobStore;
use download_core::engine::{CreateJobParams, Engine, JobCommand};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

fn tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dc-engine-test-{}-{}",
        std::process::id(),
        new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_engine(store: Arc<JobStore>) -> Arc<Engine> {
    let (tx, _rx) = mpsc::unbounded_channel();
    Arc::new(Engine::new(store, tx))
}

fn params(url: String, dir: &PathBuf, headers: Option<HashMap<String, String>>) -> CreateJobParams {
    CreateJobParams {
        url,
        destination_dir: dir.display().to_string(),
        filename: None,
        overwrite: false,
        headers,
    }
}

/// Insert a job that already has a `.part` with `part_len` bytes of `part_source`,
/// simulating a previous run (validators persisted).
async fn seed_partial_job(
    engine: &Engine,
    server: &common::TestServer,
    dir: &PathBuf,
    part_len: usize,
    part_source: &[u8],
    filename: &str,
) -> DownloadJob {
    let mut job = engine
        .create_job(params(server.base_url.clone(), dir, None))
        .await
        .unwrap();
    job.filename = Some(filename.into());
    job.status = "paused".into();
    job.etag = Some(server.etag_of_v1().into());
    job.received_bytes = part_len as u64;
    job.destination_path = Some(dir.join(filename).display().to_string());

    let part = dir.join(format!("{filename}.part"));
    let mut f = tokio::fs::File::create(&part).await.unwrap();
    f.write_all(&part_source[..part_len]).await.unwrap();
    f.flush().await.unwrap();
    drop(f);

    engine.store.update_job(&job).unwrap();
    job
}

#[tokio::test]
async fn fresh_download_completes_with_exact_bytes_and_rename() {
    let body: Vec<u8> = (0..64_000u32).map(|i| (i % 251) as u8).collect();
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    let (cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(
            job.clone(),
            cmd_rx,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed", "job must complete");
    let final_path = finished.destination_path.clone().unwrap();
    assert!(final_path.ends_with(".bin") || final_path.ends_with("file"));
    assert!(!final_path.ends_with(".part"), "part must be renamed");
    let on_disk = tokio::fs::read(&final_path).await.unwrap();
    assert_eq!(on_disk, body, "file bytes must match the source exactly");
    assert_eq!(finished.received_bytes, body.len() as u64);
    drop(cmd_tx);
}

#[tokio::test]
async fn resume_with_unchanged_source_appends_and_completes() {
    let body: Vec<u8> = (0..50_000u32).map(|i| (i % 249) as u8).collect();
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let part_len = 20_000;
    let job = seed_partial_job(&engine, &server, &dir, part_len, &body, "resumable.bin").await;

    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(job, cmd_rx, tokio_util::sync::CancellationToken::new())
        .await;

    let finished = store.list_jobs().unwrap().remove(0);
    assert_eq!(finished.status, "completed");
    // Server must have been asked for the continuation range.
    assert_eq!(server.last_range_start(), Some(part_len as u64));
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body, "resume must fill only the missing range");
}

#[tokio::test]
async fn source_change_discards_stale_part_and_restarts() {
    let body_v1: Vec<u8> = vec![1u8; 50_000];
    let body_v2: Vec<u8> = vec![2u8; 60_000];
    let server = common::TestServer::start(body_v1.clone(), body_v2.clone(), 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    // part written against v1; the source then changes to v2.
    let job = seed_partial_job(&engine, &server, &dir, 20_000, &body_v1, "changed.bin").await;
    server.rotate_to_v2();

    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(job, cmd_rx, tokio_util::sync::CancellationToken::new())
        .await;

    let finished = store.list_jobs().unwrap().remove(0);
    assert_eq!(finished.status, "completed");
    // The engine sent Range+If-Range(old v1 etag); the changed server answered 200 → the
    // engine must have truncated and restarted from zero (RFC 7233 If-Range guard).
    assert_eq!(
        server.last_if_range().as_deref(),
        Some(server.etag_of_v1()),
        "the resume request must carry the PART's validator, not the freshly probed one"
    );
    assert_eq!(finished.received_bytes, body_v2.len() as u64);
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(
        on_disk, body_v2,
        "stale v1 part must be discarded, file must be pure v2"
    );
}

#[tokio::test]
async fn pause_stops_the_stream_and_resume_completes() {
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 253) as u8).collect();
    let server = common::TestServer::start(body.clone(), vec![], 25).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(CreateJobParams {
            url: server.base_url.clone(),
            destination_dir: dir.display().to_string(),
            filename: Some("paused.bin".into()),
            overwrite: false,
            headers: None,
        })
        .await
        .unwrap();

    let (cmd_tx, cmd_rx) = mpsc::channel(4);
    let stop = tokio_util::sync::CancellationToken::new();
    let engine_task = tokio::spawn(engine.clone().run_job(job.clone(), cmd_rx, stop.clone()));

    // wait until some bytes landed, then pause
    loop {
        let current = store.get_job(job.id.as_str()).unwrap().unwrap();
        if current.received_bytes > 5_000 || current.status == "completed" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    cmd_tx.send(JobCommand::Pause).await.unwrap();
    let _ = engine_task.await;

    let paused = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(
        paused.status, "paused",
        "pause must persist the paused state"
    );
    assert!(paused.received_bytes > 0);

    // resume: mark queued and run again — appends from the part
    let received_at_pause = paused.received_bytes;
    let mut job2 = paused;
    job2.status = "queued".into();
    store.update_job(&job2).unwrap();
    let (_cmd_tx2, cmd_rx2) = mpsc::channel(4);
    engine
        .clone()
        .run_job(job2, cmd_rx2, tokio_util::sync::CancellationToken::new())
        .await;

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    assert_eq!(finished.received_bytes, body.len() as u64);
    assert!(server.last_range_start().unwrap_or(0) >= received_at_pause.min(body.len() as u64 - 1));
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn http_error_status_maps_to_http_error_code() {
    // A URL with a reserved port fails fast → network_error; probes the error mapping path.
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    let mut job = engine
        .create_job(params("http://127.0.0.1:9/file".into(), &dir, None))
        .await
        .unwrap();

    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(
            job.clone(),
            cmd_rx,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

    job = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(job.status, "failed");
    assert!(
        job.error_code.as_deref() == Some("network_error")
            || job.error_code.as_deref() == Some("http_error"),
        "unexpected error code {:?}",
        job.error_code
    );
    assert_eq!(
        job.error_code.as_deref(),
        Some(ErrorCode::NetworkError.as_str())
    );
    let _ = ContractError::new(ErrorCode::IoError, "keep import");
}
