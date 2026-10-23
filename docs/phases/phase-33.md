# Phase 33 — Report: browser downloads in the Downloads list + in-browser media detection

**Delivered 2026-10-23.** App 1.1.0 → **1.2.0**, contracts 1.16-stream → **1.18.0** (additive).
Executed under the full phase discipline (Plan → Implement → Test → Fix → Document → Review →
Commit); plan: `docs/phases/phase-33-plan.md`.

## What shipped

### F-1 — every browser-initiated download is a real, controllable download job

Before this phase no `will-download` handler existed anywhere: a click-download inside any
browser tab fell through to Chromium's default save dialog and never reached the core engine
or the Downloads page. Now (`main/domains/browser-downloads.ts`, attached via the new
TabManager session-lifecycle observer to `persist:browser` AND every `persist:proxy.<id>`
session at creation):

- http(s) download + ready core → `event.preventDefault()` and `download.create` with the
  settings download dir, the browser-suggested filename (URL-derived fallback), and the
  session-fact headers (effective User-Agent, page Referer, initiator Origin, and an explicit
  Cookie header rebuilt from the session cookie jar — httpOnly included, most-specific path
  first, size-bounded). The job rides the existing queue/policy/progress machinery: it appears
  in Downloads with pause/resume/cancel/retry and resumable, checksum-verified semantics.
- `blob:`/`data:` sources and a not-ready core keep Chromium's native download — never trapped.
- A hand-off that fails after `preventDefault` rescues natively exactly once
  (`session.downloadURL` guarded by a 30 s one-shot marker — no loop), with a log line and an
  OS notification. Bytes are never silently lost.

### F-2 — in-browser media detection with one-click downloads and login passthrough

`main/domains/browser-media.ts`, all detection strictly MAIN-SIDE (the Phase 23 no-preload
posture is preserved):

- **Network sniffing** — `session.webRequest.onHeadersReceived` (passive; `callback({})` always
  lets the request proceed unmodified) classifies every response on the browser sessions:
  `video | audio | manifest (m3u8/mpd) | segment (mp2t/m4s/fmp4)`. Both preload fetches and
  actual playback travel this path, which is what makes **multi-server players detectable on
  every server the user switches to**.
- **DOM scan** — a static, read-only `executeJavaScript` snapshot of `<video>/<audio>/<source>`
  sources runs debounced after `media-started-playing` (the moment a player changes servers)
  and on demand. The script carries no bridge and gains nothing; its result is treated as
  untrusted page data and strictly validated (http(s)-only, known kinds, hard caps) before it
  can enter the index.
- **Per-tab TabMediaIndex** — deduped by `kind:url`, capped at 100 (oldest evicted), cleared on
  main-frame navigation and on tab close, and **segments are withheld while any manifest is
  known for the tab** so HLS/DASH playback collapses to the one manifest the user should click.
- **Credentials** — `browser.media.download` is orchestrated entirely in main: the tab's OWN
  session (per-proxy partitions included) supplies User-Agent / Referer / Cookie to the
  download. Cookies never enter the renderer and are never logged (tests pin the log redaction).
- **One click** — direct media → the resumable HTTP engine (`download.create`, tab proxy wins,
  Downloads-page default-proxy semantics); manifests → `media.inspect` (headers attached) →
  pure `pickBestFormats` (tallest video, highest-bitrate audio; audio-only and progressive
  manifests handled) → `media.download` (container mkv, title-derived filename).
- **UI** — a navbar toggle with a live count badge and a collapsible bottom panel in browse
  mode (kind badge, filename, mime/size/provenance meta, per-row Download, scan + clear
  buttons, localized empty state). The panel is a layout sibling of the viewport hole, so the
  WebContentsView auto-shrinks via the existing geometry sync. State lives in the store, so it
  survives page switches. All strings localized en + fa.

### Wire (contracts 1.18.0, additive)

- `BrowserMediaItem` / `BrowserMediaSnapshotEvent` and the main-served
  `browser.media.list | scan | clear | download` methods (`download` returns a discriminated
  union: `{ kind: "file", job: DownloadJob } | { kind: "stream", job: MediaJob }`).
- `browser.media.updated` main event — authoritative full per-tab snapshot (bounded ×100).
- `headers` on `MediaInspectParams` / `MediaDownloadParams` / `MediaJob`
  (`MediaHeaders`: ≤16 entries, HTTP-token names, 1..=4096-byte values, no CR/LF/NUL).

### Rust core (mirror 1.18.0)

- `dc_protocol::MediaHeaderMap` (BTreeMap — deterministic wire + argv), `validate_media_headers`
  (the zod rules repeated at the core boundary), `add_header_args` (`--add-header "Name: Value"`
  pairs, sorted) — shared by `media.inspect` and the job pipeline (stream + subtitle runs).
- `media_jobs.headers_json` storage migration (v10): headers persist with the job, so a paused
  media job resumed after a restart re-authenticates (yt-dlp re-extracts on every run) — the
  same discipline `jobs.headers_json` has had since Phase 6.
- No DRM circumvention of any kind; live streams keep their honest unsupported classification.

## Verification

- `scripts/verify-all.sh` green on the exact 1.2.0 sources (log: `tool-results/verify-all-p33.log`):
  - **136 contracts** vitest (was 128; +8: item/snapshot/union/header-bounds/method+event
    shape/version-floor tests), **449 desktop** vitest (was 406; +43: browser-media domain,
    browser-downloads wiring incl. the rescue + log-redaction pins, TabManager hooks over
    stubbed Electron, browser-media store; real-core E2E suites all green), **308 cargo**
    (was 300; +8: dc-protocol serde/roundtrip/validation/argv determinism, media_job argv with
    headers + unsafe-header rejection, storage headers persistence incl. legacy rows).
  - fmt/clippy clean; renderer build ok with the Phase 22 budget gate respected
    (1,168,475 / 1,200,000 B); checksums/SBOM/final-qa selftests ok; final-qa: app 1.2.0
    aligned across all 7 locations, contracts 1.18.0 wire-consistent and ≠ app version;
    npm audit --omit=dev: 0 vulnerabilities.
- Security review notes: no preload on web content (unchanged); the scan script is static and
  read-only with its result treated as untrusted input; cookies cross only main→core (the same
  trust boundary proxy credentials already use) and are absent from every log line (pinned by
  test); webRequest listeners never modify traffic; the one-click path reuses the audited
  `download.create`/`media.*` surfaces with no new core-side attack surface.

## Files

- Contracts: `packages/contracts/src/domain/browser.ts` (+BrowserMedia*), `domain/media.ts`
  (+MediaHeaders), `protocol/methods.ts`, `protocol/events.ts`, `version.ts`.
- Rust: `dc-protocol/src/{lib,media}.rs`, `download-core/src/{media,media_job}.rs`,
  `dc-storage/src/lib.rs` (migration v10) + tests.
- Main: `main/domains/{tab-manager,browser-downloads,browser-media}.ts`, `main/main.ts`.
- Renderer: `stores/browser-media.ts`, `pages/BrowsePage.tsx`, `i18n/dict/browse.ts`,
  `main.tsx`.
- Tests: `main/__tests__/{browser-downloads,browser-media,tab-manager-media-hooks}.test.ts`,
  `renderer/src/__tests__/browser-media-store.test.ts`, contracts `test/contracts.test.ts`,
  Rust unit + `dc-storage/tests/storage.rs`.
