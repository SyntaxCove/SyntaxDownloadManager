//! Media inspector (Phase 11) — runs the bundled yt-dlp and projects its JSON into a
//! `MediaManifest`.
//!
//! Security and failure posture:
//! - Tool resolution is fail-closed through the `ToolkitMap` (only checksum-proven paths that
//!   main pushed; the core never probes `PATH` and never downloads tools).
//! - The URL must be http(s) and must not start with `-` (argv hygiene) before any process is
//!   spawned; spawn is argv-array, no shell.
//! - Hard timeout kills the child; stdout is byte-capped; only a bounded stderr tail is kept
//!   for error classification. A playlist response is classified, not unwrapped.
//! - Concurrency is capped by a semaphore so a burst of inspects cannot spawn a process storm.

use dc_protocol::{
    ContractError, ErrorCode, MediaInspectParams, MediaInspectResult, MediaManifest,
};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::proxy::{proxy_url, ProxyMap};
use crate::toolkit::ToolkitMap;

/// Inspect limits (tightened in tests; production defaults flow through `Default`).
#[derive(Debug, Clone)]
pub struct InspectLimits {
    /// Total wall-clock budget for one yt-dlp run.
    pub timeout: std::time::Duration,
    /// Hard cap on captured stdout (runaway-output guard).
    pub max_output_bytes: usize,
    /// Bounded stderr tail kept for error classification.
    pub max_stderr_bytes: usize,
}

impl Default for InspectLimits {
    fn default() -> Self {
        Self {
            timeout: std::time::Duration::from_secs(90),
            max_output_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 16 * 1024,
        }
    }
}

/// Inspect a media page: resolve the tool, spawn yt-dlp, normalize the JSON.
pub async fn inspect(
    toolkit: &ToolkitMap,
    proxies: &ProxyMap,
    inspect_semaphore: &Semaphore,
    params: MediaInspectParams,
    limits: &InspectLimits,
) -> Result<MediaInspectResult, ContractError> {
    let url = validate_url(&params.url)?;

    // Fail-closed tool resolution: a tool main never verified does not exist here.
    let tool = toolkit.get("yt-dlp").ok_or_else(|| {
        ContractError::new(
            ErrorCode::MediaToolMissing,
            "the bundled yt-dlp is not installed yet — install it from Settings → Media toolkit",
        )
        .with_data(serde_json::json!({ "tool": "yt-dlp" }))
    })?;

    // Optional proxy routing for the extractor's own traffic (same fail-closed resolution
    // as the download engine: a missing profile is an error, never a silent fallback).
    let mut args: Vec<String> = vec![
        "--ignore-config".into(),
        "--no-progress".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--dump-single-json".into(),
        "--socket-timeout".into(),
        "20".into(),
        "--retries".into(),
        "3".into(),
    ];
    if let Some(profile_id) = params.proxy_profile_id.as_deref() {
        let profile = proxies.get(profile_id).ok_or_else(|| {
            ContractError::new(
                ErrorCode::ProxyProfileNotFound,
                format!("proxy profile {profile_id} is not available"),
            )
        })?;
        args.push("--proxy".into());
        args.push(proxy_url(&profile)?);
    }
    args.push(url);

    // Permit acquisition happens after validation so junk requests never occupy a slot.
    let _permit = inspect_semaphore
        .acquire()
        .await
        .map_err(|_| ContractError::new(ErrorCode::InternalError, "inspect semaphore closed"))?;

    let mut child = Command::new(&tool.path)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            ContractError::new(
                spawn_launch_code(&e, ErrorCode::MediaToolMissing),
                format!("failed to launch the bundled yt-dlp: {e}"),
            )
        })?;

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");

    // Bounded stderr tail read concurrently with the capped stdout read.
    let stderr_tail = tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > 64 * 1024 {
                        // Keep only the tail — the interesting part of a yt-dlp trace.
                        let overflow = buf.len() - 16 * 1024;
                        buf.drain(..overflow);
                    }
                }
            }
        }
        buf
    });

    // Capped stdout read: the moment the cap trips, the read loop stops and the child is
    // dropped (kill_on_drop) after the classification below.
    let mut raw: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut chunk = [0u8; 64 * 1024];
    let read_ok = tokio::time::timeout(limits.timeout, async {
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) => break Some(()),
                Ok(n) => {
                    if raw.len() + n > limits.max_output_bytes {
                        break None; // runaway output — handled below
                    }
                    raw.extend_from_slice(&chunk[..n]);
                }
                Err(_) => break None,
            }
        }
    })
    .await;

    let outcome = match read_ok {
        Err(_elapsed) => {
            let _ = child.kill().await;
            Err(ContractError::new(
                ErrorCode::Timeout,
                format!(
                    "media inspection timed out after {}s",
                    limits.timeout.as_secs()
                ),
            ))
        }
        Ok(None) => Err(ContractError::new(
            ErrorCode::MediaInvalidResponse,
            "extractor output exceeded the size cap",
        )),
        Ok(Some(())) => Ok(()),
    };
    outcome?;

    let status = child.wait().await.map_err(|e| {
        ContractError::new(
            ErrorCode::MediaExtractFailed,
            format!("waiting for the extractor failed: {e}"),
        )
    })?;
    if !status.success() {
        let tail = stderr_tail.await.unwrap_or_default();
        let excerpt = String::from_utf8_lossy(&tail);
        let excerpt = last_lines(excerpt.trim(), 6).to_string();
        return Err(ContractError::new(
            ErrorCode::MediaExtractFailed,
            format!(
                "the extractor failed (exit code {}): {}",
                status.code().unwrap_or(-1),
                if excerpt.is_empty() {
                    "no diagnostic output".to_string()
                } else {
                    excerpt.clone()
                }
            ),
        )
        .with_data(serde_json::json!({ "stderr": excerpt })));
    }

    let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| {
        ContractError::new(
            ErrorCode::MediaInvalidResponse,
            format!("extractor output is not valid JSON: {e}"),
        )
    })?;

    // A playlist slipped through (e.g. an /channel/ or /playlist/ URL): classify, never
    // silently unwrap the first entry — batch handling is an explicit later-phase decision.
    let kind = value
        .get("_type")
        .and_then(|t| t.as_str())
        .unwrap_or("video");
    if kind == "playlist" || kind == "multi_video" {
        return Err(ContractError::new(
            ErrorCode::MediaPlaylistUnsupported,
            "the URL is a playlist or channel; inspect a single media page for now",
        )
        .with_data(serde_json::json!({
            "entries": value.get("playlist_count").cloned().unwrap_or(serde_json::Value::Null),
        })));
    }

    let manifest = normalize(&value, &params.url)?;
    Ok(MediaInspectResult { manifest })
}

/// http(s)-only + argv hygiene (a leading `-` would be parsed as a yt-dlp flag).
pub fn validate_url(url: &str) -> Result<String, ContractError> {
    let trimmed = url.trim();
    if trimmed.starts_with('-') {
        return Err(ContractError::new(
            ErrorCode::UrlInvalid,
            "url must not start with a dash",
        ));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(ContractError::new(
            ErrorCode::UrlInvalid,
            "url must be http(s)",
        ));
    }
    Ok(trimmed.to_string())
}

/// Project yt-dlp's single-JSON dump into the contract's `MediaManifest` shape.
pub fn normalize(
    value: &serde_json::Value,
    source_url: &str,
) -> Result<MediaManifest, ContractError> {
    let s = |k: &str| value.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let f = |k: &str| value.get(k).and_then(|v| v.as_f64());

    let title = s("title")
        .or_else(|| s("fulltitle"))
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "(untitled)".to_string());
    let extractor = s("extractor_key")
        .or_else(|| s("extractor"))
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "yt-dlp".to_string());
    let webpage_url = s("webpage_url").unwrap_or_else(|| source_url.to_string());
    let duration = f("duration").filter(|d| *d >= 0.0);
    let is_live = value
        .get("is_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut videos: Vec<dc_protocol::VideoFormat> = Vec::new();
    let mut audios: Vec<dc_protocol::AudioFormat> = Vec::new();

    if let Some(formats) = value.get("formats").and_then(|v| v.as_array()) {
        for fmt in formats {
            let Some(format_id) = str_field(fmt, "format_id") else {
                continue; // unidentifiable format — never invent an id
            };
            let Some(ext) = str_field(fmt, "ext") else {
                continue;
            };
            let note = fmt
                .get("format_note")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if ext == "mhtml" || note.to_ascii_lowercase().contains("storyboard") {
                continue; // preview strips, not downloadable media
            }
            let vcodec = str_field(fmt, "vcodec");
            let acodec = str_field(fmt, "acodec");
            let has_video = vcodec.as_deref().is_some_and(|c| c != "none");
            let has_audio = acodec.as_deref().is_some_and(|c| c != "none");

            let size = u_field(fmt, "filesize").or_else(|| u_field(fmt, "filesize_approx"));
            if has_video {
                // Prefer the video-specific bitrate, then the total bitrate (kbps → bps).
                let bitrate = u_field(fmt, "vbr")
                    .or_else(|| u_field(fmt, "tbr"))
                    .map(|kbps| (kbps as f64 * 1000.0) as u64);
                videos.push(dc_protocol::VideoFormat {
                    format_id,
                    container: str_field(fmt, "container").unwrap_or_else(|| ext.clone()),
                    extension: ext,
                    width: u_field(fmt, "width"),
                    height: u_field(fmt, "height"),
                    fps: f_field(fmt, "fps").filter(|v| *v > 0.0),
                    vcodec: vcodec.unwrap_or_default(),
                    acodec: if has_audio { acodec } else { None },
                    vbitrate_bps: bitrate,
                    file_size_bytes: size,
                });
            } else if has_audio {
                let bitrate = u_field(fmt, "abr")
                    .or_else(|| u_field(fmt, "tbr"))
                    .map(|kbps| (kbps as f64 * 1000.0) as u64);
                audios.push(dc_protocol::AudioFormat {
                    format_id,
                    container: str_field(fmt, "container").unwrap_or_else(|| ext.clone()),
                    extension: ext,
                    acodec: acodec.unwrap_or_default(),
                    abitrate_bps: bitrate,
                    sample_rate_hz: u_field(fmt, "asr"),
                    channels: u_field(fmt, "audio_channels"),
                    file_size_bytes: size,
                });
            }
            // Neither a real video nor a real audio stream → skip.
        }
    }

    // Best-first presentation; ties break toward fps then bitrate. Dedupe by format id
    // BEFORE sorting (yt-dlp ids are unique per extraction; a repeat keeps the first).
    let mut seen = std::collections::HashSet::new();
    videos.retain(|v| seen.insert(v.format_id.clone()));
    videos.sort_by(|a, b| {
        b.height
            .unwrap_or(0)
            .cmp(&a.height.unwrap_or(0))
            .then(b.fps.unwrap_or(0.0).total_cmp(&a.fps.unwrap_or(0.0)))
            .then(
                b.vbitrate_bps
                    .unwrap_or(0)
                    .cmp(&a.vbitrate_bps.unwrap_or(0)),
            )
    });
    let mut seen_audio = std::collections::HashSet::new();
    audios.retain(|a| seen_audio.insert(a.format_id.clone()));
    audios.sort_by(|a, b| {
        b.abitrate_bps
            .unwrap_or(0)
            .cmp(&a.abitrate_bps.unwrap_or(0))
    });

    let subtitles = normalize_subtitles(value);

    // The contract requires non-empty strings; a projection that would violate it is a
    // classified bug, not a best-effort release to the boundary.
    if title.is_empty() || webpage_url.is_empty() {
        return Err(ContractError::new(
            ErrorCode::MediaInvalidResponse,
            "extractor output lacks a usable title or webpage url",
        ));
    }

    Ok(MediaManifest {
        source_url: source_url.to_string(),
        extractor,
        title,
        duration_seconds: duration,
        webpage_url,
        thumbnail_url: s("thumbnail"),
        is_live,
        videos,
        audios,
        subtitles,
    })
}

/// Manual subtitles first (all exts), then automatic captions limited to `vtt` — and when
/// yt-dlp marks a source language with a `-orig` key, only that variant is kept so a YouTube
/// page yields dozens of tracks instead of hundreds.
fn normalize_subtitles(value: &serde_json::Value) -> Vec<dc_protocol::SubtitleTrack> {
    let mut tracks: Vec<dc_protocol::SubtitleTrack> = Vec::new();

    let mut push_section = |section: &serde_json::Value, auto: bool| {
        let Some(map) = section.as_object() else {
            return;
        };
        for (lang, list) in map {
            let Some(list) = list.as_array() else {
                continue;
            };
            for (idx, t) in list.iter().enumerate() {
                let Some(ext) = t.get("ext").and_then(|v| v.as_str()) else {
                    continue;
                };
                let name = t.get("name").and_then(|v| v.as_str()).map(str::to_string);
                let format_id = if list.len() > 1 {
                    format!("{lang}-{ext}-{idx}")
                } else {
                    format!("{lang}-{ext}")
                };
                tracks.push(dc_protocol::SubtitleTrack {
                    format_id,
                    language: lang.clone(),
                    title: name,
                    extension: ext.to_string(),
                    is_auto_generated: auto,
                });
            }
        }
    };

    if let Some(manual) = value.get("subtitles") {
        push_section(manual, false);
    }
    if let Some(automatic) = value.get("automatic_captions").and_then(|v| v.as_object()) {
        let has_orig = automatic.keys().any(|k| k.ends_with("-orig"));
        let filtered: serde_json::Value = serde_json::Value::Object(
            automatic
                .iter()
                .filter(|(k, _)| {
                    // vtt only for automatic captions; keep the source variant when marked.
                    if has_orig {
                        k.ends_with("-orig")
                    } else {
                        true
                    }
                })
                .map(|(k, list)| {
                    let limited = serde_json::Value::Array(
                        list.as_array()
                            .map(|a| {
                                a.iter()
                                    .filter(|t| {
                                        t.get("ext").and_then(|e| e.as_str()) == Some("vtt")
                                    })
                                    .cloned()
                                    .collect()
                            })
                            .unwrap_or_default(),
                    );
                    (k.clone(), limited)
                })
                .collect(),
        );
        push_section(&filtered, true);
    }
    tracks
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty() && s != "none")
}

fn u_field(v: &serde_json::Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| x.as_u64())
}

fn f_field(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

/// Keep the last `n` lines of a diagnostic blob (stderr tails matter most).
fn last_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

// ---------------------------------------------------------------------------
// spawn error classification
// ---------------------------------------------------------------------------

/// Honest spawn-error classification. A tool that cannot be FOUND — or cannot be
/// executed due to permissions — is genuinely "missing" and keeps the caller's
/// missing-tool code. Any OTHER spawn failure (EAGAIN / EMFILE / fd exhaustion —
/// transient OS pressure under load) must NOT claim the tool is missing: that
/// misleads the user and made `oversized_output_is_capped` flake in CI when the
/// runner briefly hit process limits. Such failures surface as `InternalError`
/// with the OS error in the message.
pub(crate) fn spawn_launch_code(e: &std::io::Error, missing_code: ErrorCode) -> ErrorCode {
    match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => missing_code,
        _ => ErrorCode::InternalError,
    }
}

#[test]
fn spawn_launch_code_is_honest() {
    let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
    assert_eq!(
        spawn_launch_code(&missing, ErrorCode::MediaToolMissing),
        ErrorCode::MediaToolMissing
    );
    let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        spawn_launch_code(&denied, ErrorCode::MediaToolMissing),
        ErrorCode::MediaToolMissing
    );
    // EAGAIN (11) — the transient class that made the CI test flake; must NOT read
    // "tool missing".
    let transient = std::io::Error::from_raw_os_error(11);
    assert_eq!(
        spawn_launch_code(&transient, ErrorCode::MediaToolMissing),
        ErrorCode::InternalError
    );
    let other = std::io::Error::from(std::io::ErrorKind::Other);
    assert_eq!(
        spawn_launch_code(&other, ErrorCode::MediaToolMissing),
        ErrorCode::InternalError
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{proxy_url, ProxyMap, RuntimeProxy};
    use dc_protocol::ToolkitPathEntry;
    use std::sync::Arc;

    fn tool(path: &str) -> ToolkitMap {
        let map = ToolkitMap::new();
        map.replace(vec![ToolkitPathEntry {
            id: "yt-dlp".into(),
            version: "test".into(),
            path: path.into(),
        }])
        .unwrap();
        map
    }

    fn empty_toolkit() -> ToolkitMap {
        ToolkitMap::new()
    }

    fn proxy_map_with() -> ProxyMap {
        let map = ProxyMap::new();
        map.replace(vec![RuntimeProxy {
            id: "01HPROXY".into(),
            scheme: "http".into(),
            host: "proxy.example".into(),
            port: 3128,
            username: Some("u".into()),
            password: Some("p".into()),
            bypass_list: vec![],
        }]);
        map
    }

    fn params(url: &str) -> MediaInspectParams {
        MediaInspectParams {
            url: url.into(),
            proxy_profile_id: None,
        }
    }

    fn sem() -> Arc<Semaphore> {
        Arc::new(Semaphore::new(3))
    }

    #[test]
    fn url_validation_rejects_schemes_and_flag_injection() {
        assert!(validate_url("https://example.com/v").is_ok());
        assert!(validate_url("  https://example.com/v ").is_ok());
        assert_eq!(
            validate_url("file:///etc/passwd").unwrap_err().code,
            ErrorCode::UrlInvalid
        );
        assert_eq!(
            validate_url("ftp://example.com/v").unwrap_err().code,
            ErrorCode::UrlInvalid
        );
        assert_eq!(
            validate_url("--dump-json").unwrap_err().code,
            ErrorCode::UrlInvalid
        );
        assert_eq!(
            validate_url("javascript:alert(1)").unwrap_err().code,
            ErrorCode::UrlInvalid
        );
    }

    #[test]
    fn normalize_filters_storyboards_and_maps_codecs() {
        let dump = serde_json::json!({
            "title": "Sample Video",
            "extractor_key": "Youtube",
            "webpage_url": "https://example.com/watch/abc",
            "duration": 212.5,
            "thumbnail": "https://example.com/t.jpg",
            "formats": [
                // progressive (video+audio)
                { "format_id": "18", "ext": "mp4", "vcodec": "avc1.42001E",
                  "acodec": "mp4a.40.2", "height": 360, "fps": 30, "tbr": 500, "filesize": 13000000 },
                // DASH video-only, best
                { "format_id": "137", "ext": "mp4", "vcodec": "avc1.640028",
                  "acodec": "none", "height": 1080, "width": 1920, "fps": 30, "tbr": 4500,
                  "filesize": 118000000 },
                // storyboard — must be dropped
                { "format_id": "sb0", "ext": "mhtml", "vcodec": "none", "acodec": "none",
                  "format_note": "storyboard", "height": 90 },
                // audio-only opus
                { "format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus",
                  "abr": 160, "asr": 48000, "audio_channels": 2, "filesize": 3400000 },
                // audio-only aac, lower bitrate
                { "format_id": "140", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2",
                  "abr": 128, "asr": 44100, "filesize": 2700000 },
                // junk with neither stream
                { "format_id": "weird", "ext": "mp4", "vcodec": "none", "acodec": "none" }
            ],
            "subtitles": {
                "en": [
                    { "ext": "vtt", "name": "English" },
                    { "ext": "srt", "name": "English" }
                ]
            },
            "automatic_captions": {
                "en-orig": [ { "ext": "vtt", "name": "English (original)" } ],
                "de": [ { "ext": "vtt", "name": "German" }, { "ext": "srt", "name": "German" } ],
                "fr": [ { "ext": "vtt", "name": "French" } ]
            }
        });
        let m = normalize(&dump, "https://example.com/watch/abc").unwrap();
        assert_eq!(m.title, "Sample Video");
        assert_eq!(m.extractor, "Youtube");
        assert!(!m.is_live);
        // Videos: 137 (1080) first, then 18 (360) — storyboard and junk dropped.
        assert_eq!(m.videos.len(), 2);
        assert_eq!(m.videos[0].format_id, "137");
        assert_eq!(m.videos[0].acodec, None);
        assert_eq!(m.videos[0].vbitrate_bps, Some(4_500_000));
        assert_eq!(m.videos[1].format_id, "18");
        assert_eq!(m.videos[1].acodec.as_deref(), Some("mp4a.40.2"));
        // Audios sorted by bitrate: opus 160 first.
        assert_eq!(m.audios.len(), 2);
        assert_eq!(m.audios[0].format_id, "251");
        assert_eq!(m.audios[0].abitrate_bps, Some(160_000));
        assert_eq!(m.audios[0].sample_rate_hz, Some(48_000));
        assert_eq!(m.audios[0].channels, Some(2));
        // Manual subs all exts; automatic limited to vtt and (when yt-dlp marks an origin)
        // to the `-orig` source variant only → 2 manual + 1 automatic.
        assert_eq!(m.subtitles.len(), 3);
        assert!(m.subtitles.iter().any(|t| t.format_id == "en-vtt-0"));
        assert!(m
            .subtitles
            .iter()
            .any(|t| t.language == "en-orig" && t.is_auto_generated));
        assert!(!m
            .subtitles
            .iter()
            .any(|t| t.language == "de" && t.is_auto_generated));
        assert!(!m
            .subtitles
            .iter()
            .any(|t| t.extension == "srt" && t.is_auto_generated));
    }

    #[test]
    fn normalize_falls_back_for_minimal_dumps() {
        let dump = serde_json::json!({ "webpage_url": "https://example.com/x" });
        let m = normalize(&dump, "https://example.com/x").unwrap();
        assert_eq!(m.title, "(untitled)");
        assert_eq!(m.extractor, "yt-dlp");
        assert!(m.videos.is_empty() && m.audios.is_empty());
        assert!(m.thumbnail_url.is_none());
    }

    #[test]
    fn normalize_rejects_empty_identity() {
        // An empty title AND empty webpage url cannot satisfy the contract.
        let dump = serde_json::json!({ "title": "", "webpage_url": "" });
        let err = normalize(&dump, "https://example.com/x").unwrap_err();
        assert_eq!(err.code, ErrorCode::MediaInvalidResponse);
    }

    #[tokio::test]
    async fn missing_tool_fails_closed() {
        let err = inspect(
            &empty_toolkit(),
            &ProxyMap::new(),
            &sem(),
            params("https://example.com/v"),
            &InspectLimits::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::MediaToolMissing);
    }

    #[tokio::test]
    async fn unknown_proxy_profile_fails_closed() {
        let err = inspect(
            &tool("/bin/true"),
            &ProxyMap::new(),
            &sem(),
            MediaInspectParams {
                url: "https://example.com/v".into(),
                proxy_profile_id: Some("ghost".into()),
            },
            &InspectLimits::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProxyProfileNotFound);
    }

    #[tokio::test]
    async fn bad_url_never_spawns_a_process() {
        // The tool path is a valid executable (/bin/true) — if spawn happened, we would get
        // a different classification than url_invalid.
        let err = inspect(
            &tool("/bin/true"),
            &ProxyMap::new(),
            &sem(),
            params("file:///etc/passwd"),
            &InspectLimits::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::UrlInvalid);
    }

    // ---- unix integration: a fake yt-dlp binary through the real spawn pipeline ----

    fn write_fake(dir: &std::path::Path, body: &str) -> String {
        let path = dir.join("yt-dlp");
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().to_string()
    }

    const MINI_DUMP: &str = r#"{"_type":"video","title":"Fake Video","extractor_key":"Fake",
        "webpage_url":"https://example.com/watch/abc","duration":10,
        "formats":[{"format_id":"18","ext":"mp4","vcodec":"avc1","acodec":"mp4a","height":360}],
        "subtitles":{}}"#;

    #[cfg(unix)]
    #[tokio::test]
    async fn happy_path_through_spawn() {
        let tmp = tempfile_dir("happy");
        let json = MINI_DUMP.replace('\n', "").replace("  ", "");
        let path = write_fake(&tmp, &format!("#!/bin/sh\nprintf '%s' '{json}'\n"));
        let result = inspect(
            &tool(&path),
            &ProxyMap::new(),
            &sem(),
            params("https://example.com/watch/abc"),
            &InspectLimits::default(),
        )
        .await
        .unwrap();
        assert_eq!(result.manifest.title, "Fake Video");
        assert_eq!(result.manifest.videos.len(), 1);
        assert_eq!(result.manifest.videos[0].format_id, "18");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn playlist_response_is_classified() {
        let tmp = tempfile_dir("playlist");
        let json = r#"{"_type":"playlist","title":"Chan","playlist_count":7,"entries":[]}"#;
        let path = write_fake(&tmp, &format!("#!/bin/sh\nprintf '%s' '{json}'\n"));
        let err = inspect(
            &tool(&path),
            &ProxyMap::new(),
            &sem(),
            params("https://example.com/channel/x"),
            &InspectLimits::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::MediaPlaylistUnsupported);
        assert_eq!(err.data.as_ref().unwrap()["entries"], 7);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_exit_carries_stderr_excerpt() {
        let tmp = tempfile_dir("stderr");
        let path = write_fake(
            &tmp,
            "#!/bin/sh\nprintf 'boom line 1\\nboom line 2\\nERROR: Unsupported URL' >&2\nexit 1\n",
        );
        let err = inspect(
            &tool(&path),
            &ProxyMap::new(),
            &sem(),
            params("https://example.com/v"),
            &InspectLimits::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::MediaExtractFailed);
        assert!(err.message.contains("Unsupported URL"));
        assert!(err.data.as_ref().unwrap()["stderr"]
            .as_str()
            .unwrap()
            .contains("Unsupported URL"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_the_child() {
        let tmp = tempfile_dir("timeout");
        let path = write_fake(&tmp, "#!/bin/sh\nsleep 5\n");
        let limits = InspectLimits {
            timeout: std::time::Duration::from_millis(250),
            ..Default::default()
        };
        let started = std::time::Instant::now();
        let err = inspect(
            &tool(&path),
            &ProxyMap::new(),
            &sem(),
            params("https://example.com/v"),
            &limits,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout);
        // The kill must actually cut the 5s sleep short.
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_output_is_capped() {
        let tmp = tempfile_dir("oversize");
        // 2 MiB of filler with a 64 KiB cap → classified, no JSON parse attempt.
        let path = write_fake(
            &tmp,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=2048 2>/dev/null\n",
        );
        let limits = InspectLimits {
            max_output_bytes: 64 * 1024,
            ..Default::default()
        };
        // A spawn can transiently fail under heavy parallel load (EAGAIN / fd pressure —
        // the phase 32 CI flake). Retry ONLY that internal-error class; the assertion
        // itself stays strict, so the cap path must actually execute to pass.
        let mut attempt = 0;
        loop {
            attempt += 1;
            let err = inspect(
                &tool(&path),
                &ProxyMap::new(),
                &sem(),
                params("https://example.com/v"),
                &limits,
            )
            .await
            .unwrap_err();
            if err.code == ErrorCode::InternalError && attempt < 3 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            assert_eq!(err.code, ErrorCode::MediaInvalidResponse);
            break;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_json_is_classified() {
        let tmp = tempfile_dir("badjson");
        let path = write_fake(&tmp, "#!/bin/sh\nprintf 'not json at all'\n");
        let err = inspect(
            &tool(&path),
            &ProxyMap::new(),
            &sem(),
            params("https://example.com/v"),
            &InspectLimits::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::MediaInvalidResponse);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxy_and_url_reach_the_extractor_argv() {
        let tmp = tempfile_dir("argv");
        let args_file = tmp.join("args.txt");
        let json = MINI_DUMP.replace('\n', "").replace("  ", "");
        let path = write_fake(
            &tmp,
            &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$FAKE_OUT\"\nprintf '%s' '{json}'\n"),
        );
        std::env::set_var("FAKE_OUT", &args_file);
        let result = inspect(
            &tool(&path),
            &proxy_map_with(),
            &sem(),
            MediaInspectParams {
                url: "https://example.com/watch/abc".into(),
                proxy_profile_id: Some("01HPROXY".into()),
            },
            &InspectLimits::default(),
        )
        .await
        .unwrap();
        assert_eq!(result.manifest.title, "Fake Video");
        let argv = std::fs::read_to_string(&args_file).unwrap();
        assert!(argv.contains("--proxy"));
        let expected = proxy_url(&proxy_map_with().get("01HPROXY").unwrap()).unwrap();
        assert!(argv.contains(&expected), "argv must contain {expected}");
        assert!(argv.contains("https://example.com/watch/abc"));
        assert!(argv.contains("--dump-single-json"));
        assert!(argv.contains("--no-playlist"));
        std::env::remove_var("FAKE_OUT");
    }

    fn tempfile_dir(tag: &str) -> std::path::PathBuf {
        // Unique per test: cargo runs test threads in parallel inside one process.
        let dir =
            std::env::temp_dir().join(format!("syntaxdm-media-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
