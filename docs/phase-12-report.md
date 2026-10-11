# Phase 12 Report — Media Download & Merge Pipeline (video/audio/subtitle mux)

> Contract **v1.6.0 → v1.7.0 (additive)** · Baseline: Phase 11 (`10e5ade`) · Storage
> migration v6 (`media_jobs`) · Gate: cargo 159 (+27) · vitest 177 (+18) · typecheck ×4 ·
> vite build — all green.

## What shipped

A persistent media pipeline: the user inspects a page (Phase 11), selects one video format,
one audio format and/or subtitle tracks, picks the mux container (mkv/mp4), and starts a
**media job** that survives pause, crash, app restart and extractor URL rotation:

1. **Extraction** — the core re-runs the bundled yt-dlp (`--dump-single-json`, Phase 11
   inspector) against the page URL. The row is enriched with the real title/thumbnail on the
   first extraction. A live manifest is refused (`media_live_unsupported`) — honest surface,
   no silent never-completing download.
2. **Stream downloads** — one bundled-yt-dlp run per selected stream (`-f <formatId> -o
   <work>/<label>.%(ext)s`, `--newline`, machine progress via `--progress-template
   download:UNIDM …`). Streams already completed are detected on disk and skipped; yt-dlp's
   `--continue` resumes `.part` bytes across runs. A single `--skip-download` run fetches all
   selected subtitle tracks (`--write-subs --write-auto-subs --sub-langs … --sub-format
   <exts>/best`).
3. **Mux** — the bundled FFmpeg stream-copies video+audio+subtitles into the target
   container (`-f matroska` + `-c:s srt`, or `-f mp4` + `-c:s mov_text`; never a re-encode).
   Output goes to `<dest>/<base>.<container>.tmp-unidm` and is renamed only after a clean
   exit and a non-empty size check — a partial mux is never presented as finished.
   Audio-only jobs skip the mux: the audio file moves to the destination untouched.
4. **Lifecycle** — `media.download/list/get/pause/resume/cancel/remove` (all core-served),
   throttled `media.progress` (500 ms ticker, byte-accurate from yt-dlp tokens and ffmpeg
   `out_time_ms` vs manifest duration for mux ETA) + authoritative `media.updated` events.
   The renderer's Media page grows selection UI (click-to-select rows, subtitle checkboxes,
   container picker) and a job list with progress bars and pause/resume/cancel/remove.

## Key decisions (as planned → as built)

- **yt-dlp downloads, not the HTTP engine.** Extractor URLs are ephemeral, fragment-based
  and signature-protected; the page URL is the job's persistent source and every run
  re-extracts (rebind-by-re-extraction, the Phase 7 philosophy applied to media). Bytes on
  disk are the resume authority: completed streams skip instantly, partial streams resume.
- **Strict selection.** A selected format id that vanished from the fresh extraction is a
  classified failure (`media_format_not_found`), never a silent substitute. Subtitles
  require a video selection (the zod refinement is mirrored in the core boundary).
- **Fail-closed shared runtime.** The engine and the pipeline now share one
  `Arc<ToolkitMap>`, `Arc<ProxyMap>` and one inspect semaphore (created in `JobManager`).
  Missing yt-dlp/ffmpeg → `media_tool_missing` → **paused** (recoverable after the toolkit
  installs); missing proxy profile → `proxy_profile_not_found` → **paused** (Phase 9
  semantics; never a silent direct fallback).
- **Separate `media_jobs` table (v6) + `MediaJobManager`.** The HTTP queue pump is
  range-download-shaped; media jobs run a simple FIFO pump with 2 process-heavy slots. Boot
  recovery flips `queued/extracting/downloading/muxing` → `paused` (a fresh core never
  auto-starts media jobs — the Phase 8 baseline rule).
- **Pause/cancel are acknowledged.** `pause`/`cancel` wait (bounded 10 s) for the runner to
  kill the child and persist; the durable row is the truth, and the 500 ms ticker stops
  overwriting any row that left the active set (a killed child's grandchildren can hold
  pipes open — the runner never blocks on their EOF).

## Fixed during Test/Fix

- `Engine::new` signature grew the shared maps — the three test harnesses (engine, queue,
  recover) construct their own `Arc` maps now.
- The UNIDM progress template is fixed-width (5 tokens, `NA` = unknown); the first parser
  draft consumed the estimate slot conditionally and mis-parsed speed — now the estimate is
  always consumed and `total = exact.or(estimate)`.
- `run_child` pipes have different concrete types — erased to `Box<dyn AsyncRead>` pairs;
  tokio's `Split` has no select-friendly `next()` — replaced with a `read_line` loop.
- Pause ack race: the first draft returned before the runner persisted; `wait_runner_ack`
  (bounded poll) now closes the gap, and the ticker gained the active-status guard after the
  fake-binary test exposed a shell-grandchild holding pipe EOF for 30 s.
- Rust `MediaJob` gained the persisted `filename` column end-to-end (TS schema, fixture-free
  optional field, storage v6) so the base name survives restarts.
- Fixture ULIDs must be Crockford-valid (no `U`); contracts fixtures regenerated.
- Renderer: `SubtitleTrack.isAutoGenerated` is `boolean | null` in the manifest while a
  selection needs the concrete flag — coerced (`?? false`) with a comment.

## Verification gate

| Check | Result |
|-------|--------|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo test` | **159 passed** (was 132; +4 dc-protocol, +3 dc-storage, +11 download-core unit, +11 media_job integration) |
| `vitest` (contracts + desktop) | **61 + 116 = 177 passed** (was 54 + 105) |
| `npm run typecheck` (×4 configs) | clean |
| `npm run build:desktop` | green |

Integration coverage (fake `yt-dlp`/`ffmpeg` executables through `toolkit.setPaths`,
cfg(unix)): happy path (video+audio+subtitle → completed, work dir cleaned, hint total
150), audio-only move (keeps `.m4a`, no ffmpeg needed), mux failure (`media_mux_failed`,
work dir kept, no final file), download failure (`media_download_failed`), vanished format
(`media_format_not_found`), missing tool (`media_tool_missing` → paused), live refusal,
missing proxy (paused), pause-mid-run → resume → completed, remove(deleteFiles) cleanup,
subtitle cap enforced at the core boundary.

## Out of scope (later phases)

Live-stream recording, playlist batch download, audio transcoding, thumbnail embedding,
scheduler-window coupling for media jobs, unified downloads library (Phase 14).
