# Phase 12 Plan — Media Download & Merge Pipeline (video/audio/subtitle mux)

> Baseline: Phase 11 (`10e5ade`) · Contract **v1.6.0 → v1.7.0 (additive)** · Builds on the
> verified toolkit paths (`ToolkitMap`), the runtime proxy map (`ProxyMap`) and the
> `MediaManifest` projection shipped in Phase 11.

## Goal

Turn an inspected manifest into a finished media file. The user selects one video format,
one audio format and/or subtitle tracks; the app creates a **persistent media job** that:

1. re-extracts the page (fresh stream data — extractor URLs are ephemeral by design),
2. downloads the selected streams with the **bundled yt-dlp** into a private work dir,
3. **muxes** the streams + subtitles with the **bundled FFmpeg** into the final container,
4. reports byte-accurate throttled progress, and survives pause / crash / app restart,
   keeping every already-downloaded byte (yt-dlp `.part` resume + completed-stream skip).

## Key decisions

1. **The bundled yt-dlp downloads the streams — not the HTTP engine.** Extractor media URLs
   are ephemeral, often fragment-based (HLS/DASH), frequently signature-protected and
   request-context-bound (UA/headers/IP). The generic segmented engine stays the tool for
   direct HTTP files; media pages go through yt-dlp. The job's **persistent source is the
   page URL**: every run re-extracts (rebind-by-re-extraction — the same recovery
   philosophy as Phase 7), and yt-dlp's default `--continue` keeps `.part` bytes across
   runs even when the upstream stream URL rotated.
2. **One yt-dlp run per stream.** Separate runs (`-f <formatId> -o <work>/<label>.%(ext)s`)
   map progress 1:1 to a known stream (no cross-stream parsing), let completed streams be
   skipped instantly on resume ("already been downloaded"), and keep the final mux fully
   ours. A single extra `--skip-download` run fetches all selected subtitle tracks at once.
3. **The final mux is ours (FFmpeg, `-c copy` — never a re-encode).** Inputs: video, audio,
   subtitle files. `-f matroska` (mkv, `-c:s srt`) or `-f mp4` (`-c:s mov_text`). Output is
   written to `<dest>/<base>.<container>.tmp-syntaxdm` and renamed only after a clean exit —
   a partial mux is never presented as finished. Audio-only jobs skip the mux: the audio
   file moves to the destination untouched.
4. **Fail-closed everywhere.** yt-dlp/ffmpeg resolve through the shared `ToolkitMap` only
   (`media_tool_missing` → **paused**, recoverable after the toolkit installs); proxy
   profiles resolve through the shared `ProxyMap` (`proxy_profile_not_found` → paused, the
   Phase 9 semantics). A live manifest is refused with `media_live_unsupported` — honest
   surface, no silent hang; live recording stays a later-phase decision. A selected format
   that vanished from the fresh extraction is `media_format_not_found` (the site changed;
   the user re-inspects and re-selects — bytes stay on disk).
5. **Progress is parsed, not guessed.** yt-dlp runs carry
   `--progress-template download:SYNTAXDM %(progress.downloaded_bytes)s …` (machine tokens on
   stderr; human lines never parsed); ffmpeg runs carry `-progress pipe:1 -nostats`
   (`out_time_ms` microseconds vs manifest duration). A 500 ms ticker emits throttled
   `media.progress` events and persists the row; every state change emits `media.updated`.
6. **Separate `media_jobs` table (storage migration v6), separate `MediaJobManager`.** The
   queue/pump/bandwidth machinery of `JobManager` is HTTP-job-shaped; media jobs own a
   simple FIFO pump with 2 process-heavy slots. They share the toolkit/proxy maps, the
   inspect semaphore, the events channel and the UI surface. Boot recovery flips
   `queued/extracting/downloading/muxing` → `paused` (a fresh core never auto-starts
   media jobs — established Phase 8 baseline semantics).
7. **Contracts v1.7.0 (additive only).** New core methods `media.download/list/get/pause/
   resume/cancel/remove`; new events `media.progress` / `media.updated`; new append-only
   error codes `media_download_failed`, `media_mux_failed`, `media_format_not_found`,
   `media_live_unsupported`; new `MediaJob` domain shape + `mediaJob` fixture consumed by
   both vitest and cargo (wire parity, as every phase).

## Work breakdown

| Step | Content |
|------|---------|
| Contracts | `domain/media.ts` additions (MediaSubtitleSelection, MediaJob, params/results), `methods.ts` + `events.ts` registries, `errors.ts` append, version 1.7.0, `mediaJob` fixture, tests |
| dc-protocol | `media.rs` wire types + `error.rs` codes + `CONTRACT_VERSION` 1.7.0 + fixture parity test |
| dc-storage | migration v6 (`media_jobs`), CRUD + progress update + boot reset, tests |
| download-core | `media_job.rs` (manager, run pipeline, yt-dlp/ffmpeg runners, parsers, arg builders), shared `Arc<ToolkitMap>`/`Arc<ProxyMap>` refactor, server arms, unit + fake-binary integration tests (cfg(unix)) |
| main | `domains/media.ts` registers the 7 methods (core event forwarding already global) |
| renderer | `stores/media.ts` jobs + actions + event subscription, `MediaPage.tsx` selection UI + download flow + jobs list, tests |
| docs | phase report, PHASES.md status, worklog |

## Test plan

- **contracts (vitest)**: v1.7 additions, at-least-one-format + subtitle rules + container
  enum + leading-dash refusals, registries (`server: "core"`), error registry, fixture.
- **dc-protocol (cargo)**: `MediaJob` round-trip + `mediaJob` fixture byte-parity.
- **dc-storage (cargo)**: media CRUD, progress update, boot reset of active rows, migration v6.
- **download-core (cargo)**: unit — validation table (url/format-id/subtitle/lang hygiene),
  yt-dlp SYNTAXDM token parsing, ffmpeg `out_time_ms` parsing, stream-file discovery, mux arg
  building (mkv/mp4 × video/audio/subtitle combinations), plan derivation; **integration**
  via fake `yt-dlp`/`ffmpeg` executables (cfg(unix), pushed through `toolkit.setPaths`):
  happy path (video+audio+subs → completed, work dir cleaned), audio-only move, missing
  format, mux failure (work dir kept for resume), yt-dlp failure, missing tool (paused),
  live refusal, pause mid-run → resume completes, missing proxy (paused).
- **main (vitest)**: media domain registration forwards to the supervisor (mocked).
- **renderer (vitest)**: media store — create/pause/resume/cancel/remove, `media.updated`
  upsert, `media.progress` patch, error surface.
- **Gate**: cargo fmt + clippy `-D warnings` + tests green; vitest green; typecheck ×4;
  vite build.

## Out of scope (later phases)

Live-stream recording, playlist batch download, audio transcoding (mp3/flac extraction),
thumbnail embedding, post-mux chapter metadata, unified Downloads-library merge (Phase 14),
scheduler-window coupling for media jobs.
