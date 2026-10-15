# Phase 11 Report — Media Inspector / Extractor (`media.inspect`)

> Status: **delivered (2026-10-11)** · Baseline: Phase 10 (`d4eeebc`) · Contract **v1.6.0**
> (additive) · Plan: `docs/phase-11-plan.md`

## What was delivered

`media.inspect` turns a media page URL into a validated `MediaManifest` — video formats,
audio-only formats and subtitle tracks — by running the **bundled yt-dlp** from the Rust core.
This is the foundation Phase 12 builds the download & merge pipeline on: the renderer never
talks to yt-dlp, never sees a tool path, and every payload crossing the IPC boundary is
schema-validated on both sides.

### Architecture decisions

- **Inspection lives in the Rust core.** The core already owns the two pieces of state that
  make this safe: the `ToolkitMap` (only checksum-proven executables pushed by main) and the
  runtime `ProxyMap`. Tool resolution is **fail-closed**: no verified yt-dlp → the classified
  error `media_tool_missing` points the user at Settings → Media toolkit. The core never
  probes `PATH` and never fetches tools.
- **Process hygiene.** http(s)-only URLs with an explicit argv-hygiene rejection for leading
  `-` (flag injection); spawn is argv-array with **no shell**; `--ignore-config
  --no-progress --no-warnings --no-playlist --dump-single-json --socket-timeout 20 --retries
  3` for deterministic machine-readable output; hard **90 s timeout kills the child**;
  stdout is byte-capped at 64 MiB (runaway output → `media_invalid_response`); only a
  bounded stderr tail (≤16 KiB, last 6 lines surfaced) is kept for classification; stdin is
  closed; `kill_on_drop` guarantees no orphaned extractors.
- **Concurrency cap.** A core-side `Semaphore(3)` bounds simultaneous inspections — a burst
  of UI requests can never turn into a process storm. Excess requests wait, they do not fail.
- **Playlist refusal.** A `_type: playlist/multi_video` response is classified
  (`media_playlist_unsupported`, with the entry count in `data`) — the core never silently
  unwraps the first entry; batch handling is an explicit later-phase decision.
- **Proxy routing.** Optional `proxyProfileId` resolves in the runtime map (missing →
  `proxy_profile_not_found`, fail-closed) and is passed to yt-dlp as `--proxy`. Note: the
  bypass list is a download-engine concept; an explicit inspect request always routes
  through the chosen profile. Proxy credentials ride the argv (local process table only) —
  the alternatives (netrc file / env) put secrets on disk, which is strictly worse.

### Normalization (yt-dlp JSON → contract manifest)

- `videos`: real video streams only — storyboards (`mhtml` / `storyboard` note) and
  codec-less junk are dropped; progressive formats carry their embedded `acodec` (new
  contract field, null = video-only); sorted height ↓ → fps ↓ → bitrate ↓; deduped by
  format id before sorting.
- `audios`: audio-only formats (`acodec` ≠ none, `vcodec` = none/absent), sorted by
  bitrate ↓; bitrate preference `abr` → `tbr` (kbps → bps), videos prefer `vbr` → `tbr`.
- `subtitles`: manual tracks in full (all extensions); automatic captions limited to `vtt`
  and — when yt-dlp marks a source language with a `-orig` key — reduced to that variant,
  so a YouTube page yields a handful of rows instead of hundreds.
- Identity fallbacks: `title` → `fulltitle` → `(untitled)`; `extractor_key` → `extractor` →
  `yt-dlp`; `webpage_url` → the requested URL. A projection that would violate the contract
  (empty identity) is a classified `media_invalid_response`, never a best-effort release.
- Live streams surface honestly via the new `MediaManifest.isLive`; merge policy for them
  is a Phase 12 decision.

### Wire surface (contracts v1.6.0, additive)

- `media.inspect` `{ url, proxyProfileId? } → { manifest }` (core-served; main forwards with
  a 120 s request budget — above the core's own 90 s kill).
- Schema additions: `MediaManifest.isLive`, `VideoFormat.acodec`.
- Append-only error codes: `media_tool_missing`, `media_extract_failed`,
  `media_playlist_unsupported`, `media_invalid_response`.
- Contracts npm package version 1.5.0 → 1.6.0 (matching `CONTRACT_VERSION`, as every phase).
- Fixture `mediaManifest` refreshed (`isLive`, `acodec`, float `fps`) and consumed by
  **both** vitest and `cargo test` — byte-parity proof, as in every prior phase.

### UI

New **Media** nav destination: URL field (Enter submits), optional proxy-profile picker
(direct by default), Inspect with inline spinner; classified errors render as a message bar
(`media_tool_missing` tells the user exactly where to install); the manifest card shows
title, extractor badge, LIVE badge, duration, and three tables — video formats
(resolution/fps/codecs/bitrate/size), audio formats (codec/bitrate/sample-rate/channels/size)
and subtitles (language/title/ext/auto-generated). The page states plainly that downloading
and merging arrive with the next phase — no fake affordances. Remote thumbnails are
deliberately not loaded (strict renderer CSP; no mixed-content surface).

## Test evidence

- **contracts (vitest, 54 ✓)**: v1.6 additions (isLive/acodec schema rejects junk),
  `media.inspect` params validation, core-server registration, append-only code growth,
  version 1.6.0.
- **dc-protocol (cargo)**: media wire round-trip (camelCase keys, nullable acodec present),
  `mediaManifest` fixture byte-parity.
- **download-core (cargo, 132 total ✓, was 115)**:
  - normalization table: progressive + DASH + storyboard + audio-only ×2 + junk entry +
    manual/automatic captions with `-orig` → exact filtering, ordering, codec mapping,
    subtitle limiting (3 tracks); minimal-dump fallbacks; empty-identity rejection;
  - URL validation: `file:` / `ftp:` / `javascript:` / leading-dash all rejected;
  - fail-closed: missing tool, unknown proxy profile, bad URL (never spawns a process);
  - **integration through the real spawn pipeline** with a fake `yt-dlp` executable pushed
    via `toolkit.setPaths` (cfg(unix)): happy path → manifest; playlist → classified with
    entry count; nonzero exit → `media_extract_failed` carrying the stderr excerpt;
    250 ms timeout kills a 5 s sleep (verified wall-clock); 2 MiB output vs 64 KiB cap →
    classified; invalid JSON → classified; argv passthrough proves `--proxy <endpoint>`,
    the URL, `--dump-single-json` and `--no-playlist` all reach the extractor.
- **main (vitest)**: media domain forwards params untouched, enforces the 120 s budget,
  rejects junk params before the core is touched, rejects wire drift (missing `isLive`),
  preserves classified error codes (`SyntaxDmError` round-trip).
- **renderer (vitest)**: media store lifecycle — ready with trimmed URL, proxy id
  forwarded only when chosen, classified failure → error phase, no double-fire in flight,
  empty URL never touches the bridge.

## Verification gate

cargo fmt ✓ · clippy `-D warnings` ✓ · cargo test **132 passed** ✓ · vitest **54 + 105 =
159 passed** (+1 opt-in live) ✓ · typecheck ×4 ✓ · vite build ✓

## Fixed during Test/Fix

- Parallel test threads shared one temp dir per process → the fake-binary tests raced
  (one test's script replaced another's mid-flight, producing cross-classified errors).
  Temp dirs are now tagged per test.
- The fixture parity test exposed a real wire divergence: `fps: 30` (int) vs Rust f64
  `30.0` — the fixture now carries a true float; both languages agree byte-for-byte.
- `import.meta` is banned in CJS-compiled main tests (phase-10 lesson, re-learned) — the
  media domain test inlines its manifest fixture.
- Fluent UI icon `MoviesRegular` does not exist in the pinned icon set →
  `VideoClipMultipleRegular`.
- `SyntaxDmError.from` maps plain Errors to `internal_error` — classified codes must be thrown
  as `SyntaxDmError` to survive the boundary (tested explicitly now).

## Security review notes

- No shell anywhere; argv-array spawn with scheme + dash validation before exec.
- Only main-verified tool paths can execute (fail-closed `ToolkitMap` resolution).
- Output caps on both pipes; bounded stderr tail; child killed on timeout and on drop.
- Playlists are refused, not partially unwrapped — no surprise mass-fetch behavior.
- The renderer still holds no URLs/hashes/paths for the toolkit; the manifest it receives
  is schema-validated twice (main router + renderer bridge).

## Next

Phase 12 — media download & merge pipeline (video/audio/subtitle mux) on top of these
manifests: format selection → download jobs (reusing the segmented engine, checksums and
proxy routing) → FFmpeg mux with the verified tool paths.
