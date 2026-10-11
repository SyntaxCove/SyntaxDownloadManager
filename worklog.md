# Worklog — UniDM (Unified Browser + Advanced Download Manager)

Shared multi-agent work log. Append-only. Product: production-grade Windows 11 x64 desktop app
(Electron shell + React/Fluent renderer + Rust `download-core` supervised subprocess).
Engineering priority: data integrity > security > reliability/recovery > correctness >
maintainability > performance > UX > feature breadth. No AI features. No placeholders/mocks/TODOs
in deliverable code.

---
Task ID: 0
Agent: main
Task: Sandbox recovery + Phase 0 (monorepo scaffold, conventions, authoritative phase map)

Work Log:
- Found sandbox reset: repo contained only "Initial commit" (.env/.gitignore). Phases 0–4 from the
  prior session were not persisted. Per user protocol ("فاز N" = deliver through Phase N), rebuilt
  everything through Phase 5 in this session.
- Verified toolchain: Node v24.21.0, npm 11.19.0, Rust 1.99.0 (rustup installed), gcc 14.2,
  npm registry reachable.
- Pinned versions from registry (not memory): electron 44.5.1, @fluentui/react-components 9.74.9,
  react 19.3.0, zustand 5.0.15, zod 4.6.5, vite 8.3.3, @vitejs/plugin-react 6.1.2,
  typescript 5.9.3 (TS7 rejected as too new for toolchain), vitest 5.0.3.
- Policy: sandbox installs Electron with ELECTRON_SKIP_BINARY_DOWNLOAD=1 (no GUI in Linux sandbox;
  user's Windows machine performs full install + GUI verification + .exe packaging).
- Wrote docs/PHASES.md (authoritative 0–31 phase map), docs/ARCHITECTURE.md, root scaffold,
  tsconfig.base.json, workspaces layout, .gitignore, scripts/.

Stage Summary:
- Repo layout established: packages/contracts, apps/desktop (main/preload/renderer),
  core/ (Rust workspace: dc-protocol, dc-storage, download-core), docs/, scripts/.
- Next: Phase 1 contracts package.

---
Task ID: 0-5 (rebuild)
Agent: main
Task: Deliver Phases 0→5 for "فاز ۵" (sandbox reset recovery)

Work Log:
- Rebuilt Phases 0–4 from scratch (commits 60801e6, 1d95ed1, 0d53b2e, e35fbd6, 98abf40).
- Phase 5: Rust workspace (dc-protocol/dc-storage/download-core), 25 cargo tests incl.
  cross-language fixtures + engine integration with local HTTP server + spawned-binary e2e;
  TS CoreSupervisor/CoreClient/backoff + download domain + Downloads UI (42 desktop tests).
- Full verify: typecheck ✓, vitest 54 ✓, cargo fmt/clippy ✓, cargo test 25 ✓, vite build ✓.

Stage Summary:
- Through Phase 5, the app has: sandboxed Electron shell, validated typed IPC, React+Fluent
  UI with theme/settings, WebContentsView browser tabs, and a supervised resumable download
  engine with SQLite persistence. Next: Phase 6 (segmented engine) per docs/PHASES.md.

---
Task ID: 6
Agent: main
Task: Phase 6 — segmented multi-connection engine, per-segment journal, integrity (checksums)

Work Log:
- Plan: docs/phase-6-plan.md (two write modes, window planner, journal discipline,
  integrity gates, contracts v1.1.0 additive, test plan, verification gate).
- Reinstalled toolchain after sandbox reset (rustup 1.99.0 + rustfmt + clippy; sha2 pinned
  to crates.io max stable 0.11.0, verified 2026-10-07).
- Implemented: segments.rs (planner + journal helpers + hex/normalize), engine v2
  (per-window tasks, If-Range guards, Content-Range start/total validation, window-capped
  writes, bounded retries + bounded clean restarts, pause/cancel cursor flush, streaming
  SHA-256 + expected-checksum verdict + fsync-before-rename), dc-storage migration v2
  (segments table + job integrity columns + transactional segment API), server/manager/main
  wiring (download.setConcurrency gains maxConnectionsPerDownload, UNIDM_MAX_CONNECTIONS).
- Contracts v1.1.0: DownloadJob integrity/segmentation fields with pinned wire rules
  (nullable = always serialized; nullish = omitted), setConcurrency extension, settings
  maxConnectionsPerDownload, segmented + legacy fixtures; npm package version 1.1.0.
- Electron: supervisor env knob; main.ts applies both limits at core-ready and re-applies on
  settings.changed; SettingsPage slider; DownloadsPage connection + checksum badges (Fluent).
- Fixed during Test/Fix: zero-byte + unknown-total Content-Range semantics, append-mode EOF
  completion, Stopped outcome for the stop race, early-exit "done" journal marker, pre-existing
  core.test.ts unhandled-rejection flake, clippy findings (truncate(false), div_ceil, lints).

Stage Summary:
- Verification gate all green: cargo fmt/clippy clean, cargo test 49 passed (was 25),
  vitest 60 passed (was 54), typecheck + vite build pass.
- Commit 4b5db7c; phase report docs/phase-6-report.md; PHASES.md #6 delivered.
- Next: Phase 7 (recovery engine v2 — source re-acquisition, multi-signal revalidation,
  rebind, gap-fill) per docs/PHASES.md.

---
Task ID: 7
Agent: main
Task: Phase 7 — recovery engine v2 (source re-acquisition, multi-signal revalidation, rebind, gap-fill)

Work Log:
- Baseline repair first: sandbox reset had wiped the Rust toolchain + contracts dist.
  Reinstalled rustup 1.99.0 (+rustfmt/clippy), rebuilt contracts, verified Phase 0-6 gate
  green (cargo 49 / vitest 60 / typecheck) before planning.
- Plan: docs/phase-7-plan.md — revalidation matrix, classification, recover/replaceUrl/retry
  surface, storage v3, UI wiring, test plan, verification gate.
- Implemented: recover.rs (SourceSignals/RevalidateVerdict/revalidate + classify_source_failure,
  12 unit cases); engine drive-loop pre-flight revalidation (part provenance = validators + size
  + content type; Identical -> If-Range resume, ChecksumArbitrated -> journal kept + no If-Range,
  Restart -> bounded pre-flight wipe); probe classification (404/410 -> source_gone,
  401/403 -> source_forbidden); restart exhaustion -> source_changed; Engine::recover + rebind
  (recoveryCount/reboundAt, wiped-clears-checksum-artifacts, known-bad checksum forces restart);
  manager recover/replace_url/retry; server dispatch arms; storage migration v3; contracts v1.2.0
  (3 error codes, 2 job fields, 3 methods, HttpUrl protocol pin); Electron domain + store +
  DownloadsPage Recover/Replace-URL-dialog/retry/recovered-badge + per-code hints.
- Fixed during Test/Fix: two Phase 6 source-change tests updated to the stronger Phase 7
  invariant (stale validator never presented — revalidation is pre-flight); arbitration test
  split into honest vs lying-server after review; closure-lifetime fix in etag_eq;
  zod z.url() tightened to http(s) via protocol regex (matches core rule); dead-code allows
  for per-binary test helpers; storage migration test pinned to >= 3.
- Verification gate: cargo fmt/clippy clean, cargo test 74 passed (was 49), vitest 65 passed
  (was 60), typecheck + vite build pass. Commit: phase(7). Report: docs/phase-7-report.md.

Stage Summary:
- The product promise holds end-to-end: an expired URL never destroys the job or the bytes.
  Failed jobs carry actionable codes; recover/replaceUrl rebind onto live sources and the
  engine gap-fills only the missing ranges, with checksum arbitration guarding every
  unproven splice. Next: Phase 8 (queue, scheduler policies, concurrency/bandwidth).

---
Task ID: 8
Agent: main
Task: Phase 8 — queue, scheduler policies, concurrency and bandwidth management

Work Log:
- Baseline repair first: sandbox reset had wiped the Rust toolchain + contracts dist
  (file-mode-only diffs). Reinstalled rustup 1.99.0, rebuilt contracts, verified the
  Phase 0-7 gate green (cargo 74 / vitest 65 / typecheck / build) before planning.
- Plan: docs/phase-8-plan.md — queue order model, scheduler policy surface, token-bucket
  bandwidth design, contracts v1.3.0 additive set, test plan, verification gate.
- Implemented: contracts v1.3.0 (DownloadJob.queuePosition always-serialized +
  speedLimitKBps nullish; 5 new core methods queueMove/startAll/pauseAll/setSpeedLimit/
  setPolicy; settings autoStartNewDownloads + schedule window HH:MM; new queued-job
  fixture); dc-storage migration v4 (+2 columns); dc-protocol mirror fields;
  download-core rate_limit.rs (cancellation-aware token bucket, incremental grants),
  manager.rs (queue positions + pump order, manual-run markers, policy + 30s tick,
  startAll/pauseAll/queueMove/setSpeedLimit), engine.rs (per-run job bucket + global
  bucket gates before each segment write, queue slot released at probe), server.rs
  dispatch arms; Electron main policy.ts translation + setPolicy apply at ready /
  settings.changed / 10-min drift guard; renderer store + DownloadsPage (queue badges,
  move controls, Start/Pause all, speed-limit dialog) + SettingsPage (auto-start,
  schedule window, wired speed limit).
- Fixed during Test/Fix: rate-limiter deadlock when the request exceeded bucket
  capacity (incremental grants + regression test); display comparator regrouped to
  active -> queue -> rest; fmt pass on manager.rs.
- Verification gate: cargo fmt/clippy clean, cargo test 93 passed (was 74),
  vitest 84 passed (was 65), typecheck + vite build pass.

Stage Summary:
- The download queue is now a first-class managed object: persisted ordering with
  reorder, start/pause-all, auto-start parking, an optional daily download window that
  pauses auto-started runs (never user-started ones), and global + per-job token-bucket
  bandwidth caps applied live in the Rust core. Contracts v1.3.0, storage v4.
- Next: Phase 9 (proxy engine — profiles, per-tab / per-job routing) per docs/PHASES.md.

---
Task ID: 9
Agent: main
Task: Phase 9 — proxy engine (profiles, per-tab / per-job routing)

Work Log:
- Baseline repair first: sandbox reset had wiped the Rust toolchain again (rustup
  reinstalled, contracts rebuilt); verified the Phase 0-8 gate green (cargo 93 /
  vitest 84 / typecheck / build) before planning. Also routed the workspace scripts
  through npm (bun re-evaluates `npm run --workspaces` recursively).
- Plan: docs/phase-9-plan.md — secret lifecycle (keychain at rest, runtime push to the
  core, fail-closed routing), contract v1.4.0 additive set, per-profile tab partitions,
  bypass subset semantics, test plan + gate.
- Contracts: ProxyProfileInput/Public(redacted)/Endpoint; proxy.list/create/update/remove
  (main) + proxy.setRuntime/proxy.test (core); download.create.proxyProfileId +
  download.setProxy; BrowserTab/TabCreateParams.proxyProfileId + browser.tab.setProxy;
  3 append-only error codes (proxy_keychain_unavailable / proxy_profile_not_found /
  proxy_in_use); fixtures proxyProfile + downloadJobProxied (paused fail-closed state).
- Core: proxy.rs (RuntimeProxy, ProxyMap full-replace, proxy_url with encoded userinfo,
  host_matches_bypass matrix); engine client_for_job resolves the run client BEFORE any
  I/O — missing runtime profile PAUSES the run with proxy_profile_not_found (never
  direct-fallback), same fail-closed path in recover(); per-run reqwest client with
  Proxy::all + basic_auth (socks feature added to pinned reqwest); manager set_runtime_
  proxies/set_job_proxy(active-run guard)/test_proxy; server arms; storage v5
  (jobs.proxy_profile_id only — no credential column).
- Main: ProxyProfileStore (proxy-profiles.json atomic + quarantine; safeStorage
  enc:v1 ciphertext at rest; keychain-unavailable refuses to save; redaction everywhere;
  never-log) + registerProxyDomain (remove guarded by core job count -> proxy_in_use,
  core_unavailable fail-closed); TabManager per-profile persistent partitions with
  fixed-server rules + session login handler (typed as generic emitter — Electron typings
  expose session 'login' only there), browser.tab.setProxy recreates the view on the
  target partition; main.ts pushes the runtime set at ready / mutations / restarts.
- Renderer: proxy store + Proxy page (editor dialog, test with latency/exitIP, guarded
  delete), nav entry; DownloadsPage proxy select on create + per-job set-proxy dialog +
  proxy badge + proxy_profile_not_found hint; BrowsePage proxied-new-tab menu + tab badge.
- Fixed during Test/Fix: reqwest basic_auth(&str,&str) + touch(&mut) borrow errors;
  fixture speedLimitKBps null vs nullish wire rule (removed from proxied fixture);
  non_snake_case bypassList -> bypass_list + serde rename; clippy err_expect; Phase 8
  downloads-store fixture missing proxyProfileId (contract parse caught it); ULID-valid
  ids in mocks; noUncheckedIndexedAccess in tests; Menu placement prop unsupported.
- Verification gate: cargo fmt/clippy clean, cargo test 107 passed (was 93), vitest
  108 passed (was 84), typecheck x4 clean, vite build green. Commit: phase(9).
  Report: docs/phase-9-report.md.

Stage Summary:
- Proxy profiles are now first-class: keychain-backed secrets that never reach the
  renderer, disk-in-plaintext, or logs; per-download routing with fail-closed pause
  semantics (a missing profile pauses, bytes stay, resume completes after re-push);
  per-tab Chromium partitions with proxy-auth handling and identity-scoped cookies;
  deletion guarded by live job usage. Contracts v1.4.0, storage v5.
- Next: Phase 10 (bundled media toolkit — pinned FFmpeg/yt-dlp/Deno fetch + version
  manifest) per docs/PHASES.md.

---
Task ID: 10
Agent: main
Task: Phase 10 — bundled media toolkit (pinned FFmpeg / yt-dlp / Deno fetch + version manifest)

Work Log:
- Baseline repair first: sandbox reset had wiped the Rust toolchain a third time
  (rustup 1.99.0 + rustfmt/clippy reinstalled); verified the Phase 0-9 gate green
  (cargo 107 / vitest 94+ / typecheck x4 / build) before planning.
- Plan: docs/phase-10-plan.md — manifest pinning model, fetch-verify-extract-activate
  pipeline, fail-closed core push, contracts v1.5.0 additive set, test plan + gate.
- Contracts v1.5.0: new toolkit domain (ToolId/PlatformKey/ToolkitArtifact/ToolkitManifest/
  ToolkitToolStatus), 4 main methods (getStatus/ensureAll/ensure/cancel) + core method
  toolkit.setPaths + toolkit.progress event; 5 append-only error codes; settings
  mediaToolsAutoFetch (default true); z.partialRecord for per-platform subsets; fixtures
  toolkitManifest/toolkitStatus/toolkitPaths consumed by vitest AND cargo.
- Main: src/main/toolkit/{manifest,fetcher,verify,extract,manager}.ts + domains/toolkit.ts
  (IPC registration + shared core push), paths.ts toolchainsManifest, main.ts wiring
  (load, auto-fetch per settings, re-push after every core restart); renderer toolkit
  store + Settings "Media toolkit" section (state badges, progress bar, Install/Cancel,
  auto-fetch toggle).
- Core: dc-protocol/src/toolkit.rs wire types + error codes + CONTRACT_VERSION 1.5.0;
  download-core/src/toolkit.rs ToolkitMap (staged-validate-then-swap replace); engine field,
  manager forward, server dispatch arm; fixture parity + manager integration tests.
- Pin tooling: scripts/pin-toolchains.mjs (GitHub atom-feed discovery — REST API is
  rate-limited; expanded_assets for asset names; upstream SHA2-256SUMS cross-check for
  yt-dlp). Authored apps/desktop/resources/toolchains.json LIVE: yt-dlp@2026.08.19
  (PyInstaller standalones: yt-dlp.exe / yt-dlp_linux — no host Python), deno@2.9.7,
  ffmpeg@N-127259-gb91a82d6dd (BtbN dated autobuild, permanent assets); both yt-dlp hashes
  MATCH upstream sums. Live opt-in E2E (toolkit-live.test.ts, RUN_LIVE_TOOLKIT=1) installed
  all three production tools from the real URLs in 47s — hashes byte-exact end-to-end.
- Fixed during Test/Fix: zip entries without explicit directory records need parent mkdir
  (ENOENT on yazl archives); platform key must come from INJECTED platform/arch;
  ToolkitMap.replace partial-apply bug caught by its own fail-closed test; tar-stream v3
  entry( header, buffer, cb ) overload; import.meta banned in CJS-compiled tests.
- Verification gate: cargo fmt/clippy clean, cargo test 115 passed (was 107), vitest
  94 passed + 1 opt-in live (was 84), typecheck x4 clean, vite build green.
  Commit: phase(10). Report: docs/phase-10-report.md.

Stage Summary:
- The media toolkit is first-class: a checksum-pinned, per-platform manifest ships with the
  app; main fetches/verifies/extracts/activates with zip-slip + size-cap + quarantine
  guards; only verified executables ever reach the Rust core (toolkit.setPaths, re-pushed
  on restart). The end user never installs FFmpeg/yt-dlp/Deno.
- Next: Phase 11 (media inspector/extractor — media.inspect, manifests) on top of the
  verified tool paths.

---
Task ID: 11
Agent: main
Task: Phase 11 — media inspector/extractor (`media.inspect`, manifests) on the verified toolkit paths

Work Log:
- Baseline repair: sandbox reset had wiped the Rust toolchain a FOURTH time (rustup 1.99.0
  + rustfmt/clippy reinstalled); verified the Phase 0-10 gate green (cargo 115 / vitest 148
  / typecheck x4 / build) before planning.
- Plan: docs/phase-11-plan.md — inspection lives in the Rust core (fail-closed tool
  resolution via ToolkitMap, proxy routing via runtime ProxyMap), contracts v1.6.0 additive
  set, normalization rules, test plan + gate.
- Contracts v1.6.0: media.inspect (core) {url, proxyProfileId?} -> {manifest};
  MediaManifest.isLive + VideoFormat.acodec; 4 append-only error codes (media_tool_missing /
  media_extract_failed / media_playlist_unsupported / media_invalid_response); fixture
  mediaManifest refreshed (isLive, acodec, float fps); npm package 1.5.0 -> 1.6.0.
- dc-protocol: src/media.rs wire types (camelCase serde) + MediaInspectParams/Result +
  error codes + CONTRACT_VERSION 1.6.0 + mediaManifest fixture byte-parity test.
- Core: download-core/src/media.rs — http(s)-only + leading-dash URL validation, fail-closed
  yt-dlp resolution, argv-array spawn (no shell, --ignore-config --no-playlist
  --dump-single-json), optional --proxy with fail-closed profile resolution, 90s timeout
  with kill, 64 MiB stdout cap, 16 KiB stderr tail, Semaphore(3) cap, playlist refusal,
  normalization (storyboard/mhtml/junk filtering, height->fps->bitrate ordering, pre-sort
  dedupe, automatic-caption vtt + -orig limiting); engine.inspect_media + manager passthrough
  + server dispatch arm.
- Main: domains/media.ts validated forwarder (120s budget) + main.ts registration.
- Renderer: stores/media.ts (inspect lifecycle), pages/MediaPage.tsx (URL + proxy picker +
  manifest tables for videos/audios/subtitles), AppShell "Media" nav entry
  (VideoClipMultipleRegular — MoviesRegular does not exist in the pinned icon set).
- Fixed during Test/Fix: parallel test threads shared one temp dir (fake-binary tests
  raced, cross-classified errors) -> per-test tagged temp dirs; fixture fps int vs Rust f64
  wire divergence (fixture now true float); import.meta banned in CJS-compiled main tests
  (inline fixture); UniDmError.from maps plain Errors to internal_error (classified codes
  must be UniDmError — now explicitly tested); TS delete on non-optional -> Record cast.
- Verification gate: cargo fmt/clippy clean, cargo test 132 passed (was 115), vitest
  54 contracts + 105 main/renderer = 159 passed (was 48+94), typecheck x4 clean, vite build
  green. Commit: phase(11). Report: docs/phase-11-report.md.

Stage Summary:
- media.inspect is live end-to-end: renderer -> main (validated forward) -> core (fail-closed
  tool resolution, hardened spawn, bounded output, hard timeout, semaphore cap) -> normalized
  contract manifest -> double-validated on both boundaries. Playlist URLs are classified, not
  unwrapped. Live streams surface honestly (isLive). The Media page renders the full format
  tables; downloading/merging is explicitly Phase 12 and the UI says so.
- Next: Phase 12 (media download & merge pipeline — format selection -> segmented downloads
  -> FFmpeg mux with verified tool paths) per docs/PHASES.md.

---
Task ID: 12
Agent: main
Task: Phase 12 — media download & merge pipeline (video/audio/subtitle mux) on the verified toolkit paths

Work Log:
- Baseline repair: sandbox reset had wiped the Rust toolchain a FIFTH time (rustup 1.99.0 +
  rustfmt/clippy reinstalled); verified the Phase 0-11 state from git history (phase(0..11)
  commits + docs all present) before planning.
- Plan: docs/phase-12-plan.md — yt-dlp downloads the streams (page URL is the persistent
  source; rebind-by-re-extraction), our own FFmpeg mux (stream-copy only), separate
  media_jobs table + MediaJobManager, contracts v1.7.0 additive set, test plan + gate.
- Contracts v1.7.0: 7 core methods (media.download/list/get/pause/resume/cancel/remove),
  MediaJob/MediaSubtitleSelection/MediaContainer/MediaProgress schemas, media.progress +
  media.updated events, 4 append-only error codes (media_download_failed / media_mux_failed /
  media_format_not_found / media_live_unsupported), mediaJob + mediaProgress fixtures
  (Crockford-valid ULIDs), package 1.6.0 -> 1.7.0.
- dc-protocol: media.rs wire types (MediaJob with persisted filename, MediaContainer with
  mux_format/subtitle_codec helpers) + error codes + CONTRACT_VERSION 1.7.0 + fixture
  byte-parity tests.
- dc-storage: migration v6 (media_jobs table + indexes), media CRUD + update_media_progress +
  reset_active_media_jobs (boot recovery: queued/extracting/downloading/muxing -> paused),
  tests for CRUD round-trip, reopen durability, boot reset, schema version.
- download-core: src/media_job.rs — MediaJobManager (create/pump(2 slots)/run_job/drive),
  extraction reuses the Phase 11 inspector (fail-closed tools + proxy, pause-aware select),
  strict format resolution (vanished id -> media_format_not_found), per-stream yt-dlp runs
  with UNIDM progress-template parsing (fixed 5-token rule), completed-stream disk skip,
  single --skip-download subtitle run, ffmpeg mux to .tmp-unidm then rename-after-clean-exit
  (+ empty-output guard), audio-only moves untouched, 500ms ticker (durable row + throttled
  events) with an active-status guard, pause/cancel runner-ack (bounded wait), bounded
  diagnostics tails, argv-array spawns only; Engine/JobManager now share Arc<ToolkitMap>/
  Arc<ProxyMap>/Arc<Semaphore>; server arms for all 7 methods.
- Fixed during Test/Fix: sandbox removed Engine's 2-arg new -> 3 test harnesses updated;
  Split lacks select-friendly next() -> read_line loop; Box<dyn AsyncRead> pipe erasure;
  pause ack race (runner persists after wait) + shell-grandchild holding pipe EOF 30s ->
  tail drain detaches on interrupts + ticker never overwrites non-active rows; run_child
  tail await deadlock; redundant-closure clippy lints; filename column end-to-end.
- main: domains/media.ts registers all 8 media methods (inspect keeps 120s budget, pipeline
  30s); core event forwarding stays centralized in the download domain (comment updated).
- renderer: stores/media.ts (jobs list, selection state, download/pause/resume/cancel/remove,
  upsert/patchProgress, subscribeMediaEvents wired from main.tsx); MediaPage format rows are
  click-to-select, subtitle checkboxes, container picker, download bar (saving to the
  settings downloadDir), live manifests disable download honestly, media-jobs list with
  progress bars + actions; media-store tests for the full lifecycle.
- Verification gate: cargo fmt/clippy clean, cargo test 159 passed (was 132), vitest
  61+116=177 passed (was 54+105), typecheck x4 clean, vite build green.
  Commit: phase(12). Report: docs/phase-12-report.md.

Stage Summary:
- The media pipeline is complete end-to-end: inspect -> select -> persistent job (extract,
  download streams with bundled yt-dlp, mux with bundled FFmpeg) -> finished file in the
  destination dir. Recovery is byte-preserving across pauses, crashes and URL rotation;
  live streams, vanished formats and missing tools are classified, never guessed. The end
  user still installs nothing.
- Next: Phase 13 (torrent engine + UI) per docs/PHASES.md.
