//! Phase 28 — data-integrity validation sweep: adversarial drills against the engine's
//! checksum/recovery machinery over a real local HTTP server.
//!
//! These tests attack the guarantees the earlier suites did not: the segment journal may
//! only claim bytes some on-disk file proves (part deletion/truncation, tampered journals),
//! the crash-between-rename-and-status-update window adopts the verified artifact instead
//! of synthesizing zeros, bit-rot inside a paused part is caught by the expected checksum,
//! and the journal never leads the part file during live runs.

mod common;

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dc_protocol::job::ChecksumAlgorithm;
use dc_protocol::{new_ulid, ErrorCode};
use dc_storage::JobStore;
use download_core::engine::{ChecksumSpec, CreateJobParams, Engine, JobCommand};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

fn tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dc-integrity-test-{}-{}",
        std::process::id(),
        new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_engine(store: Arc<JobStore>) -> Arc<Engine> {
    let (tx, _rx) = mpsc::unbounded_channel();
    Arc::new({
        let toolkit = Arc::new(download_core::toolkit::ToolkitMap::new());
        let proxies = Arc::new(download_core::proxy::ProxyMap::new());
        let limiter = Arc::new(tokio::sync::Semaphore::new(3));
        Engine::new(store, tx, toolkit, proxies, limiter)
    })
}

fn params(url: String, dir: &Path) -> CreateJobParams {
    CreateJobParams {
        url,
        destination_dir: dir.display().to_string(),
        filename: None,
        overwrite: false,
        headers: None,
        checksum: None,
        proxy_profile_id: None,
    }
}

fn with_checksum(
    mut p: CreateJobParams,
    algorithm: ChecksumAlgorithm,
    value: String,
) -> CreateJobParams {
    p.checksum = Some(ChecksumSpec { algorithm, value });
    p
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    download_core::segments::to_hex(&h.finalize())
}

/// Deterministic body (same generator as the engine suite so fixtures stay comparable).
fn body(len: usize) -> Vec<u8> {
    (0..len as u64)
        .map(|i| ((i * 7 + 13) % 256) as u8)
        .collect()
}

/// What counts as an honest "real progress" witness while waiting for the pause.
///
/// The part file's length is NOT a universal witness: in offset (segmented) mode the
/// engine sparse-pre-sizes the part to the full total BEFORE any writer runs, so a
/// 4 MiB part proves zero downloaded bytes — only the engine-maintained aggregate
/// (ticker-flushed, guaranteed within one 500 ms tick) and the persisted journal
/// cursors attest real progress there. In append mode the part genuinely grows from
/// zero and its length is the only witness fast enough for bodies shorter than the
/// ticker period (a false witness here once paused mid-run with received == 0 —
/// exactly the flake this split exists to kill).
enum ProgressWitness {
    Aggregate,
    PartGrowth,
}

/// Spawn a run, wait for real progress, pause it, and return the paused row.
async fn pause_mid_run(
    engine: &Arc<Engine>,
    store: &Arc<JobStore>,
    job: &dc_protocol::job::DownloadJob,
    witness: ProgressWitness,
) -> dc_protocol::job::DownloadJob {
    let (cmd_tx, cmd_rx) = mpsc::channel(4);
    let task = tokio::spawn(engine.clone().run_job(
        job.clone(),
        cmd_rx,
        tokio_util::sync::CancellationToken::new(),
    ));
    loop {
        let current = store.get_job(job.id.as_str()).unwrap().unwrap();
        if current.status == "completed" {
            panic!("run finished before the pause could land");
        }
        // Engine-attested progress: the ticker-flushed aggregate plus the journal
        // cursors (advanced only after a successful write_all, flushed on the
        // JOURNAL_FLUSH_BYTES cadence).
        let mut progressed = current.received_bytes > 0
            || store
                .list_segments(job.id.as_str())
                .map(|rows| rows.iter().any(|r| r.written_bytes > 0))
                .unwrap_or(false);
        if !progressed && matches!(witness, ProgressWitness::PartGrowth) {
            // Append mode only: the part grows from zero on the first chunk (no sparse
            // pre-size), so its length is real downloaded bytes.
            if let Some(dp) = &current.destination_path {
                if let Ok(meta) = tokio::fs::metadata(format!("{dp}.part")).await {
                    progressed = meta.len() > 0;
                }
            }
        }
        if progressed {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    cmd_tx.send(JobCommand::Pause).await.unwrap();
    let _ = task.await;
    let paused = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(paused.status, "paused");
    assert!(paused.received_bytes > 0, "must pause with real progress");
    paused
}

/// Resume a paused/failed row to terminal state (the caller re-reads the row by id).
async fn resume_to_terminal(
    engine: &Arc<Engine>,
    store: &Arc<JobStore>,
    job: &dc_protocol::job::DownloadJob,
) {
    let mut job = job.clone();
    job.status = "queued".into();
    store.update_job(&job).unwrap();
    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(job, cmd_rx, tokio_util::sync::CancellationToken::new())
        .await;
    let _ = store;
}

#[tokio::test]
async fn part_deleted_between_runs_restarts_clean_segmented() {
    let body = body(4 * 1024 * 1024);
    // Throttled so the pause lands mid-run with real progress.
    let server = common::TestServer::start_with(
        body.clone(),
        vec![],
        10,
        16 * 1024,
        common::ServerToggles::default(),
    )
    .await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);

    let job = engine
        .create_job(params(server.base_url.clone(), &dir))
        .await
        .unwrap();
    let paused = pause_mid_run(&engine, &store, &job, ProgressWitness::Aggregate).await;
    let requests_before = server.request_count();

    let part = dir.join("file.part");
    assert!(part.exists(), "segmented run must have a part file");
    tokio::fs::remove_file(&part).await.unwrap();

    // Resume: the journal still claims bytes, but the disk proves none of them — the
    // engine must reset the journal and re-download, never splice zeros.
    resume_to_terminal(&engine, &store, &paused).await;
    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(
        on_disk, body,
        "a deleted part must never produce a corrupt file"
    );
    assert!(
        server.request_count() > requests_before,
        "the clean restart must actually re-download"
    );
}

#[tokio::test]
async fn part_deleted_between_runs_restarts_clean_append_mode() {
    let body = body(256 * 1024);
    // Range-less server → append mode (single open-ended window).
    let toggles = common::ServerToggles {
        disable_ranges: true,
        ..Default::default()
    };
    let server = common::TestServer::start_with(body.clone(), vec![], 8, 8 * 1024, toggles).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir))
        .await
        .unwrap();
    let paused = pause_mid_run(&engine, &store, &job, ProgressWitness::PartGrowth).await;
    tokio::fs::remove_file(dir.join("file.part")).await.unwrap();

    resume_to_terminal(&engine, &store, &paused).await;
    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body, "append-mode part loss must restart clean");
}

#[tokio::test]
async fn part_truncated_below_journal_never_yields_corrupt_output() {
    let body = body(256 * 1024);
    let toggles = common::ServerToggles {
        disable_ranges: true,
        ..Default::default()
    };
    let server = common::TestServer::start_with(body.clone(), vec![], 8, 8 * 1024, toggles).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir))
        .await
        .unwrap();
    let paused = pause_mid_run(&engine, &store, &job, ProgressWitness::PartGrowth).await;
    let journaled: u64 = store
        .list_segments(job.id.as_str())
        .unwrap()
        .iter()
        .map(|r| r.written_bytes)
        .sum();
    assert!(journaled > 4, "need a meaningful cursor for the drill");

    // External truncation: the part now backs FEWER bytes than the journal claims.
    let part = dir.join("file.part");
    let keep = (journaled / 2).max(1) as u64;
    let f = std::fs::OpenOptions::new().write(true).open(&part).unwrap();
    f.set_len(keep).unwrap();
    drop(f);

    resume_to_terminal(&engine, &store, &paused).await;
    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(
        on_disk, body,
        "truncation must clamp/restart, never splice a zero hole"
    );
}

#[tokio::test]
async fn tampered_journal_beyond_the_part_is_not_trusted() {
    let body = body(256 * 1024);
    let toggles = common::ServerToggles {
        disable_ranges: true,
        ..Default::default()
    };
    let server = common::TestServer::start_with(body.clone(), vec![], 0, 8 * 1024, toggles).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let mut job = engine
        .create_job(params(server.base_url.clone(), &dir))
        .await
        .unwrap();
    // Seed a paused job whose journal claims far more than the part holds.
    job.filename = Some("file".into());
    job.status = "paused".into();
    job.etag = Some(server.etag_of_v1().into());
    job.destination_path = Some(dir.join("file").display().to_string());
    let mut f = tokio::fs::File::create(dir.join("file.part"))
        .await
        .unwrap();
    f.write_all(&body[..4096]).await.unwrap();
    f.flush().await.unwrap();
    drop(f);
    store.update_job(&job).unwrap();
    store
        .replace_segments(
            job.id.as_str(),
            &[dc_storage::SegmentRow {
                seg_index: 0,
                start_offset: 0,
                end_offset: None,
                written_bytes: 200_000,
                status: "downloading".into(),
            }],
        )
        .unwrap();

    resume_to_terminal(&engine, &store, &job).await;
    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn crash_after_rename_adopts_the_verified_artifact() {
    let body = body(1024 * 1024);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    let expected = sha256_hex(&body);

    let job = engine
        .create_job(with_checksum(
            params(server.base_url.clone(), &dir),
            ChecksumAlgorithm::Sha256,
            expected.clone(),
        ))
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
    let done = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(done.status, "completed");
    let final_path = done.destination_path.clone().unwrap();
    let requests_after_completion = server.request_count();

    // Simulate the crash window of complete(): the rename happened, the status update
    // did not. The job row reverts to running, the verdict is lost, the part is gone.
    let mut crashed = done;
    crashed.status = "downloading".into();
    crashed.checksum_actual = None;
    crashed.checksum_verified = None;
    crashed.error_code = None;
    store.update_job(&crashed).unwrap();
    // Journal rows: complete() left them all-done — exactly the phantom state.

    let (_cmd_tx2, cmd_rx2) = mpsc::channel(4);
    engine
        .clone()
        .run_job(crashed, cmd_rx2, tokio_util::sync::CancellationToken::new())
        .await;

    let resumed = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(resumed.status, "completed", "the artifact must be adopted");
    assert_eq!(
        resumed.checksum_verified,
        Some(true),
        "adoption re-verifies the hash"
    );
    assert_eq!(
        resumed.destination_path.unwrap(),
        final_path,
        "no name (2) drift — the destination is bound, not re-uniquified"
    );
    // The resume run probes (GET bytes=0-0) before reconciliation — exactly one extra
    // request and no segment rows must remain: zero body bytes were fetched.
    assert_eq!(
        server.request_count(),
        requests_after_completion + 1,
        "adoption must fetch no body bytes (probe only)"
    );
    assert!(
        store.list_segments(job.id.as_str()).unwrap().is_empty(),
        "adoption drops the phantom journal"
    );
    let on_disk = tokio::fs::read(&final_path).await.unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn crash_after_rename_adopts_on_size_proof_without_checksum() {
    let body = body(1024 * 1024);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir))
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
    let done = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(done.status, "completed");
    let final_path = done.destination_path.clone().unwrap();
    let requests_after_completion = server.request_count();

    let mut crashed = done;
    crashed.status = "downloading".into();
    crashed.checksum_actual = None;
    store.update_job(&crashed).unwrap();

    let (_cmd_tx2, cmd_rx2) = mpsc::channel(4);
    engine
        .clone()
        .run_job(crashed, cmd_rx2, tokio_util::sync::CancellationToken::new())
        .await;

    let resumed = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(resumed.status, "completed");
    assert_eq!(resumed.destination_path.unwrap(), final_path);
    assert_eq!(
        server.request_count(),
        requests_after_completion + 1,
        "offset-mode adoption is proven by the size match (probe only)"
    );
    assert!(store.list_segments(job.id.as_str()).unwrap().is_empty());
    let on_disk = tokio::fs::read(&final_path).await.unwrap();
    assert_eq!(on_disk, body);
}

#[tokio::test]
async fn adoption_refuses_a_corrupt_artifact_and_redownloads() {
    let body = body(1024 * 1024);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    let expected = sha256_hex(&body);

    let job = engine
        .create_job(with_checksum(
            params(server.base_url.clone(), &dir),
            ChecksumAlgorithm::Sha256,
            expected,
        ))
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
    let done = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(done.status, "completed");
    let final_path = done.destination_path.clone().unwrap();

    // Corrupt the artifact BEHIND the crash simulation: the size still matches, the
    // hash no longer does — adoption must refuse and the re-download must restore
    // correct bytes without ever touching the corrupt file.
    let mut corrupted = body.clone();
    corrupted[0] ^= 0xFF;
    tokio::fs::write(&final_path, &corrupted).await.unwrap();

    let mut crashed = done;
    crashed.status = "downloading".into();
    crashed.checksum_actual = None;
    crashed.checksum_verified = None;
    store.update_job(&crashed).unwrap();

    let (_cmd_tx2, cmd_rx2) = mpsc::channel(4);
    engine
        .clone()
        .run_job(crashed, cmd_rx2, tokio_util::sync::CancellationToken::new())
        .await;

    let resumed = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(
        resumed.status, "completed",
        "re-download restores the artifact"
    );
    assert_eq!(resumed.checksum_verified, Some(true));
    let new_path = resumed.destination_path.clone().unwrap();
    let on_disk = tokio::fs::read(&new_path).await.unwrap();
    assert_eq!(on_disk, body, "the adopted name must hold the TRUE bytes");
    // The corrupt file is user data — never deleted by the engine.
    let suspect = tokio::fs::read(&final_path).await.unwrap();
    assert_eq!(suspect, corrupted, "the engine must not destroy files");
}

#[tokio::test]
async fn bit_rot_in_a_paused_part_fails_typed_and_keeps_the_part() {
    let body = body(4 * 1024 * 1024);
    let server = common::TestServer::start_with(
        body.clone(),
        vec![],
        10,
        16 * 1024,
        common::ServerToggles::default(),
    )
    .await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());
    engine.set_max_connections(4);
    let expected = sha256_hex(&body);

    let job = engine
        .create_job(with_checksum(
            params(server.base_url.clone(), &dir),
            ChecksumAlgorithm::Sha256,
            expected,
        ))
        .await
        .unwrap();
    let paused = pause_mid_run(&engine, &store, &job, ProgressWitness::Aggregate).await;

    // Bit-rot inside the WRITTEN region: offset 0 belongs to window 0's cursor.
    let part = dir.join("file.part");
    let mut f = std::fs::OpenOptions::new().write(true).open(&part).unwrap();
    f.write_all(&[0xAB]).unwrap();
    drop(f);

    resume_to_terminal(&engine, &store, &paused).await;
    let finished = store.get_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(finished.status, "failed");
    assert_eq!(
        finished.error_code.as_deref(),
        Some(ErrorCode::ChecksumMismatch.as_str()),
        "rot must be caught by the completion verdict"
    );
    assert!(
        part.exists(),
        "the part is kept for inspection (a failed verdict never destroys bytes)"
    );
}

#[tokio::test]
async fn journal_never_leads_the_part_file_during_live_runs() {
    let body = body(4 * 1024 * 1024);
    // Append mode (range-less) at 4 MiB so the 1 MiB journal flush cadence fires.
    let toggles = common::ServerToggles {
        disable_ranges: true,
        ..Default::default()
    };
    let server = common::TestServer::start_with(body.clone(), vec![], 2, 64 * 1024, toggles).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    let job = engine
        .create_job(params(server.base_url.clone(), &dir))
        .await
        .unwrap();

    // Live invariant sampler: at every observed moment the persisted journal cursor must
    // be backed by the part file's real length (F-3 fsync discipline, process-level).
    let stop_sampler = Arc::new(AtomicBool::new(false));
    let sampler_store = store.clone();
    let sampler_stop = stop_sampler.clone();
    let sampler = tokio::spawn(async move {
        while !sampler_stop.load(Ordering::SeqCst) {
            for j in sampler_store.list_jobs().unwrap_or_default() {
                let journaled: u64 = sampler_store
                    .list_segments(j.id.as_str())
                    .map(|rows| rows.iter().map(|r| r.written_bytes).sum())
                    .unwrap_or(0);
                if journaled == 0 {
                    continue;
                }
                if let Some(dp) = &j.destination_path {
                    let part_path = PathBuf::from(format!("{dp}.part"));
                    if let Ok(meta) = tokio::fs::metadata(&part_path).await {
                        assert!(
                            journaled <= meta.len(),
                            "journal led the part file: {journaled} > {}",
                            meta.len()
                        );
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    });

    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    engine
        .clone()
        .run_job(job, cmd_rx, tokio_util::sync::CancellationToken::new())
        .await;
    let finished = store.list_jobs().unwrap().into_iter().next().unwrap();
    assert_eq!(finished.status, "completed");
    let on_disk = tokio::fs::read(finished.destination_path.unwrap())
        .await
        .unwrap();
    assert_eq!(on_disk, body);

    stop_sampler.store(true, Ordering::SeqCst);
    // Join errors if the sampler ever caught a violation (it asserts inside).
    sampler.await.unwrap();
}

#[tokio::test]
async fn sha1_and_md5_expectations_are_honored_at_completion() {
    // F-4: the completion verdict must hash with the job's declared algorithm — comparing
    // a sha1/md5 expectation against a SHA-256 digest failed every honest download.
    for (algorithm, digest_len) in [
        (ChecksumAlgorithm::Sha1, 40usize),
        (ChecksumAlgorithm::Md5, 32usize),
    ] {
        let body = body(64 * 1024);
        let server = common::TestServer::start(body.clone(), vec![], 0).await;
        let dir = tempdir();
        let store = Arc::new(JobStore::open_in_memory().unwrap());
        let engine = make_engine(store.clone());

        let expected = match algorithm {
            ChecksumAlgorithm::Sha1 => {
                let mut h = sha1::Sha1::default();
                h.update(&body);
                download_core::segments::to_hex(&h.finalize())
            }
            ChecksumAlgorithm::Md5 => {
                let mut h = md5::Md5::default();
                h.update(&body);
                download_core::segments::to_hex(&h.finalize())
            }
            ChecksumAlgorithm::Sha256 => sha256_hex(&body),
        };
        assert_eq!(expected.len(), digest_len);

        let job = engine
            .create_job(with_checksum(
                params(server.base_url.clone(), &dir),
                algorithm,
                expected,
            ))
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
        assert_eq!(finished.status, "completed", "{algorithm:?} must complete");
        assert_eq!(
            finished.checksum_verified,
            Some(true),
            "{algorithm:?} verdict"
        );
        assert_eq!(
            finished.checksum_actual.unwrap_or_default().len(),
            digest_len,
            "the recorded digest must be in the job's algorithm"
        );
        let on_disk = tokio::fs::read(finished.destination_path.unwrap())
            .await
            .unwrap();
        assert_eq!(on_disk, body);
    }
}

#[tokio::test]
async fn wrong_md5_expectation_fails_typed() {
    let body = body(64 * 1024);
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let dir = tempdir();
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    // A 32-hex value that is NOT the body's md5 (all zeros) — the verdict must fail.
    let job = engine
        .create_job(with_checksum(
            params(server.base_url.clone(), &dir),
            ChecksumAlgorithm::Md5,
            "0".repeat(32),
        ))
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
    assert_eq!(
        finished.error_code.as_deref(),
        Some(ErrorCode::ChecksumMismatch.as_str())
    );
}
