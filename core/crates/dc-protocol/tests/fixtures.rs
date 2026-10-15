//! Cross-language fixture tests: dc-protocol must deserialize exactly what the TypeScript
//! side serializes, and vice versa. Fixtures live in packages/contracts/fixtures.

use dc_protocol::job::ChecksumAlgorithm;
use dc_protocol::{DownloadJob, ErrorEnvelope, EventEnvelope, RequestEnvelope, SuccessEnvelope};

fn fixtures_dir() -> String {
    format!(
        "{}/../../../packages/contracts/fixtures",
        env!("CARGO_MANIFEST_DIR")
    )
}

#[test]
fn parses_domain_fixture_job() {
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: DownloadJob = serde_json::from_value(doc["downloadJob"].clone()).unwrap();
    assert_eq!(job.status, "downloading");
    assert_eq!(job.total_bytes, Some(104857600));
    assert_eq!(job.received_bytes, 52428800);
    assert_eq!(job.id.as_str(), "01JD8W3G5XQ9V4M2K7PZ6N8S0T");
}

#[test]
fn parses_envelope_fixtures() {
    let raw = std::fs::read_to_string(format!("{}/envelopes.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();

    let req: RequestEnvelope = serde_json::from_value(doc["request"].clone()).unwrap();
    assert_eq!(req.method, "download.pause");

    let ok: SuccessEnvelope = serde_json::from_value(doc["success"].clone()).unwrap();
    assert!(ok.ok);

    let err: ErrorEnvelope = serde_json::from_value(doc["error"].clone()).unwrap();
    assert_eq!(err.error.code.as_str(), "invalid_state");
    assert_eq!(err.error.message, "job is not running");

    let ev: EventEnvelope = serde_json::from_value(doc["event"].clone()).unwrap();
    assert_eq!(ev.event, "download.progress");
}

#[test]
fn rust_serialization_matches_ts_wire_format() {
    // A job built here must serialize into the exact same JSON shape as the TS fixture.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: DownloadJob = serde_json::from_value(doc["downloadJob"].clone()).unwrap();
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["downloadJob"],
        "wire format divergence between TS and Rust"
    );
}

#[test]
fn parses_and_round_trips_segmented_job_fixture() {
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: DownloadJob = serde_json::from_value(doc["downloadJobSegmented"].clone()).unwrap();
    assert_eq!(job.segment_count, Some(4));
    assert_eq!(job.checksum_algorithm, Some(ChecksumAlgorithm::Sha256));
    assert_eq!(job.checksum_verified, None);
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["downloadJobSegmented"],
        "wire format divergence between TS and Rust (segmented job)"
    );
}

#[test]
fn legacy_job_with_new_fields_serializes_nulls_not_omissions() {
    // The TS contract requires segmentCount / checksumActual / checksumVerified /
    // recoveryCount / reboundAt / queuePosition / proxyProfileId to be PRESENT (nullable)
    // on the wire; nullish fields (checksum provenance, per-job speed limit) stay absent.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: DownloadJob = serde_json::from_value(doc["downloadJob"].clone()).unwrap();
    let out = serde_json::to_value(&job).unwrap();
    assert!(out.get("segmentCount").is_some());
    assert!(out.get("checksumActual").is_some());
    assert!(out.get("checksumVerified").is_some());
    assert!(out.get("recoveryCount").is_some());
    assert!(out.get("reboundAt").is_some());
    assert!(out.get("queuePosition").is_some());
    assert!(out.get("proxyProfileId").is_some());
    assert!(out.get("checksumAlgorithm").is_none());
    assert!(out.get("checksumExpected").is_none());
    assert!(out.get("speedLimitKBps").is_none());
}

#[test]
fn parses_and_round_trips_queued_job_fixture() {
    // v1.3 (Phase 8): queuePosition is always serialized; speedLimitKBps is nullish.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: DownloadJob = serde_json::from_value(doc["downloadJobQueued"].clone()).unwrap();
    assert_eq!(job.status, "queued");
    assert_eq!(job.queue_position, Some(2));
    assert_eq!(job.speed_limit_kbps, Some(512));
    assert_eq!(job.checksum_verified, None);
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["downloadJobQueued"],
        "wire format divergence between TS and Rust (queued job)"
    );
}

#[test]
fn parses_and_round_trips_proxied_job_fixture() {
    // v1.4 (Phase 9): proxyProfileId is always serialized; a paused job may carry the
    // fail-closed proxy_profile_not_found code.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: DownloadJob = serde_json::from_value(doc["downloadJobProxied"].clone()).unwrap();
    assert_eq!(job.status, "paused");
    assert_eq!(
        job.proxy_profile_id.as_deref(),
        Some("01K33R2VQ7M4X8N6P5T9W1Z3C4")
    );
    assert_eq!(job.error_code.as_deref(), Some("proxy_profile_not_found"));
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["downloadJobProxied"],
        "wire format divergence between TS and Rust (proxied job)"
    );
}

#[test]
fn parses_and_round_trips_toolkit_paths_fixture() {
    // v1.5 (Phase 10): `toolkit.setPaths` params — the only core-facing toolkit wire shape.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let params: dc_protocol::ToolkitSetPathsParams =
        serde_json::from_value(doc["toolkitPaths"].clone()).unwrap();
    assert_eq!(params.tools.len(), 3);
    assert_eq!(params.tools[0].id, "yt-dlp");
    assert_eq!(params.tools[2].id, "deno");
    let out: serde_json::Value = serde_json::to_value(&params).unwrap();
    assert_eq!(
        out, doc["toolkitPaths"],
        "wire format divergence between TS and Rust (toolkit paths)"
    );
}

#[test]
fn parses_and_round_trips_media_manifest_fixture() {
    // v1.6 (Phase 11): the media.inspect result payload — projection of yt-dlp JSON.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let manifest: dc_protocol::MediaManifest =
        serde_json::from_value(doc["mediaManifest"].clone()).unwrap();
    assert_eq!(manifest.title, "Sample Video");
    assert!(!manifest.is_live);
    assert_eq!(manifest.videos.len(), 1);
    assert_eq!(manifest.videos[0].acodec, None);
    assert_eq!(manifest.audios[0].abitrate_bps, Some(128_000));
    assert_eq!(manifest.subtitles[0].format_id, "vtt-en");
    let out: serde_json::Value = serde_json::to_value(&manifest).unwrap();
    assert_eq!(
        out, doc["mediaManifest"],
        "wire format divergence between TS and Rust (media manifest)"
    );
}

#[test]
fn parses_and_round_trips_media_job_fixture() {
    // v1.7 (Phase 12): the persistent media pipeline job — mirrors the TS MediaJob.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: dc_protocol::MediaJob = serde_json::from_value(doc["mediaJob"].clone()).unwrap();
    assert_eq!(job.status, "downloading");
    assert_eq!(job.container, dc_protocol::MediaContainer::Mkv);
    assert_eq!(job.video_format_id.as_deref(), Some("137"));
    assert_eq!(job.audio_format_id.as_deref(), Some("140"));
    assert_eq!(job.subtitles.len(), 1);
    assert_eq!(job.subtitles[0].language, "en");
    assert!(!job.subtitles[0].is_auto_generated);
    assert_eq!(job.destination_path, None);
    assert_eq!(job.total_bytes, Some(121_400_000));
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["mediaJob"],
        "wire format divergence between TS and Rust (media job)"
    );
}

#[test]
fn parses_media_progress_fixture() {
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let p: dc_protocol::MediaProgress =
        serde_json::from_value(doc["mediaProgress"].clone()).unwrap();
    assert_eq!(p.phase, "downloading");
    assert_eq!(p.received_bytes, 60_700_000);
    let out: serde_json::Value = serde_json::to_value(&p).unwrap();
    assert_eq!(out, doc["mediaProgress"]);
}

// ---- v1.8 (Phase 13): torrent domain fixtures ----

#[test]
fn parses_domain_fixture_torrent_job() {
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: dc_protocol::TorrentJob = serde_json::from_value(doc["torrentJob"].clone()).unwrap();
    assert_eq!(job.status, "downloading");
    assert_eq!(job.source_kind, dc_protocol::TorrentSourceKind::Torrent);
    assert_eq!(
        job.info_hash.as_deref(),
        Some("0123456789abcdef0123456789abcdef01234567")
    );
    assert_eq!(job.num_pieces, Some(4));
    assert_eq!(job.files.len(), 1);
    assert_eq!(job.files[0].path, "Sample Torrent/sample.txt");
}

#[test]
fn rust_torrent_serialization_matches_ts_wire_format() {
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: dc_protocol::TorrentJob = serde_json::from_value(doc["torrentJob"].clone()).unwrap();
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["torrentJob"],
        "wire format divergence between TS and Rust"
    );

    let progress: dc_protocol::TorrentProgress =
        serde_json::from_value(doc["torrentProgress"].clone()).unwrap();
    let out: serde_json::Value = serde_json::to_value(&progress).unwrap();
    assert_eq!(out, doc["torrentProgress"]);
}

#[test]
fn magnet_torrent_job_null_identity_round_trip() {
    // A magnet pre-metadata serializes with explicit nulls the TS schema accepts.
    let json = serde_json::json!({
        "id": "01JD8W3G5XQ9V4M2K7PZ6N8S0W",
        "name": null,
        "status": "metadata",
        "sourceKind": "magnet",
        "infoHash": null,
        "destinationDir": "/home/user/Downloads",
        "totalBytes": null,
        "receivedBytes": 0,
        "uploadedBytes": 0,
        "downloadSpeedBps": 0,
        "uploadSpeedBps": 0,
        "peers": 0,
        "seeds": 0,
        "etaSeconds": null,
        "numPieces": null,
        "pieceLength": null,
        "files": [],
        "errorCode": null,
        "proxyProfileId": null,
        "createdAt": 1735689600000i64,
        "updatedAt": 1735689900000i64
    });
    let job: dc_protocol::TorrentJob = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(job.source_kind, dc_protocol::TorrentSourceKind::Magnet);
    assert_eq!(job.name, None);
    let out = serde_json::to_value(&job).unwrap();
    assert_eq!(out, json);
}

#[test]
fn parses_and_round_trips_history_entry_fixture() {
    // v1.9 (Phase 14): browser history rows — nullable title/favicon are always serialized.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let entry: dc_protocol::HistoryEntry =
        serde_json::from_value(doc["historyEntry"].clone()).unwrap();
    assert_eq!(entry.url, "https://example.com/articles/syntaxdm");
    assert_eq!(entry.title.as_deref(), Some("Syntax Download Manager release notes"));
    assert_eq!(entry.visited_at, 1735689600000);
    let out: serde_json::Value = serde_json::to_value(&entry).unwrap();
    assert_eq!(
        out, doc["historyEntry"],
        "wire format divergence between TS and Rust (history entry)"
    );
}

#[test]
fn history_entry_null_title_serializes_explicit_nulls() {
    let json = serde_json::json!({
        "id": "01JD8W3G5XQ9V4M2K7PZ6N8S0H",
        "url": "https://example.com/no-title",
        "title": null,
        "faviconUrl": null,
        "visitedAt": 1735689600000i64
    });
    let entry: dc_protocol::HistoryEntry = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(entry.title, None);
    assert_eq!(entry.favicon_url, None);
    let out = serde_json::to_value(&entry).unwrap();
    assert_eq!(out, json, "nulls must stay present on the wire");
}

#[test]
fn parses_and_round_trips_bookmark_fixture() {
    // v1.9 (Phase 14): bookmarks — flat, position-ordered.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let bookmark: dc_protocol::Bookmark = serde_json::from_value(doc["bookmark"].clone()).unwrap();
    assert_eq!(bookmark.title, "Syntax Download Manager release notes");
    assert_eq!(bookmark.position, 0);
    let out: serde_json::Value = serde_json::to_value(&bookmark).unwrap();
    assert_eq!(
        out, doc["bookmark"],
        "wire format divergence between TS and Rust (bookmark)"
    );
}

#[test]
fn browser_data_params_deserialize_camel_case() {
    let record = serde_json::json!({
        "url": "https://example.com/x",
        "title": "X",
        "faviconUrl": "https://example.com/f.ico",
        "visitedAt": 1735689600000i64
    });
    let p: dc_protocol::HistoryRecordParams = serde_json::from_value(record).unwrap();
    assert_eq!(p.favicon_url.as_deref(), Some("https://example.com/f.ico"));
    assert_eq!(p.visited_at, Some(1735689600000));

    let list = serde_json::json!({ "query": "uni", "limit": 50, "offset": 10 });
    let p: dc_protocol::HistoryListParams = serde_json::from_value(list).unwrap();
    assert_eq!(p.query.as_deref(), Some("uni"));
    assert_eq!(p.limit, Some(50));
    assert_eq!(p.offset, Some(10));

    let empty: dc_protocol::HistoryListParams =
        serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(empty.query, None);
    assert_eq!(empty.limit, None);

    let upd = serde_json::json!({ "id": "01JD8W3G5XQ9V4M2K7PZ6N8S0B", "title": "Renamed" });
    let p: dc_protocol::BookmarkUpdateParams = serde_json::from_value(upd).unwrap();
    assert_eq!(p.title.as_deref(), Some("Renamed"));
    assert_eq!(p.url, None);
}

#[test]
fn parses_and_round_trips_scheduler_job_fixture() {
    // v1.10 (Phase 15): scheduler jobs — persistent automation rows.
    let raw = std::fs::read_to_string(format!("{}/domain.json", fixtures_dir())).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job: dc_protocol::SchedulerJob =
        serde_json::from_value(doc["schedulerJob"].clone()).unwrap();
    assert_eq!(job.kind, "download.create");
    assert_eq!(job.repeat, "daily");
    assert!(job.enabled);
    assert_eq!(job.next_run_at, Some(1735776000000));
    assert_eq!(job.last_fired_at, Some(1735689600000));
    assert_eq!(job.last_result_code.as_deref(), Some("ok"));
    let out: serde_json::Value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        out, doc["schedulerJob"],
        "wire format divergence between TS and Rust (scheduler job)"
    );
}

#[test]
fn scheduler_job_null_outcome_fields_serialize_explicit_nulls() {
    // nextRunAt/lastFiredAt/lastResultCode/lastResultMessage are zod-nullable → always
    // serialized, even when the job never fired.
    let json = serde_json::json!({
        "id": "01K4SCHE0000000000000000AA",
        "kind": "download.startAll",
        "payload": {},
        "startAt": 1000i64,
        "repeat": "none",
        "enabled": false,
        "nextRunAt": null,
        "lastFiredAt": null,
        "lastResultCode": null,
        "lastResultMessage": null,
        "createdAt": 1i64,
        "updatedAt": 2i64
    });
    let job: dc_protocol::SchedulerJob = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(job.next_run_at, None);
    assert_eq!(job.last_result_code, None);
    let out = serde_json::to_value(&job).unwrap();
    assert_eq!(out, json, "nulls must stay present on the wire");
    for key in [
        "nextRunAt",
        "lastFiredAt",
        "lastResultCode",
        "lastResultMessage",
    ] {
        assert!(out.get(key).is_some(), "{key} must always serialize");
    }
}

#[test]
fn scheduler_params_deserialize_camel_case() {
    let create = serde_json::json!({
        "kind": "media.download",
        "payload": { "url": "https://example.com/watch?v=1", "audioFormatId": "140",
                     "destinationDir": "/home/user/Downloads" },
        "startAt": 1735689600000i64,
        "repeat": "weekly",
        "enabled": false
    });
    let p: dc_protocol::SchedulerCreateParams = serde_json::from_value(create).unwrap();
    assert_eq!(p.kind, "media.download");
    assert_eq!(p.start_at, 1735689600000);
    assert_eq!(p.repeat, "weekly");
    assert!(!p.enabled);
    // default-enabled when omitted (zod `.optional().default(true)`)
    let bare: dc_protocol::SchedulerCreateParams = serde_json::from_value(serde_json::json!({
        "kind": "download.startAll", "payload": {}, "startAt": 1i64, "repeat": "none"
    }))
    .unwrap();
    assert!(bare.enabled);

    let upd = serde_json::json!({
        "id": "01K4SCHE0000000000000000AA",
        "patch": { "startAt": 5i64, "repeat": "daily", "enabled": true, "payload": {"url": "x"} }
    });
    let p: dc_protocol::SchedulerUpdateParams = serde_json::from_value(upd).unwrap();
    assert_eq!(p.patch.start_at, Some(5));
    assert_eq!(p.patch.repeat.as_deref(), Some("daily"));
    assert_eq!(p.patch.enabled, Some(true));
    assert!(p.patch.payload.is_some());

    let empty: dc_protocol::SchedulerPatch = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(empty, dc_protocol::SchedulerPatch::default());

    let clock: dc_protocol::SchedulerSetClockParams =
        serde_json::from_value(serde_json::json!({ "tzOffsetMinutes": 210 })).unwrap();
    assert_eq!(clock.tz_offset_minutes, 210);
}
