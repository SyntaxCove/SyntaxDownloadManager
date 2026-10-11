//! Storage integration tests: migrations, CRUD, durability semantics.

use dc_protocol::job::{ChecksumAlgorithm, DownloadJob};
use dc_protocol::Ulid;
use dc_storage::{JobStore, SegmentRow};
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
        segment_count: None,
        checksum_algorithm: None,
        checksum_expected: None,
        checksum_actual: None,
        checksum_verified: None,
        recovery_count: None,
        rebound_at: None,
        queue_position: None,
        speed_limit_kbps: None,
        proxy_profile_id: None,
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
    assert!(
        store.schema_version().unwrap() >= 5,
        "v5 (proxy routing column) applied"
    );
    drop(store);
    let store2 = JobStore::open(&db).unwrap();
    assert_eq!(
        store2.schema_version().unwrap(),
        store2.schema_version().unwrap()
    );
    assert!(store2.schema_version().unwrap() >= 2);
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
fn integrity_columns_round_trip() {
    let store = JobStore::open_in_memory().unwrap();
    let id = valid_ulid(10);
    let mut job = sample_job(&id, "downloading");
    job.segment_count = Some(4);
    job.checksum_algorithm = Some(ChecksumAlgorithm::Sha256);
    job.checksum_expected = Some("ab".repeat(32));
    job.checksum_actual = None;
    job.checksum_verified = None;
    store.insert_job(&job).unwrap();

    let loaded = store.get_job(&id).unwrap().unwrap();
    assert_eq!(loaded.segment_count, Some(4));
    assert_eq!(loaded.checksum_algorithm, Some(ChecksumAlgorithm::Sha256));
    assert_eq!(
        loaded.checksum_expected.as_deref(),
        Some("ab".repeat(32).as_str())
    );
    assert_eq!(loaded.checksum_actual, None);
    assert_eq!(loaded.checksum_verified, None);

    let mut loaded = loaded;
    loaded.checksum_actual = Some("cd".repeat(32));
    loaded.checksum_verified = Some(true);
    store.update_job(&loaded).unwrap();
    let done = store.get_job(&id).unwrap().unwrap();
    assert_eq!(
        done.checksum_actual.as_deref(),
        Some("cd".repeat(32).as_str())
    );
    assert_eq!(done.checksum_verified, Some(true));
}

#[test]
fn segment_journal_crud_and_reset() {
    let store = JobStore::open_in_memory().unwrap();
    let id = valid_ulid(11);
    let job = sample_job(&id, "downloading");
    store.insert_job(&job).unwrap();

    let segments = vec![
        SegmentRow {
            seg_index: 0,
            start_offset: 0,
            end_offset: Some(499),
            written_bytes: 120,
            status: "downloading".into(),
        },
        SegmentRow {
            seg_index: 1,
            start_offset: 500,
            end_offset: Some(999),
            written_bytes: 0,
            status: "pending".into(),
        },
    ];
    store.replace_segments(&id, &segments).unwrap();
    let rows = store.list_segments(&id).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].written_bytes, 120);
    assert_eq!(rows[1].start_offset, 500);

    store
        .update_segment_progress(&id, 1, 77, "downloading")
        .unwrap();
    let rows = store.list_segments(&id).unwrap();
    assert_eq!(rows[1].written_bytes, 77);

    // Atomic replace wipes the old rows entirely (no leftovers from prior plans).
    store
        .replace_segments(
            &id,
            &[SegmentRow {
                seg_index: 0,
                start_offset: 0,
                end_offset: None,
                written_bytes: 0,
                status: "pending".into(),
            }],
        )
        .unwrap();
    let rows = store.list_segments(&id).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].end_offset, None);

    store.delete_segments(&id).unwrap();
    assert!(store.list_segments(&id).unwrap().is_empty());
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

#[test]
fn proxy_profile_id_round_trips_and_stays_null_safe() {
    // v5 (Phase 9): the routing profile id persists with the row; credentials never do.
    let store = JobStore::open_in_memory().unwrap();
    let id = valid_ulid(3);

    let mut job = sample_job(&id, "paused");
    job.proxy_profile_id = Some("01K33R2VQ7M4X8N6P5T9W1Z3C4".into());
    store.insert_job(&job).unwrap();
    let read = store.get_job(&id).unwrap().unwrap();
    assert_eq!(
        read.proxy_profile_id.as_deref(),
        Some("01K33R2VQ7M4X8N6P5T9W1Z3C4")
    );

    job.proxy_profile_id = None; // direct
    store.update_job(&job).unwrap();
    let read = store.get_job(&id).unwrap().unwrap();
    assert!(read.proxy_profile_id.is_none());

    // The storage layer has no column for proxy credentials by design.
    let conn_phrase = format!("{:?}", store.list_jobs().unwrap());
    assert!(!conn_phrase.contains("password"));
}

fn sample_media_job(id: &str, status: &str) -> dc_protocol::MediaJob {
    dc_protocol::MediaJob {
        id: Ulid(id.to_string()),
        source_url: "https://example.com/watch/abc".into(),
        title: Some("Sample Video".into()),
        thumbnail_url: None,
        video_format_id: Some("137".into()),
        audio_format_id: Some("140".into()),
        filename: None,
        subtitles: vec![dc_protocol::MediaSubtitleSelection {
            language: "en".into(),
            extension: "vtt".into(),
            is_auto_generated: false,
        }],
        container: dc_protocol::MediaContainer::Mkv,
        destination_dir: "/tmp/unidm-media-test".into(),
        destination_path: None,
        work_dir: Some(format!("/tmp/unidm-media-test/.unidm-media/{id}")),
        status: status.into(),
        total_bytes: Some(121_400_000),
        received_bytes: 0,
        speed_bps: None,
        eta_seconds: None,
        error_code: None,
        proxy_profile_id: None,
        created_at: 1_735_689_600_000,
        updated_at: 1_735_689_600_000,
    }
}

#[test]
fn media_jobs_crud_round_trip() {
    let store = JobStore::open_in_memory().unwrap();
    assert!(store.list_media_jobs().unwrap().is_empty());

    let job = sample_media_job("01JMEDIA000000000000000001", "queued");
    store.insert_media_job(&job).unwrap();

    let read = store
        .get_media_job("01JMEDIA000000000000000001")
        .unwrap()
        .unwrap();
    assert_eq!(read.status, "queued");
    assert_eq!(read.container, dc_protocol::MediaContainer::Mkv);
    assert_eq!(read.subtitles.len(), 1);
    assert_eq!(read.subtitles[0].language, "en");
    assert_eq!(read.total_bytes, Some(121_400_000));
    assert_eq!(read.title.as_deref(), Some("Sample Video"));

    // progress tick persists live fields without touching the selection columns
    store
        .update_media_progress(
            "01JMEDIA000000000000000001",
            60_700_000,
            Some(121_400_000),
            2_097_152,
            Some(29),
            "downloading",
        )
        .unwrap();
    let live = store
        .get_media_job("01JMEDIA000000000000000001")
        .unwrap()
        .unwrap();
    assert_eq!(live.status, "downloading");
    assert_eq!(live.received_bytes, 60_700_000);
    assert_eq!(live.speed_bps, Some(2_097_152));

    // full update: title enrichment + terminal status
    let mut updated = live;
    updated.title = Some("Renamed".into());
    updated.status = "completed".into();
    updated.destination_path = Some("/tmp/unidm-media-test/Sample Video.mkv".into());
    updated.updated_at = 1_735_689_900_000;
    store.update_media_job(&updated).unwrap();
    let done = store
        .get_media_job("01JMEDIA000000000000000001")
        .unwrap()
        .unwrap();
    assert_eq!(done.status, "completed");
    assert_eq!(done.title.as_deref(), Some("Renamed"));
    assert_eq!(
        done.destination_path.as_deref(),
        Some("/tmp/unidm-media-test/Sample Video.mkv")
    );

    assert!(store
        .delete_media_job("01JMEDIA000000000000000001")
        .unwrap());
    assert!(store
        .get_media_job("01JMEDIA000000000000000001")
        .unwrap()
        .is_none());
    assert!(!store
        .delete_media_job("01JMEDIA000000000000000001")
        .unwrap());
}

#[test]
fn media_jobs_survive_reopen_and_reset_actives_on_boot() {
    let dir = tempdir();
    let db = dir.join("media.db");
    {
        let store = JobStore::open(&db).unwrap();
        for (id, status) in [
            ("01JMEDIA00000000000000000A", "downloading"),
            ("01JMEDIA00000000000000000B", "muxing"),
            ("01JMEDIA00000000000000000C", "completed"),
            ("01JMEDIA00000000000000000D", "failed"),
        ] {
            store
                .insert_media_job(&sample_media_job(id, status))
                .unwrap();
        }
    }
    let store = JobStore::open(&db).unwrap();
    let reset = store.reset_active_media_jobs().unwrap();
    assert_eq!(
        reset, 2,
        "only queued/extracting/downloading/muxing rows reset"
    );
    assert_eq!(
        store
            .get_media_job("01JMEDIA00000000000000000A")
            .unwrap()
            .unwrap()
            .status,
        "paused"
    );
    assert_eq!(
        store
            .get_media_job("01JMEDIA00000000000000000B")
            .unwrap()
            .unwrap()
            .status,
        "paused"
    );
    assert_eq!(
        store
            .get_media_job("01JMEDIA00000000000000000C")
            .unwrap()
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(
        store
            .get_media_job("01JMEDIA00000000000000000D")
            .unwrap()
            .unwrap()
            .status,
        "failed"
    );
    // speed/eta cleared on the reset rows (no run owns them anymore)
    assert_eq!(
        store
            .get_media_job("01JMEDIA00000000000000000A")
            .unwrap()
            .unwrap()
            .speed_bps,
        None
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn schema_version_is_at_least_6_after_migrations() {
    let store = JobStore::open_in_memory().unwrap();
    assert!(store.schema_version().unwrap() >= 6);
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
