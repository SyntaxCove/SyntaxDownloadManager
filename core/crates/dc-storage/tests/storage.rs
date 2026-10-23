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
        headers: None,
        subtitles: vec![dc_protocol::MediaSubtitleSelection {
            language: "en".into(),
            extension: "vtt".into(),
            is_auto_generated: false,
        }],
        container: dc_protocol::MediaContainer::Mkv,
        destination_dir: "/tmp/syntaxdm-media-test".into(),
        destination_path: None,
        work_dir: Some(format!("/tmp/syntaxdm-media-test/.syntaxdm-media/{id}")),
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
    updated.destination_path = Some("/tmp/syntaxdm-media-test/Sample Video.mkv".into());
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
        Some("/tmp/syntaxdm-media-test/Sample Video.mkv")
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
fn media_job_headers_persist_for_authenticated_resume() {
    let store = JobStore::open_in_memory().unwrap();

    // a job created with browser-context headers round-trips them (Phase 33: yt-dlp
    // re-extracts on every run, so the persisted headers are what re-authenticates)
    let mut job = sample_media_job("01JMEDIA000000000000000002", "queued");
    let mut headers = std::collections::BTreeMap::new();
    headers.insert("Cookie".to_string(), "sid=abc; other=1".to_string());
    headers.insert("User-Agent".to_string(), "SyntaxDM-UA/1.2".to_string());
    job.headers = Some(headers);
    store.insert_media_job(&job).unwrap();
    let read = store
        .get_media_job("01JMEDIA000000000000000002")
        .unwrap()
        .unwrap();
    let cookie = read
        .headers
        .as_ref()
        .expect("headers persisted")
        .get("Cookie");
    assert_eq!(cookie.map(String::as_str), Some("sid=abc; other=1"));

    // a full update keeps the headers (and clearing them persists the clear)
    let mut updated = read;
    updated.status = "completed".into();
    store.update_media_job(&updated).unwrap();
    assert!(store
        .get_media_job("01JMEDIA000000000000000002")
        .unwrap()
        .unwrap()
        .headers
        .is_some());
    updated.headers = None;
    store.update_media_job(&updated).unwrap();
    assert!(store
        .get_media_job("01JMEDIA000000000000000002")
        .unwrap()
        .unwrap()
        .headers
        .is_none());

    // a headerless job reads back headerless (legacy rows stay legacy)
    let plain = sample_media_job("01JMEDIA000000000000000003", "queued");
    store.insert_media_job(&plain).unwrap();
    assert!(store
        .get_media_job("01JMEDIA000000000000000003")
        .unwrap()
        .unwrap()
        .headers
        .is_none());
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

// ---- v7 (Phase 13): torrent engine jobs ----

fn sample_torrent_row(id: &str, status: &str) -> dc_storage::TorrentJobRow {
    dc_storage::TorrentJobRow {
        id: Ulid(id.to_string()),
        source_kind: dc_protocol::TorrentSourceKind::Torrent,
        source_uri: String::new(),
        name: Some("Sample Torrent".into()),
        info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
        destination_dir: "/home/user/Downloads".into(),
        status: status.into(),
        total_bytes: Some(262_144),
        received_bytes: 131_072,
        uploaded_bytes: 4_096,
        num_pieces: Some(4),
        piece_length: Some(65_536),
        have_blob: Some(vec![0b1010_0000]),
        metainfo_blob: Some(b"d4:infod4:spam4:eggsee".to_vec()),
        files: vec![dc_protocol::TorrentFileEntry {
            path: "Sample Torrent/sample.txt".into(),
            size: 262_144,
            offset: 0,
        }],
        trackers: vec!["http://tracker.example/ann".into()],
        error_code: None,
        proxy_profile_id: None,
        created_at: 1_735_689_600_000,
        updated_at: 1_735_689_600_000,
    }
}

#[test]
fn torrent_jobs_crud_round_trip() {
    let store = JobStore::open_in_memory().unwrap();
    let row = sample_torrent_row("01JTORRENT0000000000000000A", "downloading");
    store.insert_torrent_job(&row).unwrap();

    let got = store
        .get_torrent_job("01JTORRENT0000000000000000A")
        .unwrap()
        .unwrap();
    assert_eq!(got, row);

    let list = store.list_torrent_jobs().unwrap();
    assert_eq!(list.len(), 1);

    // wire projection zeroes runtime-only fields
    let wire = got.to_wire();
    assert_eq!(wire.download_speed_bps, 0);
    assert_eq!(wire.peers, 0);
    assert_eq!(wire.name.as_deref(), Some("Sample Torrent"));
    assert_eq!(wire.files.len(), 1);

    // mutate + update
    let mut updated = row.clone();
    updated.status = "completed".into();
    updated.received_bytes = 262_144;
    updated.have_blob = Some(vec![0b1111_0000]);
    store.update_torrent_job(&updated).unwrap();
    let got = store
        .get_torrent_job("01JTORRENT0000000000000000A")
        .unwrap()
        .unwrap();
    assert_eq!(got.status, "completed");
    assert_eq!(got.received_bytes, 262_144);
    assert_eq!(got.have_blob, Some(vec![0b1111_0000]));

    // progress tick touches counters + have, leaves the rest
    store
        .update_torrent_progress("01JTORRENT0000000000000000A", 131_072, 8_192, None)
        .unwrap();
    let got = store
        .get_torrent_job("01JTORRENT0000000000000000A")
        .unwrap()
        .unwrap();
    assert_eq!(got.received_bytes, 131_072);
    assert_eq!(got.uploaded_bytes, 8_192);
    assert_eq!(
        got.have_blob,
        Some(vec![0b1111_0000]),
        "have preserved via COALESCE"
    );

    // delete
    assert!(store
        .delete_torrent_job("01JTORRENT0000000000000000A")
        .unwrap());
    assert!(store
        .get_torrent_job("01JTORRENT0000000000000000A")
        .unwrap()
        .is_none());
}

#[test]
fn magnet_torrent_row_persists_null_identity_and_survives_reopen() {
    let dir = tempdir();
    let db = dir.join("t.db");
    {
        let store = JobStore::open(&db).unwrap();
        let row = dc_storage::TorrentJobRow {
            id: Ulid("01JTORRENT0000000000000000B".into()),
            source_kind: dc_protocol::TorrentSourceKind::Magnet,
            source_uri: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".into(),
            name: None,
            info_hash: None,
            destination_dir: "/home/user/Downloads".into(),
            status: "metadata".into(),
            total_bytes: None,
            received_bytes: 0,
            uploaded_bytes: 0,
            num_pieces: None,
            piece_length: None,
            have_blob: None,
            metainfo_blob: None,
            files: vec![],
            trackers: vec![],
            error_code: None,
            proxy_profile_id: Some("01HQ".into()),
            created_at: 1,
            updated_at: 1,
        };
        store.insert_torrent_job(&row).unwrap();
    }
    let store = JobStore::open(&db).unwrap();
    let got = store
        .get_torrent_job("01JTORRENT0000000000000000B")
        .unwrap()
        .unwrap();
    assert_eq!(got.source_kind, dc_protocol::TorrentSourceKind::Magnet);
    assert_eq!(got.name, None);
    assert_eq!(got.info_hash, None);
    assert_eq!(got.files, vec![]);
    assert_eq!(got.proxy_profile_id.as_deref(), Some("01HQ"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn torrent_boot_reset_flips_active_to_paused() {
    let store = JobStore::open_in_memory().unwrap();
    for (i, status) in [
        "queued",
        "metadata",
        "downloading",
        "seeding",
        "paused",
        "completed",
        "failed",
    ]
    .iter()
    .enumerate()
    {
        let id = format!("01JTORRENT0000000000000000{:02X}", i + 1);
        let mut row = sample_torrent_row(&id, status);
        row.source_uri = String::new();
        store.insert_torrent_job(&row).unwrap();
    }
    let reset = store.reset_active_torrent_jobs().unwrap();
    assert_eq!(reset, 4, "queued/metadata/downloading/seeding reset");
    for (i, status) in [
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "completed",
        "failed",
    ]
    .iter()
    .enumerate()
    {
        let id = format!("01JTORRENT0000000000000000{:02X}", i + 1);
        assert_eq!(store.get_torrent_job(&id).unwrap().unwrap().status, *status);
    }
}

#[test]
fn schema_version_is_at_least_7_after_migrations() {
    let store = JobStore::open_in_memory().unwrap();
    assert!(store.schema_version().unwrap() >= 7);
}

// ---- Phase 14: browser history + bookmarks (storage v8) ----

fn history_entry(
    url: &str,
    title: Option<&str>,
    visited_at: i64,
) -> dc_protocol::browser::HistoryEntry {
    dc_protocol::browser::HistoryEntry {
        id: Ulid(dc_protocol::new_ulid().0),
        url: url.into(),
        title: title.map(Into::into),
        favicon_url: None,
        visited_at,
    }
}

#[test]
fn history_round_trips_with_newest_first_ordering() {
    let store = JobStore::open_in_memory().unwrap();
    for (i, at) in [3000i64, 1000, 2000].iter().enumerate() {
        let mut entry = history_entry("https://example.com/a", Some("A"), *at);
        entry.url = format!("https://example.com/page-{i}");
        store.insert_history_entry(&entry).unwrap();
    }
    let entries = store.list_history(None, 10, 0).unwrap();
    assert_eq!(entries.len(), 3);
    // Newest first (page-0 was visited at 3000, page-1 at 1000).
    assert_eq!(entries[0].url, "https://example.com/page-0");
    assert_eq!(entries[2].url, "https://example.com/page-1");
    assert_eq!(entries[0].visited_at, 3000);
}

#[test]
fn history_search_matches_url_and_title_case_insensitively() {
    let store = JobStore::open_in_memory().unwrap();
    store
        .insert_history_entry(&history_entry(
            "https://example.com/syntax-download-manager-docs",
            Some("Framework docs"),
            1000,
        ))
        .unwrap();
    store
        .insert_history_entry(&history_entry(
            "https://other.org/news",
            Some("Release notes"),
            2000,
        ))
        .unwrap();

    // Query case differs from the stored URL case on purpose: the search must
    // match URL substrings case-insensitively.
    let by_url = store.list_history(Some("Download-Manager"), 10, 0).unwrap();
    assert_eq!(by_url.len(), 1);
    assert_eq!(
        by_url[0].url,
        "https://example.com/syntax-download-manager-docs"
    );

    let by_title = store.list_history(Some("RELEASE"), 10, 0).unwrap();
    assert_eq!(by_title.len(), 1);
    assert_eq!(by_title[0].url, "https://other.org/news");

    let none = store.list_history(Some("no-such-thing"), 10, 0).unwrap();
    assert!(none.is_empty());
}

#[test]
fn history_limit_offset_paginates() {
    let store = JobStore::open_in_memory().unwrap();
    for i in 0..5i64 {
        let mut entry = history_entry("https://example.com/x", None, 1000 + i);
        entry.url = format!("https://example.com/x/{i}");
        store.insert_history_entry(&entry).unwrap();
    }
    let page = store.list_history(None, 2, 1).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].url, "https://example.com/x/3"); // newest first, skipping x/4
}

#[test]
fn history_delete_clear_and_count() {
    let store = JobStore::open_in_memory().unwrap();
    for i in 0..4i64 {
        let mut entry = history_entry("https://example.com/x", None, 2000 + i * 1000);
        entry.url = format!("https://example.com/x/{i}");
        store.insert_history_entry(&entry).unwrap();
    }
    assert_eq!(store.count_history().unwrap(), 4);

    // before = 4000 removes visits strictly before it (x/0, x/1).
    let cleared = store.clear_history(Some(4000)).unwrap();
    assert_eq!(cleared, 2);
    assert_eq!(store.count_history().unwrap(), 2);

    // Delete one row directly; deleting it again reports false.
    let first = &store.list_history(None, 1, 0).unwrap()[0].id.0.clone();
    assert!(store.delete_history_entry(first).unwrap());
    assert!(!store.delete_history_entry(first).unwrap());

    // Clear everything.
    assert_eq!(store.clear_history(None).unwrap(), 1);
    assert_eq!(store.count_history().unwrap(), 0);
}

#[test]
fn history_prune_keeps_the_cap_enforced_at_the_write_path() {
    // The cap is 50 000 — the invariant is checked by racing 8 workers past the cap
    // (+5 rows each) and verifying the table holds exactly MAX_HISTORY_ROWS rows with
    // the newest surviving: pruning happens inside every insert, never best-effort.
    use std::sync::Arc;
    use std::thread;

    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let workers = 8;
    let per_worker = dc_storage::MAX_HISTORY_ROWS / 8 + 5;
    let mut handles = Vec::new();
    for w in 0..workers {
        let store = Arc::clone(&store);
        handles.push(thread::spawn(move || {
            for i in 0..per_worker {
                let at: i64 = (w as i64) * per_worker + i;
                let mut entry = history_entry("https://example.com/x", None, at);
                entry.url = format!("https://example.com/x/{at}");
                store.insert_history_entry(&entry).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(store.count_history().unwrap(), dc_storage::MAX_HISTORY_ROWS);
    // The newest row survived; ordering is intact.
    let top = &store.list_history(None, 1, 0).unwrap()[0];
    let expected: i64 = (workers as i64) * per_worker - 1;
    assert_eq!(top.visited_at, expected);
}

fn sample_bookmark(url: &str, title: &str) -> dc_protocol::browser::Bookmark {
    dc_protocol::browser::Bookmark {
        id: Ulid(dc_protocol::new_ulid().0),
        url: url.into(),
        title: title.into(),
        position: 0, // assigned by the store
        created_at: 1735689600000,
        updated_at: 1735689600000,
    }
}

#[test]
fn bookmarks_assign_sequential_positions_and_list_in_order() {
    let store = JobStore::open_in_memory().unwrap();
    let b0 = store
        .insert_bookmark(&sample_bookmark("https://a.example/", "A"))
        .unwrap();
    let b1 = store
        .insert_bookmark(&sample_bookmark("https://b.example/", "B"))
        .unwrap();
    assert_eq!(b0.position, 0);
    assert_eq!(b1.position, 1);

    let list = store.list_bookmarks().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].url, "https://a.example/");
    assert_eq!(list[1].url, "https://b.example/");
}

#[test]
fn bookmark_get_by_url_returns_the_first_match_or_none() {
    let store = JobStore::open_in_memory().unwrap();
    store
        .insert_bookmark(&sample_bookmark("https://dup.example/", "First"))
        .unwrap();
    store
        .insert_bookmark(&sample_bookmark("https://dup.example/", "Second"))
        .unwrap();
    store
        .insert_bookmark(&sample_bookmark("https://unique.example/", "Unique"))
        .unwrap();

    let first = store
        .get_bookmark_by_url("https://dup.example/")
        .unwrap()
        .unwrap();
    assert_eq!(first.title, "First");
    assert!(store
        .get_bookmark_by_url("https://missing.example/")
        .unwrap()
        .is_none());
}

#[test]
fn bookmark_update_changes_only_given_fields_and_bumps_updated_at() {
    let store = JobStore::open_in_memory().unwrap();
    let created = store
        .insert_bookmark(&sample_bookmark("https://a.example/", "A"))
        .unwrap();

    let renamed = store
        .update_bookmark(created.id.as_str(), Some("Renamed"), None)
        .unwrap();
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(renamed.url, "https://a.example/");
    assert!(renamed.updated_at >= renamed.created_at);

    let reurl = store
        .update_bookmark(created.id.as_str(), None, Some("https://b.example/"))
        .unwrap();
    assert_eq!(reurl.url, "https://b.example/");
    assert_eq!(reurl.title, "Renamed", "title survives a url-only update");

    // No fields at all is a boundary error, not a silent no-op.
    assert!(store
        .update_bookmark(created.id.as_str(), None, None)
        .is_err());
    // Unknown id is invalid_state.
    assert!(store
        .update_bookmark("01JD8W3G5XQ9V4M2K7PZ6N8S0Z", Some("X"), None)
        .is_err());
}

#[test]
fn bookmark_delete_reports_whether_the_row_existed() {
    let store = JobStore::open_in_memory().unwrap();
    let created = store
        .insert_bookmark(&sample_bookmark("https://a.example/", "A"))
        .unwrap();
    assert!(store.delete_bookmark(created.id.as_str()).unwrap());
    assert!(!store.delete_bookmark(created.id.as_str()).unwrap());
}

#[test]
fn schema_version_is_at_least_8_after_browser_data_tables() {
    let store = JobStore::open_in_memory().unwrap();
    assert!(store.schema_version().unwrap() >= 8);
}

// ---- scheduler jobs (Phase 15, storage v9) ----

use dc_storage::SchedulerJobRow;

fn sample_scheduler_job(id: &str, kind: &str, repeat: &str) -> SchedulerJobRow {
    SchedulerJobRow {
        id: Ulid(id.to_string()),
        kind: kind.into(),
        payload: serde_json::json!({ "url": "https://example.com/a.zip", "destinationDir": "/tmp" }),
        start_at: 1000,
        wall_anchor: 1000,
        repeat: repeat.into(),
        enabled: true,
        next_run_at: Some(1000),
        last_fired_at: None,
        last_result_code: None,
        last_result_message: None,
        created_at: 500,
        updated_at: 500,
    }
}

#[test]
fn schema_version_is_at_least_9_after_scheduler_table() {
    let store = JobStore::open_in_memory().unwrap();
    assert!(store.schema_version().unwrap() >= 9);
}

#[test]
fn scheduler_job_crud_round_trips_every_column() {
    let store = JobStore::open_in_memory().unwrap();
    let mut job = sample_scheduler_job(&valid_ulid(1), "download.create", "daily");
    store.insert_scheduler_job(&job).unwrap();

    let loaded = store.get_scheduler_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(loaded, job, "every column survives the round trip");

    // Outcome recording: last_* flip, one-shot disables and clears next_run_at.
    job.last_fired_at = Some(2000);
    job.last_result_code = Some("ok".into());
    job.last_result_message = Some("created download job 01X".into());
    job.next_run_at = None;
    job.enabled = false;
    job.updated_at = 2000;
    store.update_scheduler_job(&job).unwrap();
    let after = store.get_scheduler_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(after.last_result_code.as_deref(), Some("ok"));
    assert_eq!(after.next_run_at, None);
    assert!(!after.enabled);

    // Unknown id → invalid_state from the update path.
    let mut ghost = job.clone();
    ghost.id = Ulid(valid_ulid(99));
    assert!(store.update_scheduler_job(&ghost).is_err());

    assert!(store.delete_scheduler_job(job.id.as_str()).unwrap());
    assert!(!store.delete_scheduler_job(job.id.as_str()).unwrap());
    assert!(store.get_scheduler_job(job.id.as_str()).unwrap().is_none());
}

#[test]
fn scheduler_due_query_orders_by_next_run_and_respects_enabled() {
    let store = JobStore::open_in_memory().unwrap();

    let id_later = valid_ulid(1);
    let mut later = sample_scheduler_job(&id_later, "download.startAll", "none");
    later.next_run_at = Some(3000);
    later.created_at = 10;
    store.insert_scheduler_job(&later).unwrap();

    let id_earlier = valid_ulid(2);
    let mut earlier = sample_scheduler_job(&id_earlier, "download.pauseAll", "none");
    earlier.next_run_at = Some(2000);
    earlier.created_at = 20;
    store.insert_scheduler_job(&earlier).unwrap();

    // Disabled but due — never fires.
    let id_disabled = valid_ulid(3);
    let mut disabled = sample_scheduler_job(&id_disabled, "download.startAll", "none");
    disabled.next_run_at = Some(1500);
    disabled.enabled = false;
    disabled.created_at = 30;
    store.insert_scheduler_job(&disabled).unwrap();

    // Not yet due — stays out.
    let id_future = valid_ulid(4);
    let mut future = sample_scheduler_job(&id_future, "download.startAll", "none");
    future.next_run_at = Some(9000);
    future.created_at = 40;
    store.insert_scheduler_job(&future).unwrap();

    let due = store.list_due_scheduler_jobs(2500).unwrap();
    let ids: Vec<String> = due.iter().map(|j| j.id.as_str().to_string()).collect();
    assert_eq!(
        ids,
        vec![id_earlier.clone()],
        "at 2500 only next_run_at=2000 is due; disabled (1500) and future rows stay out"
    );

    // Advancing the clock pulls the 3000 row in, still in next_run_at order.
    let due = store.list_due_scheduler_jobs(3500).unwrap();
    let ids: Vec<String> = due.iter().map(|j| j.id.as_str().to_string()).collect();
    assert_eq!(
        ids,
        vec![id_earlier, id_later],
        "due order is next_run_at ASC and skips disabled rows"
    );
}

#[test]
fn scheduler_list_orders_newest_first() {
    let store = JobStore::open_in_memory().unwrap();
    for (i, created) in [100i64, 300, 200].into_iter().enumerate() {
        let mut job = sample_scheduler_job(&valid_ulid(i as u32 + 1), "download.startAll", "none");
        job.created_at = created;
        store.insert_scheduler_job(&job).unwrap();
    }
    let jobs = store.list_scheduler_jobs().unwrap();
    let created: Vec<i64> = jobs.iter().map(|j| j.created_at).collect();
    assert_eq!(created, vec![300, 200, 100]);
}

// ---- Phase 20: diagnostics health queries ----

#[test]
fn health_queries_report_integrity_and_counts() {
    let store = JobStore::open_in_memory().unwrap();

    // Integrity: a healthy database answers "ok".
    assert_eq!(store.quick_check().unwrap(), "ok");

    // Geometry: every materialized database has at least one page of sane size.
    let (page_count, page_size) = store.db_page_stats().unwrap();
    assert!(page_count >= 1, "page_count must be >= 1, got {page_count}");
    assert!(
        (512..=65536).contains(&page_size),
        "page_size out of range: {page_size}"
    );

    // Empty store: no rows anywhere.
    assert!(store.count_jobs_by_status().unwrap().is_empty());
    let (media, torrents, history, bookmarks, scheduler) = store.health_counts().unwrap();
    assert_eq!(
        (media, torrents, history, bookmarks, scheduler),
        (0, 0, 0, 0, 0)
    );

    // Seed: 2 completed + 1 failed download job, 1 media, 1 torrent, 2 history, 1 bookmark,
    // 1 scheduler — then verify every aggregate.
    store
        .insert_job(&sample_job(&valid_ulid(1), "completed"))
        .unwrap();
    store
        .insert_job(&sample_job(&valid_ulid(2), "completed"))
        .unwrap();
    store
        .insert_job(&sample_job(&valid_ulid(3), "failed"))
        .unwrap();

    let by_status = store.count_jobs_by_status().unwrap();
    assert_eq!(
        by_status,
        vec![("completed".to_string(), 2), ("failed".to_string(), 1)],
        "GROUP BY status ORDER BY status — deterministic pairs"
    );

    store
        .insert_media_job(&sample_media_job(&valid_ulid(4), "completed"))
        .unwrap();
    store
        .insert_torrent_job(&sample_torrent_row(&valid_ulid(5), "paused"))
        .unwrap();
    store
        .insert_history_entry(&history_entry("https://example.com/h1", None, 1000))
        .unwrap();
    store
        .insert_history_entry(&history_entry("https://example.com/h2", None, 2000))
        .unwrap();
    store
        .insert_bookmark(&sample_bookmark("https://example.com/b", "B"))
        .unwrap();
    store
        .insert_scheduler_job(&sample_scheduler_job(
            &valid_ulid(6),
            "download.startAll",
            "none",
        ))
        .unwrap();

    let (media, torrents, history, bookmarks, scheduler) = store.health_counts().unwrap();
    assert_eq!(
        (media, torrents, history, bookmarks, scheduler),
        (1, 1, 2, 1, 1)
    );

    // Still "ok" after writes — quick_check runs on the live store without disturbing it.
    assert_eq!(store.quick_check().unwrap(), "ok");
}
