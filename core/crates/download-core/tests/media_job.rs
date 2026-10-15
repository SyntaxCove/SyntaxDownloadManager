//! Phase 12 integration tests: the media pipeline behind REAL child processes — fake
//! `yt-dlp`/`ffmpeg` executables pushed through `toolkit.setPaths` (cfg(unix), like the
//! Phase 11 spawn tests). Each test authors its own scripts in its own temp dir, so the
//! tests never share state and never need environment variables.

#![cfg(unix)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use dc_protocol::media::{MediaContainer, MediaDownloadParams, MediaSubtitleSelection};
use dc_protocol::{ErrorCode, ToolkitPathEntry};
use dc_storage::JobStore;
use download_core::media_job::{MediaJobManager, MAX_SUBTITLE_TRACKS};
use download_core::proxy::ProxyMap;
use download_core::toolkit::ToolkitMap;
use tokio::sync::{mpsc, Semaphore};

const MANIFEST: &str = r#"{"_type":"video","title":"Fake Video","extractor_key":"Fake",
    "webpage_url":"https://example.com/watch/abc","duration":10,
    "formats":[
        {"format_id":"137","ext":"mp4","vcodec":"avc1","acodec":"none","height":1080,"filesize":100},
        {"format_id":"140","ext":"m4a","vcodec":"none","acodec":"mp4a","filesize":50}],
    "subtitles":{"en":[{"ext":"vtt","name":"English"}]}}"#;

fn make_manager(tools: Vec<ToolkitPathEntry>) -> (Arc<MediaJobManager>, Arc<JobStore>) {
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let (tx, _rx) = mpsc::unbounded_channel();
    let toolkit = Arc::new(ToolkitMap::new());
    toolkit.replace(tools).unwrap();
    let proxies = Arc::new(ProxyMap::new());
    let limiter = Arc::new(Semaphore::new(3));
    (
        MediaJobManager::new(store.clone(), tx, toolkit, proxies, limiter),
        store,
    )
}

fn tool(id: &str, path: &str) -> ToolkitPathEntry {
    ToolkitPathEntry {
        id: id.into(),
        version: "test".into(),
        path: path.into(),
    }
}

fn params(destination_dir: &str, subs: Vec<MediaSubtitleSelection>) -> MediaDownloadParams {
    MediaDownloadParams {
        url: "https://example.com/watch/abc".into(),
        video_format_id: Some("137".into()),
        audio_format_id: Some("140".into()),
        subtitles: subs,
        container: MediaContainer::Mkv,
        destination_dir: destination_dir.into(),
        filename: None,
        proxy_profile_id: None,
    }
}

fn subs_en() -> Vec<MediaSubtitleSelection> {
    vec![MediaSubtitleSelection {
        language: "en".into(),
        extension: "vtt".into(),
        is_auto_generated: false,
    }]
}

/// Write an executable script (mode 755) and return its path.
fn write_exec(dir: &std::path::Path, name: &str, body: &str) -> String {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().to_string()
}

/// A fake yt-dlp: `--dump-single-json` prints the manifest; a stream run prints SYNTAXDM
/// progress lines and lands `<label>.mp4`; the subtitle run writes `<base>.<lang>.vtt`.
fn fake_ytdlp(dir: &std::path::Path, manifest: &str, mode: &str) -> String {
    let sleep = if mode == "slow" { "sleep 30\n" } else { "" };
    let exit_line = if mode == "fail" {
        "echo 'boom: unable to download video data: HTTP Error 403' >&2\nexit 1\n"
    } else {
        "exit 0\n"
    };
    let body = format!(
        r#"#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --dump-single-json) printf '%s' '{manifest}'; exit 0;;
    --skip-download) skip=1;;
  esac
done
prev=""
fmt=""; out=""; langs=""
for arg in "$@"; do
  case "$prev" in
    "-f") fmt="$arg";;
    "-o") out="$arg";;
    "--sub-langs") langs="$arg";;
  esac
  prev="$arg"
done
if [ "${{skip:-0}}" = "1" ]; then
  old="$IFS"; IFS=","
  for lang in $langs; do
    printf 'WEBVTT fake' > "$out.$lang.vtt"
  done
  IFS="$old"
  exit 0
fi
{sleep}
echo "SYNTAXDM 40 100 100 10 1" >&2
echo "SYNTAXDM 100 100 100 10 0" >&2
case "$fmt" in
  140) ext="m4a";;
  *) ext="mp4";;
esac
printf 'DATA-%s' "$fmt" > "${{out%%"%(ext)s"}}$ext"
{exit_line}"#
    );
    write_exec(dir, "yt-dlp", &body)
}

/// A fake ffmpeg: prints progress lines and writes the output (its last argument).
fn fake_ffmpeg(dir: &std::path::Path, mode: &str) -> String {
    let body = if mode == "fail" {
        r#"#!/bin/sh
echo "fake ffmpeg: Invalid data found when processing input" >&2
exit 1
"#
    } else {
        r#"#!/bin/sh
for arg in "$@"; do out="$arg"; done
echo "out_time_ms=1000000"
echo "out_time_ms=5000000"
printf 'MUXED-%s' "$(basename "$out")" > "$out"
exit 0
"#
    };
    write_exec(dir, "ffmpeg", body)
}

async fn wait_status(
    store: &Arc<JobStore>,
    id: &str,
    want: &[&str],
    timeout: Duration,
) -> dc_protocol::MediaJob {
    let start = Instant::now();
    loop {
        let job = store
            .get_media_job(id)
            .unwrap()
            .unwrap_or_else(|| panic!("media job {id} vanished"));
        if want.contains(&job.status.as_str()) {
            return job;
        }
        assert!(
            start.elapsed() < timeout,
            "timed out waiting for {want:?}; last status: {} (error: {:?})",
            job.status,
            job.error_code
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn tempdir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "syntaxdm-media-test-{tag}-{}-{}",
        std::process::id(),
        dc_protocol::new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn happy_path_video_audio_subtitle_mux() {
    let root = tempdir("happy");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "ok");
    let ffmpeg = fake_ffmpeg(&tools_dir, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    let job = manager
        .create(params(dest.to_str().unwrap(), subs_en()))
        .await
        .unwrap();
    assert_eq!(job.status, "queued");
    assert!(
        job.title.is_none(),
        "title refines after the first extraction"
    );

    let done = wait_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(done.title.as_deref(), Some("Fake Video"));
    // total from the fresh manifest hints: 100 (video) + 50 (audio)
    assert_eq!(done.total_bytes, Some(150));
    assert!(done.destination_path.is_some());
    let final_path = done.destination_path.clone().unwrap();
    assert!(
        final_path.ends_with(".mkv"),
        "mux target extension: {final_path}"
    );
    let bytes = std::fs::read(&final_path).unwrap();
    assert!(!bytes.is_empty());
    // the work dir is cleaned once the bytes live in the final file
    assert!(done.work_dir.is_some());
    assert!(
        !std::path::Path::new(done.work_dir.clone().unwrap().as_str()).exists(),
        "work dir must be removed after completion"
    );
    // both stream files fed the mux; the subtitle track was fetched
    let listing = std::fs::read_to_string(&final_path).unwrap();
    assert!(listing.contains("MUXED"), "fake ffmpeg wrote the output");
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn audio_only_job_moves_the_stream_untouched() {
    let root = tempdir("audio-only");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "ok");
    // NO ffmpeg in the toolkit: an audio-only job must not need it.
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp)]);

    let mut p = params(dest.to_str().unwrap(), vec![]);
    p.video_format_id = None;
    let job = manager.create(p).await.unwrap();
    let done = wait_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(15),
    )
    .await;
    let final_path = done.destination_path.unwrap();
    assert!(
        final_path.ends_with(".m4a"),
        "audio keeps its own ext: {final_path}"
    );
    let bytes = std::fs::read(&final_path).unwrap();
    assert_eq!(bytes, b"DATA-140");
    assert!(!std::path::Path::new(done.work_dir.clone().unwrap().as_str()).exists());
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn ffmpeg_failure_is_classified_and_keeps_the_work_dir() {
    let root = tempdir("muxfail");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "ok");
    let ffmpeg = fake_ffmpeg(&tools_dir, "fail");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let failed = wait_status(
        &store,
        job.id.as_str(),
        &["failed"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(failed.error_code.as_deref(), Some("media_mux_failed"));
    // The streams stay on disk for a later resume; the final file never appears.
    assert!(failed.destination_path.is_some());
    assert!(
        std::path::Path::new(failed.work_dir.clone().unwrap().as_str()).exists(),
        "the work dir survives for resume"
    );
    assert!(!std::path::Path::new(failed.destination_path.clone().unwrap().as_str()).exists());
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn extractor_download_failure_is_classified() {
    let root = tempdir("dlfail");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "fail");
    let ffmpeg = fake_ffmpeg(&tools_dir, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let failed = wait_status(
        &store,
        job.id.as_str(),
        &["failed"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(failed.error_code.as_deref(), Some("media_download_failed"));
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn vanished_format_is_classified_not_substituted() {
    let root = tempdir("gone-format");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    // The fresh manifest no longer offers 137 — the refusal must name it.
    let rotated = MANIFEST.replace(
        r#"{"format_id":"137","ext":"mp4","vcodec":"avc1","acodec":"none","height":1080,"filesize":100},"#,
        "",
    );
    let ytdlp = fake_ytdlp(&tools_dir, &rotated, "ok");
    let ffmpeg = fake_ffmpeg(&tools_dir, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let failed = wait_status(
        &store,
        job.id.as_str(),
        &["failed"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(failed.error_code.as_deref(), Some("media_format_not_found"));
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn missing_tool_pauses_fail_closed() {
    let root = tempdir("no-tool");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    // Empty toolkit: the run cannot even start.
    let (manager, store) = make_manager(vec![]);
    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let paused = wait_status(
        &store,
        job.id.as_str(),
        &["paused"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(paused.error_code.as_deref(), Some("media_tool_missing"));
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn live_stream_is_refused_honestly() {
    let root = tempdir("live");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let live_manifest = MANIFEST.replace("\"duration\":10", "\"duration\":0,\"is_live\":true");
    let ytdlp = fake_ytdlp(&tools_dir, &live_manifest, "ok");
    let ffmpeg = fake_ffmpeg(&tools_dir, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let failed = wait_status(
        &store,
        job.id.as_str(),
        &["failed"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(failed.error_code.as_deref(), Some("media_live_unsupported"));
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn missing_proxy_profile_pauses_fail_closed() {
    let root = tempdir("proxy");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp)]);
    let mut p = params(dest.to_str().unwrap(), vec![]);
    p.proxy_profile_id = Some("01HGHOSTPROFILE0000000000000".into());
    let job = manager.create(p).await.unwrap();
    let paused = wait_status(
        &store,
        job.id.as_str(),
        &["paused"],
        Duration::from_secs(15),
    )
    .await;
    assert_eq!(
        paused.error_code.as_deref(),
        Some("proxy_profile_not_found")
    );
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn paused_job_resumes_and_completes() {
    let root = tempdir("pause-resume");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "slow");
    let ffmpeg = fake_ffmpeg(&tools_dir, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    // Wait until the run is inside a stream download, then pause it.
    wait_status(
        &store,
        job.id.as_str(),
        &["downloading"],
        Duration::from_secs(10),
    )
    .await;
    let paused = manager.pause(job.id.as_str()).await.unwrap();
    assert_eq!(paused.status, "paused");

    // Swap the slow script for a fast one — same path, new content (the toolkit map
    // still points at it), proving the resume path end-to-end.
    let _fast = fake_ytdlp(&tools_dir, MANIFEST, "ok");
    let resumed = manager.resume(job.id.as_str()).await.unwrap();
    assert_eq!(resumed.status, "queued");
    let done = wait_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(done.error_code, None);
    assert!(done.destination_path.is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn remove_with_files_deletes_work_dir_and_output() {
    let root = tempdir("remove");
    let tools_dir = root.join("bin");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let ytdlp = fake_ytdlp(&tools_dir, MANIFEST, "ok");
    let ffmpeg = fake_ffmpeg(&tools_dir, "ok");
    let (manager, store) = make_manager(vec![tool("yt-dlp", &ytdlp), tool("ffmpeg", &ffmpeg)]);

    // Completed job: remove(delete_files=true) must delete the final file.
    let job = manager
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let done = wait_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(15),
    )
    .await;
    let final_path = done.destination_path.clone().unwrap();
    assert!(std::path::Path::new(&final_path).exists());
    manager.remove(job.id.as_str(), true).await.unwrap();
    assert!(store.get_media_job(job.id.as_str()).unwrap().is_none());
    assert!(!std::path::Path::new(&final_path).exists());

    // Failed-mux job: remove(delete_files=true) must delete the work dir.
    let ffmpeg_bad = fake_ffmpeg(&tools_dir, "fail");
    let _ = ffmpeg_bad;
    let ffmpeg_fail_path = tools_dir.join("ffmpeg_fail");
    std::fs::write(&ffmpeg_fail_path, "#!/bin/sh\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&ffmpeg_fail_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (manager2, store2) = make_manager(vec![
        tool("yt-dlp", &ytdlp),
        tool("ffmpeg", ffmpeg_fail_path.to_str().unwrap()),
    ]);
    let job2 = manager2
        .create(params(dest.to_str().unwrap(), vec![]))
        .await
        .unwrap();
    let failed = wait_status(
        &store2,
        job2.id.as_str(),
        &["failed"],
        Duration::from_secs(15),
    )
    .await;
    let wd = failed.work_dir.clone().unwrap();
    assert!(std::path::Path::new(&wd).exists());
    manager2.remove(job2.id.as_str(), true).await.unwrap();
    assert!(!std::path::Path::new(&wd).exists());
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn subtitle_cap_is_enforced_at_the_core_boundary() {
    // 9 tracks (contract caps at 8) must be refused even when a caller bypasses the TS side.
    let root = tempdir("subcap");
    let many: Vec<MediaSubtitleSelection> = (0..(MAX_SUBTITLE_TRACKS + 1))
        .map(|i| MediaSubtitleSelection {
            language: format!("l{i}"),
            extension: "vtt".into(),
            is_auto_generated: false,
        })
        .collect();
    let (manager, _store) = make_manager(vec![]);
    let err = manager
        .create(params(root.to_str().unwrap(), many))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidParams);
    std::fs::remove_dir_all(&root).ok();
}
