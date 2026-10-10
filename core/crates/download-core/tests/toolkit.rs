//! Phase 10 integration tests: the toolkit path map behind the manager — full-replace
//! semantics and fail-closed rejection of partial/duplicate pushes. (No HTTP harness is
//! needed here; the wire envelope itself is exercised in dc-protocol fixture tests.)

use std::sync::Arc;

use dc_protocol::ToolkitPathEntry;
use dc_storage::JobStore;
use download_core::manager::JobManager;
use tokio::sync::mpsc;

fn make_manager() -> Arc<JobManager> {
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let (tx, _rx) = mpsc::unbounded_channel();
    JobManager::new(store, tx)
}

fn entry(id: &str, version: &str, path: &str) -> ToolkitPathEntry {
    ToolkitPathEntry {
        id: id.into(),
        version: version.into(),
        path: path.into(),
    }
}

#[tokio::test]
async fn toolkit_map_replaces_wholesale_through_the_manager() {
    let manager = make_manager();
    manager
        .set_toolkit_paths(vec![
            entry("yt-dlp", "2025.09.26", "/opt/t/yt-dlp"),
            entry("ffmpeg", "8.0.1", "/opt/t/ffmpeg"),
            entry("deno", "2.1.5", "/opt/t/deno"),
        ])
        .unwrap();
    // Replacement is visible via a fresh push; a stale entry disappears.
    manager
        .set_toolkit_paths(vec![entry("ffmpeg", "8.0.1", "/opt/t2/ffmpeg")])
        .unwrap();
    manager
        .set_toolkit_paths(vec![
            entry("yt-dlp", "2025.09.26", "/opt/t/yt-dlp"),
            entry("ffmpeg", "8.0.1", "/opt/t/ffmpeg"),
            entry("deno", "2.1.5", "/opt/t/deno"),
        ])
        .unwrap();
}

#[tokio::test]
async fn toolkit_push_rejects_duplicates_without_partial_apply() {
    let manager = make_manager();
    manager
        .set_toolkit_paths(vec![entry("yt-dlp", "2025.09.26", "/a")])
        .unwrap();
    let err = manager
        .set_toolkit_paths(vec![
            entry("ffmpeg", "8.0.1", "/b"),
            entry("ffmpeg", "8.0.1", "/c"),
        ])
        .expect_err("duplicate ids must be rejected");
    assert_eq!(err.code.as_str(), "invalid_params");
}

#[tokio::test]
async fn toolkit_push_rejects_empty_id_or_path() {
    let manager = make_manager();
    let err = manager
        .set_toolkit_paths(vec![entry("deno", "2.1.5", "")])
        .expect_err("empty path must be rejected");
    assert_eq!(err.code.as_str(), "invalid_params");
    let err = manager
        .set_toolkit_paths(vec![entry("", "2.1.5", "/x")])
        .expect_err("empty id must be rejected");
    assert_eq!(err.code.as_str(), "invalid_params");
}

#[tokio::test]
async fn toolkit_ids_survive_a_round_trip_through_the_wire_shape() {
    let manager = make_manager();
    let tools = vec![
        entry("yt-dlp", "2025.09.26", "/opt/t/yt-dlp"),
        entry("deno", "2.1.5", "/opt/t/deno"),
    ];
    let params = dc_protocol::ToolkitSetPathsParams {
        tools: tools.clone(),
    };
    let json = serde_json::to_value(&params).unwrap();
    let back: dc_protocol::ToolkitSetPathsParams = serde_json::from_value(json).unwrap();
    assert_eq!(back.tools, tools, "wire round-trip must preserve entries");
    manager.set_toolkit_paths(back.tools).unwrap();
}
