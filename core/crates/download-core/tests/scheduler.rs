//! Phase 15 — scheduler engine tests. The occurrence math runs as unit tests inside
//! `src/scheduler.rs`; here the fire pipeline, outcome recording, schedule advancement,
//! clock recompute and the boundary classification are proven against an in-memory store.
//!
//! Tick-race discipline: every test's manager runs the real 1 s tick, so tests keep
//! tick-immune rows in the future and assert END states after fires (identical whether
//! the tick or the test fired the row — the in-flight guard forbids double fires).
//! runNow tests create rows disabled, because an explicit manual fire must never race
//! the due query.

use std::sync::Arc;

use dc_storage::JobStore;
use download_core::JobManager;

fn make_manager() -> Arc<JobManager> {
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    JobManager::new(store, tokio::sync::mpsc::unbounded_channel().0)
}

fn day() -> i64 {
    86_400_000
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn create_params(
    kind: &str,
    payload: serde_json::Value,
    start_at: i64,
) -> dc_protocol::SchedulerCreateParams {
    dc_protocol::SchedulerCreateParams {
        kind: kind.into(),
        payload,
        start_at,
        repeat: "none".into(),
        enabled: false,
    }
}

fn find<'a>(
    rows: &'a [dc_protocol::SchedulerJob],
    id: &dc_protocol::Ulid,
) -> &'a dc_protocol::SchedulerJob {
    rows.iter().find(|j| j.id == *id).expect("row present")
}

#[tokio::test]
async fn one_shot_scheduled_fire_disables_the_row_and_records_ok() {
    let manager = make_manager();
    let start = now_ms() - 5_000; // due
    let mut params = create_params("download.startAll", serde_json::json!({}), start);
    params.enabled = true;
    let job = manager.scheduler_create(params).unwrap();
    assert_eq!(
        job.next_run_at,
        Some(start),
        "the anchor is the first occurrence"
    );

    assert_eq!(
        manager.scheduler_fire_due().await,
        1,
        "the due one-shot fired once"
    );

    let rows = manager.scheduler_list().unwrap();
    let row = find(&rows, &job.id);
    assert!(!row.enabled, "a fired one-shot disables itself");
    assert_eq!(row.next_run_at, None);
    assert!(row.last_fired_at.is_some());
    assert_eq!(row.last_result_code.as_deref(), Some("ok"));
    assert!(row
        .last_result_message
        .as_deref()
        .unwrap_or_default()
        .starts_with("started"));

    // The disabled row is no longer due — a second sweep is a no-op.
    assert_eq!(manager.scheduler_fire_due().await, 0);
}

#[tokio::test]
async fn daily_fire_records_ok_and_advances_one_wall_day() {
    let manager = make_manager();
    let start = now_ms() - 5_000;
    let mut params = create_params("download.startAll", serde_json::json!({}), start);
    params.enabled = true;
    params.repeat = "daily".into();
    let job = manager.scheduler_create(params).unwrap();

    assert_eq!(manager.scheduler_fire_due().await, 1);

    let rows = manager.scheduler_list().unwrap();
    let row = find(&rows, &job.id);
    assert!(
        row.enabled,
        "a fire — ok or not — never kills a repeating schedule"
    );
    assert_eq!(row.last_result_code.as_deref(), Some("ok"));
    let next = row.next_run_at.expect("daily job stays scheduled");
    assert!(next > now_ms(), "next slot is strictly in the future");
    assert!(
        (next - (start + day())).abs() < 5_000,
        "first advance lands one wall day after the anchor (tz=0 in tests)"
    );
}

#[tokio::test]
async fn download_create_fire_creates_a_real_queued_download_job() {
    let manager = make_manager();
    let start = now_ms() + day(); // future: the tick must not fire this
    let mut params = create_params(
        "download.create",
        serde_json::json!({
            "url": "http://127.0.0.1:1/unidm-scheduler-test.bin",
            "destinationDir": "/tmp/unidm-scheduler-test"
        }),
        start,
    );
    params.enabled = true;
    let job = manager.scheduler_create(params).unwrap();

    let fired = manager.scheduler_run_now(job.id.as_str()).await.unwrap();
    assert_eq!(fired.last_result_code.as_deref(), Some("ok"));
    assert!(fired
        .last_result_message
        .as_deref()
        .unwrap_or_default()
        .starts_with("created download job"));
    // runNow never touches the schedule.
    assert_eq!(fired.next_run_at, Some(start));
    assert!(fired.enabled);
    // The action really went through the manager: a download row exists for the URL.
    let downloads = manager.list().unwrap();
    assert!(downloads
        .iter()
        .any(|j| j.url == "http://127.0.0.1:1/unidm-scheduler-test.bin"));
}

#[tokio::test]
async fn boundary_failures_land_on_the_row_as_classified_outcomes() {
    let manager = make_manager();

    // Non-http(s) URL: rejected by the dispatch boundary → url_invalid on the row.
    let ftp = manager
        .scheduler_create(create_params(
            "download.create",
            serde_json::json!({ "url": "ftp://example.com/x", "destinationDir": "/tmp" }),
            now_ms() + day(),
        ))
        .unwrap();
    let fired = manager.scheduler_run_now(ftp.id.as_str()).await.unwrap();
    assert_eq!(fired.last_result_code.as_deref(), Some("url_invalid"));
    assert!(
        !fired.enabled,
        "a manual fire leaves the schedule (incl. enabled) untouched"
    );
    assert_eq!(fired.next_run_at, None, "a disabled row keeps no schedule");

    // A checksum whose hex length mismatches the algorithm: normalized at dispatch →
    // invalid_params on the row.
    let bad_sum = manager
        .scheduler_create(create_params(
            "download.create",
            serde_json::json!({
                "url": "https://example.com/x",
                "destinationDir": "/tmp",
                "checksum": { "algorithm": "sha256", "value": "abc" }
            }),
            now_ms() + day(),
        ))
        .unwrap();
    let fired = manager
        .scheduler_run_now(bad_sum.id.as_str())
        .await
        .unwrap();
    assert_eq!(fired.last_result_code.as_deref(), Some("invalid_params"));
}

#[tokio::test]
async fn run_now_on_unknown_row_is_invalid_state() {
    let manager = make_manager();
    let err = manager
        .scheduler_run_now("01K4SCHE0000000000000000AA")
        .await
        .unwrap_err();
    assert_eq!(err.code.as_str(), "invalid_state");
}

#[tokio::test]
async fn set_clock_moves_repeating_rows_to_the_same_wall_time() {
    let manager = make_manager();
    let start = now_ms() + day(); // future anchor, tick-immune
    let mut params = create_params("download.startAll", serde_json::json!({}), start);
    params.enabled = true;
    params.repeat = "daily".into();
    let daily = manager.scheduler_create(params).unwrap();
    // A one-shot must never move with the clock (enabled: it carries a schedule).
    let mut one_shot_params = create_params("download.startAll", serde_json::json!({}), start);
    one_shot_params.enabled = true;
    let one_shot = manager.scheduler_create(one_shot_params).unwrap();

    // tz starts at 0; pushing UTC+03:30 shifts the epoch of the same wall slot.
    let moved = manager.scheduler_set_clock(210).unwrap();
    assert_eq!(moved, 1, "only the repeating row is clock-sensitive");

    let rows = manager.scheduler_list().unwrap();
    assert_eq!(
        find(&rows, &daily.id).next_run_at.unwrap(),
        start - 210 * 60_000,
        "same 24h-later wall slot, re-expressed under UTC+03:30"
    );
    assert_eq!(
        find(&rows, &one_shot.id).next_run_at.unwrap(),
        start,
        "one-shot anchors never move"
    );

    // Pushing back to UTC+0 restores the original epoch (idempotent wall math).
    manager.scheduler_set_clock(0).unwrap();
    let rows = manager.scheduler_list().unwrap();
    assert_eq!(find(&rows, &daily.id).next_run_at.unwrap(), start);
}

#[tokio::test]
async fn update_re_derives_the_schedule_and_re_arms_one_shots() {
    let manager = make_manager();
    let start = now_ms() + day();
    let job = manager
        .scheduler_create(create_params(
            "download.startAll",
            serde_json::json!({}),
            start,
        ))
        .unwrap();
    let id = job.id.as_str().to_string();

    // A fired (manual) one-shot row: outcome recorded, schedule untouched.
    manager.scheduler_run_now(&id).await.unwrap();
    let rows = manager.scheduler_list().unwrap();
    let row = find(&rows, &job.id);
    assert!(!row.enabled);
    assert_eq!(row.next_run_at, None);
    assert_eq!(row.last_result_code.as_deref(), Some("ok"));

    // Re-enabling re-arms it at its anchor, honored verbatim.
    let rearmed = manager
        .scheduler_update(dc_protocol::SchedulerUpdateParams {
            id: job.id.clone(),
            patch: dc_protocol::SchedulerPatch {
                start_at: None,
                repeat: None,
                enabled: Some(true),
                payload: None,
            },
        })
        .unwrap();
    assert!(rearmed.enabled);
    assert_eq!(rearmed.next_run_at, Some(start));

    // Switching to weekly re-derives from the wall anchor (future anchor → itself).
    let weekly = manager
        .scheduler_update(dc_protocol::SchedulerUpdateParams {
            id: job.id.clone(),
            patch: dc_protocol::SchedulerPatch {
                start_at: None,
                repeat: Some("weekly".into()),
                enabled: None,
                payload: None,
            },
        })
        .unwrap();
    assert_eq!(weekly.repeat, "weekly");
    assert_eq!(weekly.next_run_at, Some(start));

    // A startAt edit re-anchors (wall anchor moves with the current tz).
    let new_start = now_ms() + 2 * day();
    let moved = manager
        .scheduler_update(dc_protocol::SchedulerUpdateParams {
            id: job.id.clone(),
            patch: dc_protocol::SchedulerPatch {
                start_at: Some(new_start),
                repeat: None,
                enabled: None,
                payload: None,
            },
        })
        .unwrap();
    assert_eq!(moved.start_at, new_start);
    assert_eq!(moved.next_run_at, Some(new_start));

    // Unknown id → invalid_state.
    assert!(manager
        .scheduler_update(dc_protocol::SchedulerUpdateParams {
            id: dc_protocol::Ulid("01K4SCHE0000000000000000AA".into()),
            patch: dc_protocol::SchedulerPatch::default(),
        })
        .is_err());
}

#[tokio::test]
async fn invalid_actions_repeats_and_payloads_are_classified_at_the_boundary() {
    let manager = make_manager();
    let now = now_ms();

    let mut p = create_params("media.inspect", serde_json::json!({}), now);
    assert_eq!(
        manager
            .scheduler_create(p.clone())
            .unwrap_err()
            .code
            .as_str(),
        "invalid_params",
        "unknown action rejected"
    );
    p.kind = "download.create".into();
    p.repeat = "monthly".into();
    assert_eq!(
        manager
            .scheduler_create(p.clone())
            .unwrap_err()
            .code
            .as_str(),
        "invalid_params",
        "unknown repeat rejected"
    );
    p.repeat = "none".into();
    p.payload = serde_json::json!({ "url": "https://example.com/x" }); // missing destinationDir
    assert_eq!(
        manager.scheduler_create(p).unwrap_err().code.as_str(),
        "invalid_params",
        "per-kind payload validation rejects wrong shapes"
    );
}

#[tokio::test]
async fn due_sweep_replays_the_schedule_in_order() {
    let manager = make_manager();
    let now = now_ms();
    // earlier = pauseAll (fires first by next_run_at), later = startAll.
    let mut earlier = create_params("download.pauseAll", serde_json::json!({}), now - 2_000);
    earlier.enabled = true;
    let mut later = create_params("download.startAll", serde_json::json!({}), now - 1_000);
    later.enabled = true;
    let a = manager.scheduler_create(earlier).unwrap();
    let b = manager.scheduler_create(later).unwrap();

    assert_eq!(manager.scheduler_fire_due().await, 2);
    let rows = manager.scheduler_list().unwrap();
    for id in [a.id, b.id] {
        let row = find(&rows, &id);
        assert_eq!(row.last_result_code.as_deref(), Some("ok"));
        assert_eq!(row.next_run_at, None, "one-shots consumed by the sweep");
    }
    assert_eq!(manager.scheduler_fire_due().await, 0);
}

#[tokio::test]
async fn set_clock_never_steals_a_pending_catch_up_fire() {
    let manager = make_manager();
    let start = now_ms() - 5_000; // due: missed while "closed"
    let mut params = create_params("download.startAll", serde_json::json!({}), start);
    params.enabled = true;
    params.repeat = "daily".into();
    let job = manager.scheduler_create(params).unwrap();

    // The boot-time clock push must NOT push the missed slot into the future.
    manager.scheduler_set_clock(210).unwrap();
    let rows = manager.scheduler_list().unwrap();
    let row = find(&rows, &job.id);
    assert_eq!(
        row.next_run_at,
        Some(start),
        "a due row is catch-up pending; setClock leaves it for the tick"
    );

    // The sweep then fires it exactly once and advances from the wall anchor.
    assert_eq!(manager.scheduler_fire_due().await, 1);
    let rows = manager.scheduler_list().unwrap();
    let row = find(&rows, &job.id);
    assert_eq!(row.last_result_code.as_deref(), Some("ok"));
    let next = row.next_run_at.expect("repeating job stays scheduled");
    assert!(next > now_ms());
}
