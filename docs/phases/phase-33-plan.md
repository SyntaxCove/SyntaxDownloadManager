# Phase 33 — Plan: browser downloads in the Downloads list + in-browser media detection

Post-1.1 user request (Persian, 2026-10-23):

1. "هنگام مرور وقتی روی یه فایل کلیک می‌کنیم و فایل شروع به دانلود می‌کنه در قسمت دانلود
   نمایش داده نمی‌شه … هر فایلی از هر جایی شروع به دانلود می‌شه باید داخل قسمت دانلود
   نمایش داده بشه و بشه کنترلش کرد" — a download started anywhere in the browser must
   appear in the Downloads list with live status and full controls (pause/resume/cancel).
2. "در هنگام مرور یه صفحه وقتی یه پلیر هست مدیا شناسایی بشه و یه لیست از فایل‌های مدیا …
   روی هر کدوم کلیک کردم شروع به دانلود کنه؛ اگر در سایتی لاگین کردم اطلاعات لازم برای
   دانلود مدیا در اختیار دانلودر مدیا قرار بگیره؛ بعضی سایت‌ها چند سرور مختلف برای نمایش
   مدیا دارن — روی هر سروری که کلیک کردم نرم‌افزار باید بتونه مدیاها رو تشخیص بده، حالا
   با preload یا play کردن مدیا" — while browsing, media must be detected and listed;
   clicking any item starts its download; the browsing session's credentials (cookies)
   must reach the media downloader; multi-server players must be detected whichever
   server is played (via preload fetches or actual playback).

## Current facts (verified in sources)

- No `session.on("will-download")` exists anywhere in the app: browser-initiated
  downloads fall through to Chromium's default save dialog and never reach the core
  engine or the Downloads page.
- The core HTTP engine already accepts and persists request headers
  (`DownloadCreateParams.headers` → `jobs.headers_json` → applied on every request,
  required for faithful resume) — Feature 1 is pure main-process wiring.
- The media pipeline (`media.inspect` / `media.download`) has **no** headers/cookies
  slot on the wire and `--add-header` is never passed to yt-dlp; logged-in media
  downloads are impossible today.
- Web content security posture (Phase 23): sandboxed, contextIsolated, **no preload**
  on third-party pages — in-page sniffing must therefore be main-side.
- Browser sessions: `persist:browser` + `persist:proxy.<profileId>` (per-identity cookie
  jars — credentials must be resolved from the *tab's own session*, main-side).
- The renderer bridge only accepts methods/events registered in the contracts registries.

## Design

### F-1 — Browser-initiated downloads land in Downloads (controllable)

- `main/domains/browser-downloads.ts`: `attachBrowserDownloadHandling(session, deps)`
  registers `session.on("will-download")`. Decision (pure, unit-tested):
  - http(s) URL **and** core ready (sync check) → `event.preventDefault()` and hand off
    to the core via `download.create` with `destinationDir = settings.downloadDir`,
    `filename = item.getFilename()` (fallback derived from the URL), and curated request
    headers (Cookie / User-Agent / Referer / Origin) — the session cookie header is built
    explicitly from `session.cookies.get({url})` (httpOnly included) and merged over the
    item's own request headers. The job then flows through the existing queue/policy/
    events machinery: it appears in Downloads with full controls, resumable.
  - non-http(s) (blob:, data:) or core not ready → do nothing: Chromium's native
    download (current behavior) proceeds, never trapped.
  - async hand-off failure after preventDefault → honest rescue: re-issue
    `session.downloadURL(url)` guarded by a one-shot rescue marker so the second
    `will-download` falls through natively (bounded, no loop), plus a log + OS
    notification. Bytes are never silently lost.
- TabManager gains a session-lifecycle observer so every browser session (default and
  per-proxy, present and future) gets the handler exactly once at creation.

### F-2 — In-browser media detection + one-click download

Main-side detection only (no preload, preserving the Phase 23 posture):

- **Network sniffing**: `session.webRequest.onHeadersReceived` on every browser session;
  a pure classifier (`classifyMediaResponse`) maps content-type + extension to
  `video | audio | manifest | segment` (m3u8/mpd → manifest; mp2t/m4s/ts → segment;
  video/*, audio/*, known media extensions → direct). Findings go into a per-tab
  `TabMediaIndex` (dedupe by URL, cap 100, **segments suppressed while a manifest exists
  for the tab** so HLS/DASH flood collapses to the manifest the user should click).
  Attributed per tab via `webContentsId → tabId`.
- **DOM scan**: a static, read-only `executeJavaScript` snippet (no bridge, no Node,
  result zod-validated and dropped on any malformed entry) lists `<video>/<audio>/<source>`
  `currentSrc`/`src`. Runs automatically when a page settles and when
  `media-started-playing` fires (debounced) — this is what catches server switches on
  multi-server players — and on demand via `browser.media.scan`.
- **Credentials**: main builds auth headers from the tab's own session — effective
  `User-Agent` (respects the Phase 32 override), `Referer` (page URL), `Cookie` (path-
  specific-first). Cookies never enter the renderer; log lines never contain them.
- **One click** (`browser.media.download {tabId, itemId}`): direct file/segment →
  `download.create` (headers, proxy follows the tab, default-proxy semantics identical to
  the Downloads page); manifest → `media.inspect` (headers) → pure `pickBestFormats`
  (best video by height/bitrate; best audio by bitrate; audio-only pages handled) →
  `media.download` (headers, container mkv, tab proxy) — the job appears in Media with
  the standard pause/resume/cancel machinery.
- **Contracts 1.18.0 (additive)**: `BrowserMediaItem` (+ kind/origin/byteSize/filename),
  `browser.media.list|scan|clear|download` (main-served), `browser.media.updated` event
  (full per-tab snapshot), and `headers` on `MediaInspectParams` / `MediaDownloadParams` /
  `MediaJob` (bounded: ≤16 headers, HTTP-token names, no CR/LF/NUL values).
- **Rust**: dc-protocol mirrors 1.18.0 + headers fields; `validate_media_headers` +
  `add_header_args` (sorted, `--add-header "Name: Value"`) shared by inspect and the
  job pipeline (stream + subtitle runs); `media_jobs.headers_json` storage migration so
  a resumed job re-authenticates (yt-dlp re-extracts on every run); MediaJob round-trips
  headers on the wire (nullish = omitted).
- **Renderer**: `stores/browser-media.ts` (per-tab mirrors + panel state + download
  action with pending state); BrowsePage gains a navbar toggle with a live count badge
  and a collapsible bottom panel (kind badge, filename, mime/size/host, per-row Download,
  scan button, localized empty state) — the WebContentsView auto-shrinks via the existing
  viewport-rect sync, and the panel state survives page switches (store, not component).
- i18n en+fa for every new string; fa copy reviewed for the download/media vocabulary
  already used across the app.

## Work items

- **P-1** contracts: BrowserMedia* domain types, methods, event; `MediaHeaders` on the
  three media schemas; version 1.17.0 → 1.18.0; tests (validation bounds, method/event
  shape, version floor ≥ 1.18.0).
- **P-2** Rust dc-protocol: header fields + version; serde roundtrip test.
- **P-3** Rust download-core: `validate_media_headers` + `add_header_args`; inspect args
  builder; stream/sub args gain headers; `MediaJobManager::create` threads headers;
  dc-storage migration + insert/update/row mapping; unit tests (argv, validation
  table, storage roundtrip incl. migration on an old-schema DB row).
- **P-4** main: TabManager session-lifecycle observer + `tabIdForWebContents` +
  `onPageChanged`/`onMediaPlaying` activity signals; `browser-downloads.ts` (decision +
  header assembly + rescue); `browser-media.ts` (classifier, TabMediaIndex, scan script
  + parser, pickBestFormats, cookie assembly, download orchestration, domain
  registration); wiring in `main.ts`.
- **P-5** renderer: store + panel + navbar toggle + i18n (en/fa) + store test.
- **P-6** main unit tests: browser-downloads (decision/header/filename/rescue marker),
  browser-media (classifier matrix, index dedupe/cap/segment-suppression, best-format
  picker, scan parser, cookie ordering), tab-manager hooks (Electron stubbed at the port
  boundary, per tab-manager-ua.test.ts precedent).
- **P-7** verification gate: build contracts → typecheck → full vitest (contracts +
  desktop incl. real-core E2E) → cargo fmt/clippy/test → renderer build + budget gate
  → checksums/SBOM/final-qa selftests → npm prod audit.
- **P-8** docs: phase-33 report, PHASES.md row 33, README status/roadmap, worklog
  Task ID: 33; version 1.1.0 → 1.2.0 across the 7 aligned locations (contracts stay on
  their own 1.18.0 stream).

## Acceptance criteria

1. A click-download of an http(s) file in any browser tab (direct or proxied) produces a
   `download.create` job with captured headers and shows in Downloads with
   pause/resume/cancel/retry — proven by unit tests on the decision + header assembly.
2. blob:/data: downloads and a core-not-ready hand-off keep native behavior (no trapped
   or lost downloads); a create failure rescues the item natively exactly once.
3. Playing or preloading media in any tab (including switching between multi-server
   mirrors) surfaces the media in the browse-mode panel; segments collapse when a
   manifest is present; the list is deduped, capped, cleared on navigation, and cleared
   on tab close.
4. One click on a direct item creates a resumable download job; one click on a manifest
   creates a media job with auto-picked best formats; both carry the tab session's
   cookies/UA/Referer to the engine (headers never logged, never rendered).
5. Media jobs persist headers (migration) so resume after restart re-authenticates.
6. Contracts 1.18.0 additive-only; every new wire shape validated on both TS boundaries
   and in Rust; all gates green.

## Explicit non-goals

- No DRM circumvention of any kind (unchanged policy); encrypted-media streams that
  yt-dlp cannot fetch are reported as honest tool errors.
- No preload script on web content; no renderer-visible cookies.
- No new settings keys — the panel is opt-in UI, detection is passive observation of
  traffic the user's own browser session makes.
- No changes to the scheduler/torrent domains or the queue engine.
