//! Storage integration tests: migrations, CRUD, durability semantics.

use dc_protocol::job::DownloadJob;
use dc_protocol::Ulid;
use dc_storage::JobStore;
use std::path::PathBuf;

fn sample_job(id: &str, status: &str) -> DownloadJob {
    DownloadJob {
        id: Ulid(id.to_string()),
        url: "https://example.com/file.zip".into(),
        destination_dir: "/tmp".into(),
        destination_path: Some("/tmp/file.zip".into()),
        filename: Some("file.zip".into()),
        status: status.into(),
        total_bytes: Some(1000),
        received_bytes: 0,
        etag: Some("\"v1\"".into()),
        last_modified: None,
        content_type: Some("application/zip".into()),
        speed_bps: None,
        eta_seconds: None,
        error_code: None,
        headers: None,
        created_at: 1735689600000,
        updated_at: 1735689600000,
    }
}

fn valid_ulid(n: u32) -> String {
    // derive unique valid ULIDs from the generator for uniqueness guarantees
    let _ = n;
    dc_protocol::new_ulid().0
}

#[test]
fn applies_migrations_once_and_reports_version() {
    let dir = tempdir();
    let db = dir.join("jobs.db");
    let store = JobStore::open(&db).unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
    drop(store);
    let store2 = JobStore::open(&db).unwrap();
    assert_eq!(store2.schema_version().unwrap(), 1);
}

#[test]
fn job_crud_round_trip() {
    let store = JobStore::open_in_memory().unwrap();
    let id = valid_ulid(0);
    let mut job = sample_job(&id, "queued");

    store.insert_job(&job).unwrap();
    assert!(store.get_job(&id).unwrap().is_some());

    job.status = "downloading".into();
    job.received_bytes = 512;
    store.update_job(&job).unwrap();

    let loaded = store.get_job(&id).unwrap().unwrap();
    assert_eq!(loaded.status, "downloading");
    assert_eq!(loaded.received_bytes, 512);
    assert_eq!(loaded.etag.as_deref(), Some("\"v1\""));

    store.update_progress(&id, 900, 2048, Some(5)).unwrap();
    let loaded = store.get_job(&id).unwrap().unwrap();
    assert_eq!(loaded.received_bytes, 900);
    assert_eq!(loaded.speed_bps, Some(2048));
    assert_eq!(loaded.eta_seconds, Some(5));

    assert_eq!(store.list_jobs().unwrap().len(), 1);
    assert!(store.delete_job(&id).unwrap());
    assert!(store.get_job(&id).unwrap().is_none());
}

#[test]
fn update_of_missing_job_is_invalid_state() {
    let store = JobStore::open_in_memory().unwrap();
    let mut job = sample_job(&valid_ulid(1), "queued");
    job.id = Ulid(dc_protocol::new_ulid().0);
    // do not insert — update must fail with invalid_state, not create
    let err = store.update_job(&job).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid_state");
}

#[test]
fn data_survives_reopen() {
    let dir = tempdir();
    let db = dir.join("jobs.db");
    let id = valid_ulid(2);
    {
        let store = JobStore::open(&db).unwrap();
        store.insert_job(&sample_job(&id, "paused")).unwrap();
    }
    {
        let store = JobStore::open(&db).unwrap();
        let job = store.get_job(&id).unwrap().unwrap();
        assert_eq!(job.status, "paused");
    }
}

fn tempdir() -> PathBuf {
    let base = std::env::temp_dir();
    let dir = base.join(format!(
        "dc-storage-test-{}-{}",
        std::process::id(),
        dc_protocol::new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
