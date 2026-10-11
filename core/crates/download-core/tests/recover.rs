//! Phase 7 recovery engine integration tests against a real local HTTP server.
//!
//! Covers the product promise "an expired URL never destroys the job or the bytes":
//!  - a 404-while-paused resume fails with the classified `source_gone` code and preserves
//!    both the part bytes and the segment journal byte-exactly;
//!  - `recover()` re-acquires the source, revalidates with multiple signals, rebinds
//!    (recoveryCount/reboundAt) and requeues; the next run gap-fills only the missing range;
//!  - `replaceUrl` rebinds to a mirror and completes from the kept bytes;
//!  - a same-size source change with an expected checksum runs a checksum-arbitrated
//!    gap-fill WITHOUT If-Range and verifies the mixed-provenance file;
//!  - a same-size change without a checksum restarts clean (no splice, ever);
//!  - fresh jobs against dead URLs fail with the classified code.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use dc_protocol::job::DownloadJob;
use dc_protocol::{new_ulid, ChecksumAlgorithm};
use dc_storage::{JobStore, SegmentRow};
use download_core::engine::{ChecksumSpec, CreateJobParams, Engine, JobCommand};
use download_core::JobManager;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

fn tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dc-recover-test-{}-{}",
        std::process::id(),
        new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_engine(store: Arc<JobStore>) -> Arc<Engine> {
    let (tx, _rx) = mpsc::unbounded_channel();
    Arc::new({
        let toolkit = std::sync::Arc::new(download_core::toolkit::ToolkitMap::new());
        let proxies = std::sync::Arc::new(download_core::proxy::ProxyMap::new());
        let limiter = std::sync::Arc::new(tokio::sync::Semaphore::new(3));
        Engine::new(store, tx, toolkit, proxies, limiter)
    })
}

fn params(url: String, dir: &Path, checksum: Option<ChecksumSpec>) -> CreateJobParams {
    CreateJobParams {
        url,
        destination_dir: dir.display().to_string(),
        filename: None,
        overwrite: false,
        headers: None,
        checksum,
        proxy_profile_id: None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Insert a paused job that already carries a Phase 6-style segmented state: a `.part` with
/// `part_len` bytes of `source`, v1 validators, and one bounded journal window with the
/// matching durable cursor — exactly what a mid-download pause leaves behind.
async fn seed_segmented_job(
    engine: &Engine,
    url: &str,
    dir: &Path,
    part_len: usize,
    source: &[u8],
    filename: &str,
    checksum: Option<ChecksumSpec>,
) -> DownloadJob {
    let mut job = engine
        .create_job(params(url.to_string(), dir, checksum))
        .await
        .unwrap();
    job.filename = Some(filename.into());
    job.status = "paused".into();
    job.etag = Some("\"test-etag-v1\"".into());
    job.total_bytes = Some(source.len() as u64);
    job.content_type = Some("application/octet-stream".into());
    job.received_bytes = part_len as u64;
    job.destination_path = Some(dir.join(filename).display().to_string());

    let part = dir.join(format!("{filename}.part"));
    let mut f = tokio::fs::File::create(&part).await.unwrap();
    f.write_all(&source[..part_len]).await.unwrap();
    f.flush().await.unwrap();
    drop(f);

    engine.store.update_job(&job).unwrap();
    let rows = vec![SegmentRow {
        seg_index: 0,
        start_offset: 0,
        end_offset: Some(source.len() as u64 - 1),
        written_bytes: part_len as u64,
        status: "downloading".into(),
    }];
    engine
        .store
        .replace_segments(job.id.as_str(), &rows)
        .unwrap();
    job
}

async fn run_to_completion(engine: &Arc<Engine>, job: DownloadJob) -> DownloadJob {
    let (_cmd_tx, cmd_rx) = mpsc::channel::<JobCommand>(4);
    engine
        .clone()
        .run_job(job, cmd_rx, tokio_util::sync::CancellationToken::new())
        .await;
    engine.store.list_jobs().unwrap().remove(0)
}

#[tokio::test]
async fn resume_against_expired_url_fails_classified_and_preserves_state() {
    let body: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        20_000,
        &body,
        "expired.bin",
        None,
    )
    .await;
    let part_before = tokio::fs::read(dir.join("expired.bin.part")).await.unwrap();
    let journal_before = engine.store.list_segments(job.id.as_str()).unwrap();
    assert_eq!(journal_before.len(), 1);
    assert_eq!(journal_before[0].written_bytes, 20_000);

    server.set_dead(true);
    let finished = run_to_completion(&engine, job).await;

    assert_eq!(finished.status, "failed");
    assert_eq!(finished.error_code.as_deref(), Some("source_gone"));

    // The expired URL must not destroy the bytes or the journal.
    let part_after = tokio::fs::read(dir.join("expired.bin.part")).await.unwrap();
    assert_eq!(part_after, part_before, "part bytes preserved exactly");
    let journal_after = engine.store.list_segments(finished.id.as_str()).unwrap();
    assert_eq!(journal_after, journal_before, "journal preserved exactly");
    assert_eq!(finished.recovery_count, None, "no rebind happened");
    assert_eq!(finished.rebound_at, None);
}

#[tokio::test]
async fn recover_rebinds_and_gap_fills_after_outage() {
    let body: Vec<u8> = (0..50_000u32).map(|i| (i % 249) as u8).collect();
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let mut job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        20_000,
        &body,
        "outage.bin",
        None,
    )
    .await;

    server.set_dead(true);
    let failed = run_to_completion(&engine, job.clone()).await;
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.error_code.as_deref(), Some("source_gone"));

    // The outage clears: recovery re-acquires, revalidates, rebinds and requeues.
    server.set_dead(false);
    engine.recover(&mut job).await.unwrap();
    let rebound = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(rebound.status, "queued", "recover must requeue the job");
    assert_eq!(rebound.error_code, None);
    assert_eq!(rebound.recovery_count, Some(1));
    assert!(rebound.rebound_at.is_some(), "rebind timestamp recorded");

    // The next run fills only the missing range: no request inside the kept prefix.
    let finished = run_to_completion(&engine, rebound).await;
    assert_eq!(finished.status, "completed");
    let starts = server.range_starts();
    assert!(
        starts.iter().all(|&s| s == 0 || s >= 20_000),
        "only probe (0) and continuation (>= 20_000) requests allowed, saw {starts:?}"
    );
    assert_eq!(starts.last().copied(), Some(20_000));
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body, "gap-fill must reproduce the source exactly");
}

#[tokio::test]
async fn recover_against_still_dead_source_keeps_classified_failure() {
    let body: Vec<u8> = vec![7u8; 20_000];
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let mut job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        5_000,
        &body,
        "stilldead.bin",
        None,
    )
    .await;
    server.set_dead(true);

    // Recovery is a query over the world: the call succeeds, the job carries the verdict.
    engine.recover(&mut job).await.unwrap();
    let after = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(
        after.status, "failed",
        "still-dead source keeps the job failed"
    );
    assert_eq!(after.error_code.as_deref(), Some("source_gone"));
    assert_eq!(
        after.recovery_count, None,
        "no rebind without a live source"
    );
}

#[tokio::test]
async fn replace_url_keeps_bytes_and_completes_from_mirror() {
    let body: Vec<u8> = (0..50_000u32).map(|i| (i % 241) as u8).collect();
    let server_a = common::TestServer::start(body.clone(), vec![], 0).await;
    let server_b = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    // The seeding engine and the manager share the same store; the manager's pump picks
    // the rebound job up from its `queued` state.
    let engine = make_engine(store.clone());
    let (tx, _rx) = mpsc::unbounded_channel();
    let manager = JobManager::new(store.clone(), tx);

    let job = seed_segmented_job(
        &engine,
        &server_a.base_url,
        &dir,
        20_000,
        &body,
        "mirror.bin",
        None,
    )
    .await;
    server_a.set_dead(true);

    let rebound = manager
        .replace_url(job.id.as_str(), server_b.base_url.clone())
        .await
        .unwrap();
    assert_eq!(rebound.url, server_b.base_url, "job rebound to the mirror");
    assert_eq!(rebound.status, "queued");
    assert_eq!(rebound.recovery_count, Some(1));
    assert!(rebound.rebound_at.is_some());

    // The pump starts the rebound job; it must complete from the kept bytes.
    let mut finished = None;
    for _ in 0..200 {
        let current = store.get_job(job.id.as_str()).unwrap().unwrap();
        if current.status == "completed" {
            finished = Some(current);
            break;
        }
        assert_ne!(
            current.status, "failed",
            "mirror run must not fail: {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let finished = finished.expect("rebound job must complete");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn checksum_arbitrated_recovery_gap_fills_without_if_range() {
    // Honest re-acquisition: the source serves the SAME bytes under a NEW validator
    // (expired signed URL refreshed by the CDN). Identity is unprovable via ETag (it
    // changed), but the expected checksum arbitrates — the part is kept, the missing
    // range is fetched WITHOUT If-Range, and the completed file verifies.
    let v1: Vec<u8> = (0..50_000u32).map(|i| (i % 199) as u8).collect();
    let v2 = v1.clone();
    let server = common::TestServer::start(v1.clone(), v2.clone(), 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        20_000,
        &v1,
        "arbitrated.bin",
        Some(ChecksumSpec {
            algorithm: ChecksumAlgorithm::Sha256,
            value: sha256_hex(&v2),
        }),
    )
    .await;
    server.rotate_to_v2();

    let finished = run_to_completion(&engine, job).await;
    assert_eq!(finished.status, "completed");
    assert_eq!(
        finished.checksum_verified,
        Some(true),
        "checksum must arbitrate"
    );
    assert_eq!(
        finished.checksum_actual.as_deref(),
        Some(sha256_hex(&v2).as_str())
    );
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, v2, "gap-fill must reproduce the source exactly");
    assert!(
        server.if_range_seen().is_empty(),
        "checksum-arbitrated gap-fill sends no If-Range"
    );
    assert_eq!(
        finished.recovery_count, None,
        "engine-internal revalidation is not a recover() rebind"
    );
}

#[tokio::test]
async fn checksum_arbitrated_run_catches_lying_server_and_keeps_part() {
    // Same size, different bytes: the checksum-arbitrated run may only complete when the
    // mixed-provenance file really matches the expected digest. A lying server (same
    // length, different content) is caught by the completion verdict — the job fails with
    // `checksum_mismatch` and the part file is kept for inspection (never renamed).
    let v1: Vec<u8> = (0..50_000u32).map(|i| (i % 199) as u8).collect();
    let v2: Vec<u8> = (0..50_000u32).map(|i| ((i * 7 + 3) % 199) as u8).collect();
    let server = common::TestServer::start(v1.clone(), v2.clone(), 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        20_000,
        &v1,
        "liar.bin",
        Some(ChecksumSpec {
            algorithm: ChecksumAlgorithm::Sha256,
            value: sha256_hex(&v1), // what the user knows the file to be
        }),
    )
    .await;
    server.rotate_to_v2();

    let finished = run_to_completion(&engine, job.clone()).await;
    assert_eq!(finished.status, "failed");
    assert_eq!(finished.error_code.as_deref(), Some("checksum_mismatch"));
    assert_eq!(finished.checksum_verified, Some(false));
    let part = dir.join("liar.bin.part");
    assert!(
        tokio::fs::try_exists(&part).await.unwrap(),
        "the mismatched part must be kept for inspection"
    );
    // The stale v1 validator was never presented to the lying server either.
    assert!(server.if_range_seen().is_empty());
}

#[tokio::test]
async fn changed_source_without_checksum_restarts_clean() {
    // Same size, different bytes, no expected checksum: integrity outranks bytes — the
    // part is wiped and the run restarts clean instead of splicing unprovable bytes.
    let v1: Vec<u8> = (0..50_000u32).map(|i| (i % 197) as u8).collect();
    let v2: Vec<u8> = (0..50_000u32).map(|i| ((i * 11 + 5) % 197) as u8).collect();
    let server = common::TestServer::start(v1.clone(), v2.clone(), 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        20_000,
        &v1,
        "changed.bin",
        None,
    )
    .await;
    server.rotate_to_v2();

    let finished = run_to_completion(&engine, job).await;
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(
        on_disk, v2,
        "clean restart must yield the fresh source exactly"
    );
    assert_eq!(finished.received_bytes, 50_000);
}

#[tokio::test]
async fn fresh_job_against_dead_url_fails_classified() {
    let server = common::TestServer::start(vec![1u8; 1000], vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    server.set_dead(true);

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    let finished = run_to_completion(&engine, job).await;
    assert_eq!(finished.status, "failed");
    assert_eq!(finished.error_code.as_deref(), Some("source_gone"));
}

#[tokio::test]
async fn replace_url_rejects_non_http_schemes() {
    let body: Vec<u8> = vec![1u8; 1000];
    let server = common::TestServer::start(body, vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    let (tx, _rx) = mpsc::unbounded_channel();
    let manager = JobManager::new(store.clone(), tx);

    let job = seed_segmented_job(
        &engine,
        &server.base_url,
        &dir,
        0,
        &[1u8; 1000],
        "scheme.bin",
        None,
    )
    .await;
    let err = manager
        .replace_url(
            job.id.as_str(),
            "ftp://mirror.example.com/file.bin".to_string(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code.as_str(), "url_invalid");
    let err = manager
        .replace_url(job.id.as_str(), "javascript:alert(1)".to_string())
        .await
        .unwrap_err();
    assert_eq!(err.code.as_str(), "url_invalid");
}

#[tokio::test]
async fn replace_url_rejects_active_or_completed_jobs() {
    let body: Vec<u8> = vec![2u8; 1000];
    let server = common::TestServer::start(body, vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    let (tx, _rx) = mpsc::unbounded_channel();
    let manager = JobManager::new(store.clone(), tx);

    // Completed job: not rebindable (a re-download is a new job).
    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    let finished = run_to_completion(&engine, job).await;
    assert_eq!(finished.status, "completed");
    let err = manager
        .replace_url(
            finished.id.as_str(),
            "https://mirror.example.com/f.bin".to_string(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code.as_str(), "invalid_state");
}

#[tokio::test]
async fn forbidden_source_classifies_as_source_forbidden() {
    // 401/403 mean "needs fresh credentials / a refreshed link" — a distinct recoverable
    // code the UI can act on (replaceUrl / re-auth), different from source_gone.
    let body: Vec<u8> = vec![3u8; 2000];
    let server = common::TestServer::start(body, vec![], 0).await;
    server.set_failure_status(403);
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    let finished = run_to_completion(&engine, job).await;
    assert_eq!(finished.status, "failed");
    assert_eq!(finished.error_code.as_deref(), Some("source_forbidden"));
}
