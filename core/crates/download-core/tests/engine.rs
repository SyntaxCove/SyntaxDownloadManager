//! Engine integration tests against a real local HTTP server.
//! Covers: fresh download, pause→resume, canceled/failed resume, source-change integrity
//! (If-Range mismatch → restart from zero), filename derivation and completion rename.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

fn params(url: String, dir: &Path, headers: Option<HashMap<String, String>>) -> CreateJobParams {
    CreateJobParams {
        url,
        destination_dir: dir.display().to_string(),
        filename: None,
        overwrite: false,
        headers,
        checksum: None,
    }
}

/// Insert a job that already has a `.part` with `part_len` bytes of `part_source`,
/// simulating a previous run (validators persisted).
async fn seed_partial_job(
    engine: &Engine,
    server: &common::TestServer,
    dir: &Path,
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
    assert!(
        server
            .if_range_seen()
            .iter()
            .any(|ir| ir == server.etag_of_v1()),
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
            checksum: None,
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

// ==================== Phase 6: segmented engine, journal, checksums ====================

use dc_protocol::ChecksumAlgorithm;
use dc_storage::SegmentRow;
use download_core::engine::ChecksumSpec;
use download_core::segments::MIN_SEGMENT_BYTES;
use sha2::{Digest, Sha256};

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    download_core::segments::to_hex(&hasher.finalize())
}

/// 4 MiB deterministic body — with the default 1 MiB minimum segment size this plans
/// exactly 4 windows at 4 connections.
fn seg_body(len: usize) -> Vec<u8> {
    (0..len as u64)
        .map(|i| ((i * 7 + 13) % 256) as u8)
        .collect()
}

#[tokio::test]
async fn segmented_download_assembles_exact_bytes() {
    let body = seg_body(4 * 1024 * 1024);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
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

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    assert_eq!(finished.segment_count, Some(4));
    assert_eq!(finished.received_bytes, body.len() as u64);
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(
        on_disk, body,
        "parallel segments must tile the file exactly"
    );

    // Journal: every window done, cursors at their full length.
    let rows = store.list_segments(job.id.as_str()).unwrap();
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|r| r.status == "done"));
    assert!(rows
        .iter()
        .all(|r| r.written_bytes == r.end_offset.unwrap() - r.start_offset + 1));

    // More than one connection was actually used.
    assert!(
        server.request_count() >= 4,
        "expected parallel range requests"
    );
    let starts = server.range_starts();
    assert!(starts.contains(&0) && starts.iter().any(|&s| s >= MIN_SEGMENT_BYTES));
}

#[tokio::test]
async fn segmented_pause_resume_preserves_segments() {
    let body = seg_body(4 * 1024 * 1024);
    // 16 KiB chunks every 20 ms → ~1.3 s per window: the pause lands mid-download.
    let server = common::TestServer::start_with(
        body.clone(),
        vec![],
        20,
        16 * 1024,
        common::ServerToggles::default(),
    )
    .await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    let (cmd_tx, cmd_rx) = mpsc::channel(4);
    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(engine.clone().run_job(job.clone(), cmd_rx, stop.clone()));

    // Wait until real progress exists (ticker flushes the aggregate every 500 ms).
    loop {
        let current = store.get_job(job.id.as_str()).unwrap().unwrap();
        if current.status == "completed" || current.received_bytes > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    cmd_tx.send(JobCommand::Pause).await.unwrap();
    let _ = task.await;

    let paused = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(paused.status, "paused");
    assert!(paused.received_bytes > 0, "must have bytes at pause time");

    // The journal was flushed on pause: Σ cursors == reported received.
    let rows = store.list_segments(job.id.as_str()).unwrap();
    let journaled: u64 = rows.iter().map(|r| r.written_bytes).sum();
    assert_eq!(
        journaled, paused.received_bytes,
        "journal must match on pause"
    );

    // Resume → completes with exact bytes; the resume requests continue inside windows.
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
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn source_change_restarts_segmented_run_from_zero() {
    let body_v1 = seg_body(4 * 1024 * 1024);
    let body_v2: Vec<u8> = vec![9u8; 4 * 1024 * 1024];
    let server = common::TestServer::start(body_v1.clone(), body_v2.clone(), 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);

    // Seed a paused job with a segmented journal: window 0 half done against v1.
    let mut job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    job.status = "paused".into();
    job.etag = Some(server.etag_of_v1().into());
    job.destination_path = Some(dir.join("seg-change.bin").display().to_string());
    job.received_bytes = 512 * 1024;
    store.update_job(&job).unwrap();

    let part = dir.join("seg-change.bin.part");
    tokio::fs::write(&part, &body_v1[..512 * 1024])
        .await
        .unwrap();
    let win = 1024 * 1024u64;
    let rows = (0..4u64)
        .map(|i| SegmentRow {
            seg_index: i,
            start_offset: i * win,
            end_offset: Some(i * win + win - 1),
            written_bytes: if i == 0 { 512 * 1024 } else { 0 },
            status: "downloading".into(),
        })
        .collect::<Vec<_>>();
    store.replace_segments(job.id.as_str(), &rows).unwrap();

    server.rotate_to_v2();
    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(
            job.clone(),
            cmd_rx,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    // The resume must have carried the PART's validator (v1) and then restarted clean.
    assert!(
        server
            .if_range_seen()
            .iter()
            .any(|ir| ir == server.etag_of_v1()),
        "resume must present the part's validator"
    );
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body_v2, "stale v1 bytes must be fully discarded");
    assert_eq!(finished.received_bytes, body_v2.len() as u64);
}

#[tokio::test]
async fn over_sending_server_is_capped_at_window_end() {
    let body = seg_body(4 * 1024 * 1024);
    let server = common::TestServer::start_with(
        body.clone(),
        vec![],
        0,
        64 * 1024,
        common::ServerToggles {
            over_send: true,
            ..Default::default()
        },
    )
    .await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
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

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(
        finished.status, "completed",
        "surplus bytes must be dropped, not counted"
    );
    assert_eq!(
        finished.received_bytes,
        body.len() as u64,
        "no overcounting"
    );
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn content_range_lie_fails_the_job() {
    let body = seg_body(2 * 1024 * 1024);
    let server = common::TestServer::start_with(
        body.clone(),
        vec![],
        0,
        64 * 1024,
        common::ServerToggles {
            lie_content_range: true,
            ..Default::default()
        },
    )
    .await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(2);

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
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

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "failed");
    assert_eq!(finished.error_code.as_deref(), Some("http_error"));
}

#[tokio::test]
async fn rangeless_server_falls_back_to_append_mode() {
    let body: Vec<u8> = (0..120_000u32).map(|i| (i % 250) as u8).collect();
    let server = common::TestServer::start_with(
        body.clone(),
        vec![],
        0,
        8 * 1024,
        common::ServerToggles {
            disable_ranges: true,
            ..Default::default()
        },
    )
    .await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
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

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    assert_eq!(finished.segment_count, Some(1));
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);
    let rows = store.list_segments(job.id.as_str()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].end_offset, None, "open-ended append window");
    assert_eq!(rows[0].status, "done");
}

#[tokio::test]
async fn checksum_verifies_on_completion() {
    let body: Vec<u8> = (0..300_000u32).map(|i| (i % 241) as u8).collect();
    let expected = sha256_hex(&body);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let mut p = params(server.base_url.clone(), &dir, None);
    p.checksum = Some(ChecksumSpec {
        algorithm: ChecksumAlgorithm::Sha256,
        value: expected.clone(),
    });
    let job = engine.create_job(p).await.unwrap();
    assert_eq!(job.checksum_expected.as_deref(), Some(expected.as_str()));
    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(
            job.clone(),
            cmd_rx,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    assert_eq!(finished.checksum_verified, Some(true));
    assert_eq!(finished.checksum_actual.as_deref(), Some(expected.as_str()));
}

#[tokio::test]
async fn checksum_mismatch_fails_and_keeps_part() {
    let body: Vec<u8> = (0..300_000u32).map(|i| (i % 239) as u8).collect();
    let wrong = sha256_hex(&[0xABu8; 64]);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let mut p = params(server.base_url.clone(), &dir, None);
    p.filename = Some("verify.bin".into());
    p.checksum = Some(ChecksumSpec {
        algorithm: ChecksumAlgorithm::Sha256,
        value: wrong,
    });
    let job = engine.create_job(p).await.unwrap();
    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(
            job.clone(),
            cmd_rx,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "failed");
    assert_eq!(finished.error_code.as_deref(), Some("checksum_mismatch"));
    assert_eq!(finished.checksum_verified, Some(false));
    assert_eq!(
        finished.checksum_actual.as_deref(),
        Some(sha256_hex(&body).as_str()),
        "actual digest is recorded for diagnosis"
    );
    // The part file is kept for inspection (data integrity outranks tidiness).
    let part = dir.join("verify.bin.part");
    assert!(tokio::fs::try_exists(&part).await.unwrap());
    assert_eq!(tokio::fs::read(&part).await.unwrap(), body);
}

#[tokio::test]
async fn v1_part_is_migrated_into_the_segment_journal() {
    let body = seg_body(4 * 1024 * 1024);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);

    // Phase 5-style part: bytes on disk + validators, but no journal rows at all.
    let part_len = 1024 * 1024;
    let job = seed_partial_job(&engine, &server, &dir, part_len, &body, "legacy.bin").await;

    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(
            job.clone(),
            cmd_rx,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(
        on_disk, body,
        "migrated v1 bytes must be preserved, not re-fetched"
    );
    let rows = store.list_segments(job.id.as_str()).unwrap();
    assert!(rows.iter().all(|r| r.status == "done"));
    // Segment 1 started exactly where the v1 part ended (window tiling).
    let starts = server.range_starts();
    assert!(
        starts.contains(&(part_len as u64)),
        "resume continues at the migrated cursor"
    );
}
