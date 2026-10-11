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
