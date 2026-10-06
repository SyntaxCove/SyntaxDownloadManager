//! Cross-language fixture tests: dc-protocol must deserialize exactly what the TypeScript
//! side serializes, and vice versa. Fixtures live in packages/contracts/fixtures.

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
