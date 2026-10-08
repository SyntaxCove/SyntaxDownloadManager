//! Phase 8 integration tests: queue ordering + reorder, start/pause-all, scheduler
//! policy (auto-start parking, daily window pausing auto runs and sparing manual runs)
//! and token-bucket bandwidth limiting (global + per-job) against a real HTTP server.

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dc_protocol::job::DownloadJob;
use dc_protocol::new_ulid;
use dc_storage::JobStore;
use download_core::engine::{CreateJobParams, Engine};
use download_core::manager::{in_window_minute, local_minute_of_day, JobManager, QueueDirection};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dc-queue-test-{}-{}",
        std::process::id(),
        new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn params(url: String, dir: &std::path::Path) -> CreateJobParams {
    CreateJobParams {
        url,
        destination_dir: dir.display().to_string(),
        filename: None,
        overwrite: false,
        headers: None,
        checksum: None,
    }
}

fn make_manager(store: Arc<JobStore>) -> Arc<JobManager> {
    let (tx, _rx) = mpsc::unbounded_channel();
    JobManager::new(store, tx)
}

/// A server whose body downloads slowly enough to keep an active job busy during
/// queue assertions (40 KiB in 1 KiB chunks every 8 ms ≈ 320 ms+).
async fn slow_server() -> Arc<common::TestServer> {
    let body: Vec<u8> = (0..40_960u32).map(|i| (i % 243) as u8).collect();
    common::TestServer::start_with(body.clone(), vec![], 8, 1024, Default::default()).await
}

async fn wait_for_status(
    store: &JobStore,
    id: &str,
    statuses: &[&str],
    timeout: Duration,
) -> DownloadJob {
    let deadline = Instant::now() + timeout;
    loop {
        let job = store.get_job(id).unwrap().expect("job exists");
        if statuses.contains(&job.status.as_str()) {
            return job;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {statuses:?} (is {})",
            job.status
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn make_job(manager: &Arc<JobManager>, server: &common::TestServer) -> DownloadJob {
    manager
        .create(params(server.base_url.clone(), &tempdir()))
        .await
        .unwrap()
}

// ---- queue ordering + reorder ----

#[tokio::test]
async fn queue_positions_are_assigned_and_pump_starts_in_order() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_max_concurrent(1);

    let a = make_job(&manager, &server).await;
    let b = make_job(&manager, &server).await;
    let c = make_job(&manager, &server).await;

    // One slot: the first job runs (position released), the others wait in order.
    let started = wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(
        started.queue_position, None,
        "a running job has no queue slot"
    );

    let qb = store.get_job(b.id.as_str()).unwrap().unwrap();
    let qc = store.get_job(c.id.as_str()).unwrap().unwrap();
    assert_eq!(qb.queue_position, Some(1));
    assert_eq!(qc.queue_position, Some(2));
}

#[tokio::test]
async fn queue_move_reorders_queued_jobs_only() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_max_concurrent(1);

    let a = make_job(&manager, &server).await;
    let b = make_job(&manager, &server).await;
    let c = make_job(&manager, &server).await;
    let d = make_job(&manager, &server).await;
    wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;

    // Move the last queued job to the top.
    let moved = manager
        .queue_move(d.id.as_str(), QueueDirection::Top)
        .unwrap();
    assert_eq!(moved.queue_position, Some(0));
    assert_eq!(
        store
            .get_job(b.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        Some(1)
    );
    assert_eq!(
        store
            .get_job(c.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        Some(2)
    );

    // One step up / down swaps neighbors.
    let up = manager
        .queue_move(c.id.as_str(), QueueDirection::Up)
        .unwrap();
    assert_eq!(up.queue_position, Some(1));
    assert_eq!(
        store
            .get_job(b.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        Some(2)
    );

    let down = manager
        .queue_move(c.id.as_str(), QueueDirection::Down)
        .unwrap();
    assert_eq!(down.queue_position, Some(2));
    assert_eq!(
        store
            .get_job(b.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        Some(1)
    );

    // Bottom from the top slot goes last.
    let bottom = manager
        .queue_move(d.id.as_str(), QueueDirection::Bottom)
        .unwrap();
    assert_eq!(bottom.queue_position, Some(2));

    // A running job is not in the queue → rejected.
    let err = manager
        .queue_move(a.id.as_str(), QueueDirection::Top)
        .unwrap_err();
    assert_eq!(err.code.as_str(), "invalid_state");

    // A paused job is not in the queue either.
    manager.pause(a.id.as_str()).await.unwrap();
    let err = manager
        .queue_move(a.id.as_str(), QueueDirection::Top)
        .unwrap_err();
    assert_eq!(err.code.as_str(), "invalid_state");
}

#[tokio::test]
async fn pause_leaves_queue_and_resume_reenters_at_the_end() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_max_concurrent(2);

    let a = make_job(&manager, &server).await;
    let b = make_job(&manager, &server).await;
    let c = make_job(&manager, &server).await;

    // Two slots → a and b run; c waits with position 2.
    wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;
    wait_for_status(
        &store,
        b.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(
        store
            .get_job(c.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        Some(2)
    );

    // Pausing the queued job leaves the queue.
    manager.pause(c.id.as_str()).await.unwrap();
    assert_eq!(
        store
            .get_job(c.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        None
    );

    // Resuming re-enqueues at the end (max+1 = 3, since a/b released 0/1 on start but
    // the pause of c happened while positions 0..1 were free — c gets a fresh end slot).
    manager.resume(c.id.as_str()).await.unwrap();
    let c2 = wait_for_status(
        &store,
        c.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(c2.queue_position, None, "started job released its slot");
}

// ---- start all / pause all ----

#[tokio::test]
async fn start_all_resumes_paused_jobs_only() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_max_concurrent(1);
    manager
        .set_policy(download_core::manager::SetPolicyParams {
            auto_start_new: false,
            schedule_mode: "always".into(),
            window_start_minute: 0,
            window_end_minute: 0,
            speed_limit_kbps: 0,
            tz_offset_minutes: 0,
        })
        .await;

    let a = make_job(&manager, &server).await;
    let b = make_job(&manager, &server).await;
    assert_eq!(a.status, "paused", "policy parks new jobs");
    assert_eq!(b.status, "paused");

    // A failed job must NOT be resumed by start_all (dedicated recover/retry verbs).
    let c = make_job(&manager, &server).await;
    let mut c = c;
    c.status = "failed".into();
    c.error_code = Some("http_error".into());
    store.update_job(&c).unwrap();

    let started = manager.start_all().await.unwrap();
    assert_eq!(started, 2, "paused jobs only");
    wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(
        store.get_job(c.id.as_str()).unwrap().unwrap().status,
        "failed"
    );
}

#[tokio::test]
async fn pause_all_pauses_active_and_queued_jobs() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_max_concurrent(2);

    let a = make_job(&manager, &server).await;
    let b = make_job(&manager, &server).await;
    let c = make_job(&manager, &server).await;
    wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;

    let paused = manager.pause_all().await.unwrap();
    assert_eq!(paused, 3);
    wait_for_status(&store, a.id.as_str(), &["paused"], Duration::from_secs(3)).await;
    wait_for_status(&store, b.id.as_str(), &["paused"], Duration::from_secs(3)).await;
    assert_eq!(
        store.get_job(c.id.as_str()).unwrap().unwrap().status,
        "paused"
    );
    // The previously queued job released its slot when it left the queue.
    assert_eq!(
        store
            .get_job(c.id.as_str())
            .unwrap()
            .unwrap()
            .queue_position,
        None
    );
}

// ---- per-job speed limit ----

#[tokio::test]
async fn speed_limit_persists_and_zero_clears() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());

    let job = make_job(&manager, &server).await;
    let limited = manager.set_speed_limit(job.id.as_str(), 512).unwrap();
    assert_eq!(limited.speed_limit_kbps, Some(512));

    let cleared = manager.set_speed_limit(job.id.as_str(), 0).unwrap();
    assert_eq!(
        cleared.speed_limit_kbps, None,
        "0 = unlimited = field omitted"
    );

    let err = manager
        .set_speed_limit("01JZZZZZZZZZZZZZZZZZZZZZZZ", 64)
        .unwrap_err();
    assert_eq!(err.code.as_str(), "invalid_state");
}

// ---- scheduler policy ----

#[tokio::test]
async fn window_pauses_auto_runs_and_spares_manual_runs() {
    let server = slow_server().await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_max_concurrent(1);

    let now = local_minute_of_day(0);
    let in_start = now;
    let in_end = (now + 1) % 1440;
    let out_start = (now + 10) % 1440;
    let out_end = (now + 11) % 1440;
    assert!(in_window_minute(now, in_start, in_end));
    assert!(!in_window_minute(now, out_start, out_end));

    // Inside the window → a created job runs.
    manager
        .set_policy(download_core::manager::SetPolicyParams {
            auto_start_new: true,
            schedule_mode: "window".into(),
            window_start_minute: in_start,
            window_end_minute: in_end,
            speed_limit_kbps: 0,
            tz_offset_minutes: 0,
        })
        .await;
    let a = make_job(&manager, &server).await;
    wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;

    // Window closes → the auto-started run is paused.
    manager
        .set_policy(download_core::manager::SetPolicyParams {
            auto_start_new: true,
            schedule_mode: "window".into(),
            window_start_minute: out_start,
            window_end_minute: out_end,
            speed_limit_kbps: 0,
            tz_offset_minutes: 0,
        })
        .await;
    wait_for_status(&store, a.id.as_str(), &["paused"], Duration::from_secs(3)).await;

    // Explicit resume = user intent: the run starts even outside the window…
    manager.resume(a.id.as_str()).await.unwrap();
    wait_for_status(
        &store,
        a.id.as_str(),
        &["probing", "downloading"],
        Duration::from_secs(3),
    )
    .await;

    // …and re-applying the closed window does NOT interrupt the manual run.
    manager
        .set_policy(download_core::manager::SetPolicyParams {
            auto_start_new: true,
            schedule_mode: "window".into(),
            window_start_minute: out_start,
            window_end_minute: out_end,
            speed_limit_kbps: 0,
            tz_offset_minutes: 0,
        })
        .await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let job = store.get_job(a.id.as_str()).unwrap().unwrap();
    assert!(
        matches!(job.status.as_str(), "probing" | "downloading" | "completed"),
        "manual run must be spared by the window close (status {})",
        job.status
    );
}

#[tokio::test]
async fn equal_window_bounds_mean_whole_day() {
    assert!(in_window_minute(0, 0, 0));
    assert!(in_window_minute(719, 0, 0));
    assert!(in_window_minute(1439, 1439, 1439));
}

#[tokio::test]
async fn window_evaluation_covers_normal_and_wrap_over() {
    // Normal window [600, 900).
    assert!(in_window_minute(600, 600, 900));
    assert!(in_window_minute(899, 600, 900));
    assert!(!in_window_minute(900, 600, 900));
    assert!(!in_window_minute(599, 600, 900));
    // Wrap-over [1320, 360) (22:00–06:00).
    assert!(in_window_minute(1320, 1320, 360));
    assert!(in_window_minute(0, 1320, 360));
    assert!(in_window_minute(359, 1320, 360));
    assert!(!in_window_minute(360, 1320, 360));
    assert!(!in_window_minute(1319, 1320, 360));
}

// ---- bandwidth limiting (engine-level, deterministic) ----

fn make_engine(store: Arc<JobStore>) -> Arc<Engine> {
    let (tx, _rx) = mpsc::unbounded_channel();
    Arc::new(Engine::new(store, tx))
}

async fn run_to_completion(engine: &Arc<Engine>, store: &Arc<JobStore>, url: String) -> Duration {
    let dir = tempdir();
    let job = engine
        .create_job(CreateJobParams {
            url,
            destination_dir: dir.display().to_string(),
            filename: None,
            overwrite: false,
            headers: None,
            checksum: None,
        })
        .await
        .unwrap();
    let id = job.id.as_str().to_string();
    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    let started = Instant::now();
    engine
        .clone()
        .run_job(job, cmd_rx, CancellationToken::new())
        .await;
    let finished = store.get_job(&id).unwrap().unwrap();
    assert_eq!(finished.status, "completed");
    started.elapsed()
}

#[tokio::test]
async fn global_speed_limit_paces_the_run() {
    // 256 KiB at 64 KiB/s ≈ 4 s − ~1 s initial burst → well above 2.5 s.
    let body: Vec<u8> = (0..262_144u32).map(|i| (i % 251) as u8).collect();
    let server =
        common::TestServer::start_with(body.clone(), vec![], 0, 8192, Default::default()).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    engine.set_global_speed_kbps(64);
    let limited = run_to_completion(&engine, &store, server.base_url.clone()).await;
    assert!(
        limited >= Duration::from_millis(2500),
        "64 KiB/s must pace 256 KiB to >= 2.5 s, got {limited:?}"
    );

    engine.set_global_speed_kbps(0);
    let unlimited = run_to_completion(&engine, &store, server.base_url.clone()).await;
    assert!(
        unlimited < Duration::from_secs(2),
        "unlimited run must be fast, got {unlimited:?}"
    );
    assert!(
        limited > unlimited,
        "limited run must be slower than unlimited"
    );
}

#[tokio::test]
async fn per_job_speed_limit_paces_the_run() {
    let body: Vec<u8> = (0..262_144u32).map(|i| (i % 249) as u8).collect();
    let server =
        common::TestServer::start_with(body.clone(), vec![], 0, 8192, Default::default()).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let engine = make_engine(store.clone());

    // Pre-create the job bucket through the live-update path (set before the run starts).
    let dir = tempdir();
    let job = engine
        .create_job(CreateJobParams {
            url: server.base_url.clone(),
            destination_dir: dir.display().to_string(),
            filename: None,
            overwrite: false,
            headers: None,
            checksum: None,
        })
        .await
        .unwrap();
    engine.set_job_speed_kbps(job.id.as_str(), 64);

    let (_cmd_tx, cmd_rx) = mpsc::channel(4);
    let started = Instant::now();
    engine
        .clone()
        .run_job(job, cmd_rx, CancellationToken::new())
        .await;
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(2500),
        "per-job 64 KiB/s must pace 256 KiB to >= 2.5 s, got {elapsed:?}"
    );
}
