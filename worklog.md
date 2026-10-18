# Worklog — Syntax Download Manager (Unified Browser + Advanced Download Manager)

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
  wiring (download.setConcurrency gains maxConnectionsPerDownload, SYNTAXDM_MAX_CONNECTIONS).
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
  (inline fixture); SyntaxDmError.from maps plain Errors to internal_error (classified codes
  must be SyntaxDmError — now explicitly tested); TS delete on non-optional -> Record cast.
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
  with SYNTAXDM progress-template parsing (fixed 5-token rule), completed-stream disk skip,
  single --skip-download subtitle run, ffmpeg mux to .tmp-syntaxdm then rename-after-clean-exit
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

---
Task ID: 13
Agent: Super Z (main agent)
Task: Phase 13 — Torrent engine + UI ("فاز ۱۳"): verify Phases 0–12, then Plan → Implement → Test → Fix → Document → Review → Commit.

Work Log:
- Verified Phase 0–12 from git history (all delivered; Phase 12 = 8013c3d) and repaired the
  sandbox-wiped Rust toolchain again (rustup 1.99.0 + rustfmt/clippy; 6th reset).
- Plan: docs/phase-13-plan.md — native Rust BT engine in download-core (end user installs
  no torrent client), new dc-bt crate, contracts v1.7.0→v1.8.0 (additive activation of the
  never-consumed v1 torrent stub; statuses gained queued/canceled), storage v7.
- Contracts: torrent.ts (TorrentJob v2 with infoHash/sourceKind/files/counters, 7 methods,
  torrent.progress/updated events, 4 append-only error codes incl. torrent_proxy_unsupported),
  fixtures torrentJob/torrentProgress, dc-protocol/src/torrent.rs + fixture parity tests,
  CONTRACT_VERSION 1.8.0 both sides, package bumped to 1.8.0.
- dc-bt (new crate, 46 tests): bencode (raw spans for exact info-hash), metainfo (v1,
  hybrid OK, v2-only classified, traversal-proof sanitize), magnet (hex+base32), trackers
  (HTTP + UDP/BEP 15, compact+dict peers), peer wire (BEP 3 + BEP 9/10), picker (rarest-
  first, on-demand endgame, 16 KiB blocks), SOCKS5/HTTP-CONNECT tunnels, DHT (BEP 5,
  closest-N table, rotating tokens, non-blocking bootstrap), base64/base32/hex helpers.
- dc-storage v7: torrent_jobs (metainfo blob, have blob, files/trackers JSON, counters) +
  CRUD + boot reset (queued/metadata/downloading/seeding → paused); 4 new tests.
- download-core: torrent_manager.rs (~2.2k lines) — TorrentManager (bind listener+DHT,
  pump ≤3, runner-ack pause/cancel/remove, fail-closed proxy → ProxyTunnel, metadata phase
  with per-peer fetch bounded by budget, swarm phase with announce/dial loop, 500 ms ticker
  with tick-driven finalize_completion, stale-request sweep, unchoke rotation, seeding
  after completion); server.rs arms for torrent.*; manager.rs delegation + shutdown;
  main.rs binds the peer listener.
- Electron main: domains/torrent.ts (7 methods, 30 s budget) registered in main.ts.
- Renderer: stores/torrent.ts (authoritative snapshots + progress patches, exactly-one-
  source add), TorrentsPage.tsx (magnet textarea, .torrent file picker → base64 ≤8 MiB,
  destination dir from settings, proxy picker, progress/speeds/peers, lifecycle actions),
  AppShell nav entry, subscribeTorrentEvents in main.tsx; 8 store tests + 5 domain tests.
- Fixed during Test/Fix (highlights): decode_top_with_span never returned the recorded
  span (wrong info-hash for every torrent); KeepAlive encoded as zero bytes; responder
  handshake re-read (inbound starvation); DHT drain(..8) panic; std-Mutex deadlock in the
  Interested handler; peer in_flight never released on Piece arrival (download stalled
  after one pipeline window); UDP reply offsets (action vs txn); session body cancelled
  its own token (status race) → restructured with helper handles returned to run_session;
  BEP 9 metadata is the bare info dict (wrapped under 4:info for persistence); tests made
  hermetic (refused DHT bootstrap; throttled seeder for deterministic mid-download pause).
- Gate: cargo fmt/clippy clean; cargo test 223 passed (was 159); vitest 68+129=197 (was
  61+116); typecheck ×4 clean; vite build green.

Stage Summary:
- The torrent engine is complete end-to-end: .torrent or magnet → swarm discovery
  (trackers + DHT) → verified per-piece download → seeding; byte-preserving resume across
  pause/crash/restart via the persisted have-map; fail-closed proxy routing with DHT/UDP
  suspension while proxied; honest surfaces everywhere (verified bytes only, classified
  errors, no silent fallbacks).
- Next: Phase 14 (browser history, bookmarks, downloads library) per docs/PHASES.md.

---
Task ID: 14
Agent: Super Z (main agent)
Task: Phase 14 — Browser history, bookmarks, downloads library ("فاز ۱۴"): verify Phases 0–13, then Plan → Implement → Test → Fix → Document → Review → Commit.

Work Log:
- Verified Phase 0–13 from git history (all delivered; Phase 13 = 8ec3284) and repaired the
  sandbox-wiped Rust toolchain again (rustup 1.99.0 + rustfmt/clippy; 7th reset).
- Plan: docs/phase-14-plan.md — history/bookmarks persist in the core DB (ground rule: the
  core owns the persistent DB; storage v8), visits recorded on settled main-frame http(s)
  navigations only, downloads library as a renderer-side pure projection over the three live
  job stores, reveal/open as a main method resolving paths ONLY from core-fetched job rows.
- Contracts v1.9.0: domain/browser-data.ts (HistoryEntry, Bookmark, WebUrl protocol pin, 9
  core methods, app.revealEntry, LibraryEntryKind), 2 append-only error codes
  (entry_path_unavailable, file_missing), fixtures historyEntry/bookmark + TS parity tests,
  version 1.8.0 → 1.9.0 both sides, npm package 1.9.0.
- dc-protocol: browser.rs wire types (nullable = always serialized rule) + 4 fixture parity
  tests; dc-storage: migration v8 (browser_history + bookmarks, indexes), history CRUD with
  write-path prune to MAX_HISTORY_ROWS=50_000, bookmark CRUD with transactional position
  assignment + 9 tests; download-core: 9 manager methods (+ensure_web_url scheme
  re-validation) + 9 server dispatch arms + 3 wire round-trip tests.
- Electron main: history-recorder.ts (pure scheme filter + per-tab 1500ms same-URL dedupe
  pinned to first admission), tab-manager onVisited on did-stop-loading + main-frame
  in-page navigations (forget on tab close), browser-data.ts thin proxy for 9 methods,
  app-reveal.ts (download/media → destinationPath; torrent → destinationDir+name;
  existsSync → file_missing; openPath error → io_error), main.ts wiring (supervisor
  constructed before browser registration for the visit-sink capture).
- Renderer: stores/browser-data.ts (history load/search/delete/clear + bookmark star
  lifecycle), app/library-projection.ts (merge + kind/status/query filters, per-kind
  titles, honest null paths, canDeleteFiles), pages/LibraryPage.tsx (Files/History/
  Bookmarks tabs: search + filters, day-grouped history with clear-all/30-days, bookmark
  rename dialog), BrowsePage address-bar star toggle, AppShell Library nav entry.
- Fixed during Test/Fix: main.ts TDZ visit-sink capture (supervisor moved up); O(n²) prune
  replaced with O(k) rowid-range delete (50k-row race test ~1.8s); Fluent optionValue; the
  wire's TorrentJob has no sourceUri (magnet label from infoHash); test arithmetic +
  rewritten mangled test file; clippy unnecessary_cast chain.
- Gate: cargo fmt/clippy clean (0 warnings); cargo test 240 passed (was 223); vitest 75 +
  170 = 245 (was 68 + 130); typecheck ×2 workspaces clean; vite build green.

Stage Summary:
- The app now remembers what the user browses and downloads: settled main-frame http(s)
  visits land in the core's bounded history table, bookmarks toggle from the address bar,
  and the Library page gives one searchable/filterable view over every artifact across
  downloads/media/torrents with safe, validated reveal/open and honest per-kind delete
  semantics. All persistence stays in the core-owned SQLite database (storage v8).
- Next: Phase 15 (scheduler jobs + automation) per docs/PHASES.md.

---
Task ID: 15
Agent: Super Z (main agent)
Task: Phase 15 — Scheduler jobs + automation ("فاز ۱۵"): verify Phases 0–14, then Plan →
Implement → Test → Fix → Document → Review → Commit.

Work Log:
- Verified Phase 0–14 from git history (all delivered; Phase 14 = d4622b2) and repaired the
  sandbox-wiped Rust toolchain again (rustup 1.99.0 + rustfmt/clippy; 8th reset).
- Plan: docs/phase-15-plan.md — scheduler jobs persist in the core DB (ground rule: the core
  owns the persistent DB; storage v9), fired by a 1 s tick inside download-core; CLOSED
  action set (download.create/startAll/pauseAll, media.download, torrent.add) dispatched
  through the same JobManager methods as IPC; wall-clock recurrence with a persisted
  wall_anchor so DST/travel changes snap future fires back to the same local time.
- Contracts v1.10.0: activated the never-consumed scheduler stub (repeat enum preserved
  verbatim), SchedulerAction + SchedulerJob v2 (always-serialized nullable outcome fields),
  6 core methods (scheduler.setClock is main→core only, like download.setPolicy),
  scheduler.updated event, SCHEDULER_PAYLOAD_SCHEMAS reusing the target methods' param
  schemas; fixture schedulerJob + parity tests; version 1.9.0 → 1.10.0 both sides.
- dc-protocol: scheduler.rs wire types + 3 fixture parity tests; dc-storage: migration v9
  (scheduler_jobs + wall_anchor + due index), SchedulerJobRow + CRUD + list_due, 5 tests.
- download-core: scheduler.rs (next_occurrence_wall pure math, epoch_to_wall/wall_to_epoch,
  SchedulerEngine with 1 s tick, in-flight FiringGuard, FireMode Scheduled/Manual,
  dispatch_action with per-kind payload structs incl. checksum normalization);
  manager.rs: scheduler_list/create/update/remove/run_now/set_clock/fire_due + tick spawn
  (events cloned before TorrentManager::new consumed it); server.rs: 6 dispatch arms +
  scheduler_job_json; 9 unit + 9 integration + 2 wire tests.
- Electron main: domains/scheduler.ts thin proxy (5 renderer-facing methods); main.ts
  pushes scheduler.setClock at core-ready and from the 10-minute policy timer.
- Renderer: stores/scheduler.ts (authoritative snapshot upserts, optimistic enable toggle,
  local-time ↔ epoch helpers), SchedulerPage.tsx (job cards with anchor/next-run/last-run
  outcome, Run now / Edit / Remove, create dialog covering all five action kinds),
  AppShell Scheduler nav (ClockRegular), main.tsx event subscription; 8 store tests +
  5 domain tests.
- Fixed during Test/Fix: 4 PRE-EXISTING contracts-test defects exposed by the version bump
  (three lexicographic `>= "1.x.0"` compares + one stale exact pin → numeric compare);
  first-draft epoch-space recurrence drifted wall time across DST → rebuilt around
  wall_anchor; test arithmetic/timing (due-window math, valid_ulid(n) ignores its argument,
  1 ms clock drift between create and assert, manual-fire contract misreads); renderer
  bridge re-validation caught non-ULID mock ids; clippy unnecessary_to_owned.
- Review-stage fix: set_clock could STEAL a pending catch-up fire (the boot-time clock
  push ran before the first post-boot tick and pushed a due repeating row into the
  future) → currently-due rows are now left for the tick to fire, regression-tested.
- Gate: scripts/verify-all.sh end-to-end "all checks passed" — cargo fmt/clippy -D
  warnings clean, cargo test 268 (was 240), vitest 84 + 182/1-skip (was 75 + 169/1-skip),
  typecheck ×2, vite build green. Commit: phase(15). Report: docs/phase-15-report.md.

Stage Summary:
- The app can now run itself on a schedule: persistent automation rows (download a URL at
  02:00 daily, pause everything Fridays, add a magnet weekly) fire inside the Rust core,
  survive restarts, catch up after downtime exactly once, keep their local time across
  DST, and record every outcome — ok or classified — on the row and through the
  scheduler.updated event. The Scheduler page manages them with honest semantics stated
  in the UI. All persistence stays in the core-owned SQLite database (storage v9).
- Next: Phase 16 (settings domain completion) per docs/PHASES.md.

---
Task ID: 16
Agent: Super Z (main agent)
Task: Phase 16 — Settings domain completion ("فاز ۱۶"): verify Phases 0–15, then Plan →
Implement → Test → Fix → Document → Review → Commit.

Work Log:
- Verified Phase 0–15 from git history (all delivered; Phase 15 = e209412) and repaired the
  sandbox-wiped Rust toolchain again (rustup 1.99.0 + rustfmt/clippy; 9th reset). Rebuilt
  @syntaxdm/contracts dist (workspace link lost with the reset).
- Plan: docs/phase-16-plan.md — scope taken from the two DOCUMENTED deferrals into this
  phase (Phase 3: directory picker; Phase 9 plan: settings-level default proxy) plus the
  domain's coherence gaps (settings liveness on core restart, dangling default after
  profile removal, restore-defaults affordance).
- Contracts v1.11.0 (additive): AppSettings.defaultProxyProfileId (Ulid.nullable().default
  (null)) + SETTINGS_DEFAULTS; app.pickDirectory main method ({} → {path: string|null});
  DownloadCreateParams.proxyProfileId doc updated (schema unchanged); appSettings fixture
  gained a valid ULID; Phase 15's exact version-pin test generalized to the numeric
  major/minor compare (same fix pattern as the four Phase 15 defects).
- Design decision (documented in plan + report): default-proxy injection is MAIN-SIDE
  (applyDefaultProxy in domains/download.ts, keyed on the ABSENCE of proxyProfileId —
  omitted vs null is distinguishable before serialization; explicit null = direct, explicit
  id = verbatim). The Rust core never learns settings: zero core changes, only the
  dc-protocol version constant. Scheduler payloads stay verbatim (Phase 15); the Scheduler
  download.create form gained an explicit, Direct-default, frozen proxy picker instead.
- Main: domains/app-dialogs.ts (new; injectable DirectoryPicker port over Electron
  dialog.showOpenDialog); domains/download.ts (create special-cased with injection +
  settingsStore param, every other method still a pure passthrough); domains/proxy.ts
  (remove clears a dangling defaultProxyProfileId + emits settings.changed; refusals never
  mutate settings); main.ts (dialogs registered; applyCoreLimits/applyCorePolicy/
  applySchedulerClock moved into the core "ready" state handler — a restarted core now gets
  the FULL settings re-applied; previously setConcurrency was never re-applied after a core
  restart and policy healed only via the 10-min timer).
- Renderer: stores/downloads.ts create is three-state (undefined = omit/app default, null =
  explicit direct, id = verbatim); SettingsPage (Browse… button + DefaultProxyField dropdown
  + Maintenance section with confirm-guarded Restore defaults writing SETTINGS_DEFAULTS);
  DownloadsPage proxy dropdown is now App default/Direct/profile; SchedulerPage frozen proxy
  picker for download.create.
- Fixed during Test/Fix: router zod defaults (overwrite: false) ride along before injection
  (test asserts the parsed shape); Electron OpenDialogOptions rejects readonly property
  tuples; test fixture job id used "U" (outside Crockford base32 — renderer result
  re-validation caught it); two test-file type errors surfaced only by the gate's tsc pass
  (vitest does not typecheck).
- Gate: scripts/verify-all.sh end-to-end "all checks passed" — cargo fmt/clippy -D warnings
  clean; cargo test 268 (unchanged, by design); vitest contracts 90 (was 84); desktop 201
  passed + 1 skipped (was 182 + 1); typecheck ×2 clean; vite build green.
  Commit: phase(16) = 4c19393. Report: docs/phase-16-report.md.

Stage Summary:
- The settings domain is complete: the user picks folders with the native OS dialog, picks
  an app-level default proxy that main applies to every new download that does not choose
  one explicitly (with fail-closed Phase 9 semantics intact), profiles can never leave a
  dangling default behind, settings survive core crashes (re-applied on every ready
  transition), and the page offers a confirm-guarded reset. Contracts 1.11.0; storage
  stays v9; the core remains settings-free.
- Next: Phase 17 (notifications, toasts, tray integration) per docs/PHASES.md.

---
Task ID: 17
Agent: Super Z (main agent)
Task: Phase 17 — Notifications, toasts, tray integration ("فاز ۱۷"): verify Phases 0–16,
then Plan → Implement → Test → Fix → Document → Review → Commit.

Work Log:
- Verified Phase 0–16 from git history (all delivered; Phase 16 = 4c19393) and repaired
  the sandbox-wiped Rust toolchain again (rustup 1.99.0 + rustfmt/clippy; 10th reset).
- Ground truth established before design: the core emits `*.updated` only on real
  transitions (never for restored rows at boot — verified in engine.rs / manager.rs /
  media_job.rs / torrent_manager.rs), and a torrent finishes into `seeding`
  (finalize_completion) while `completed` appears only on removal.
- Plan: docs/phase-17-plan.md — three surfaces (OS notifications, in-app toasts, tray)
  over one event source; canceled never notifies; close-to-tray effective only while a
  live tray icon exists.
- Contracts v1.12.0 (additive): AppSettings.notifyOnComplete/notifyOnFailure/closeToTray
  (defaults true) + SETTINGS_DEFAULTS + fixture + version ≥1.12 numeric-pin test; NEW
  src/domain/transitions.ts — JobEndTracker / jobEndKind / jobEndLabel / coreStateToast
  as the SINGLE shared classifier (implementation refinement over the plan's "duplicate
  honestly" sketch; documented in plan + report) with 9 contracts tests pinning the
  transition matrix (once-only ends, paused/resume cycles, torrent seeding-vs-completed,
  boot/removal silence, per-domain independence, core-state mapping).
- Main: domains/notify.ts (OsNotificationPort + registerNotifyEngine over ONE
  router.onEvent listener; live settings gates; click → restore/show/focus window);
  domains/tray.ts (TrayPort + TrayController with 1s-throttled menu/tooltip pushes,
  buildTrayMenuModel with disabled count line and count-gated Start/Pause all,
  countsFromStatuses, shouldHideOnClose); main.ts (setAppUserModelId com.syntaxdm.desktop,
  notify engine wiring, guarded Tray creation via nativeImage.isEmpty + try/catch,
  shell close handler, tray-count mirror seeded from download.list on every core ready
  transition, before-quit flips quitting + destroys tray, second-instance now also
  win.show()); paths.ts trayIcon resolution (dev resources/icons vs packaged resourcesPath).
- Tray icon: real 256×256 PNG asset generated once by scripts/gen-tray-icon.py (rounded
  #202020 tile + accent-blue download arrow, committed as resources/icons/syntaxdm-tray.png).
- Renderer: app/toasts.ts (pub/sub bus with a 5-slot concurrency budget — non-error
  toasts dropped over cap, errors always pass; slots release on the 6s/10s intent
  timeouts; subscribeStatusToasts wires download/media/torrent updated + core.state),
  app/ToastHost.tsx (Fluent v9 Toaster bottom-end, intent icons, theme/RTL aware; React
  19 useId() is prefix-less — toaster id built around it), AppShell mounts ToastHost,
  main.tsx calls subscribeStatusToasts, SettingsPage gains the "Notifications & tray"
  section (three switches + honest close-to-tray hint).
- Fixed during Test/Fix: router.emit drops invalid payloads (inlined CJS-safe job
  fixtures per the main-tests convention instead of import.meta reads); the gates test
  used two different ULIDs for one lifecycle; torrent test sequenced an unrealistic
  mid-stream `completed`; two fake-timer throttle expectations corrected to the real
  batching behavior; vi.fn generic vs CoreSupervisor["request"] and
  noUncheckedIndexedAccess errors surfaced only by the gate's tsc pass (vitest does not
  typecheck); React 19 useId() arity + ToastDispatchOptions.toasterId removal.
- Gate: scripts/verify-all.sh end-to-end "all checks passed" — typecheck ×2 clean; cargo
  fmt/clippy -D warnings clean; cargo test 268 (unchanged, by design — zero core surface
  beyond the version constant); contracts vitest 102 (was 90); desktop vitest 223 + 1
  skip (was 201 + 1); renderer build green.

Stage Summary:
- The app now talks to the user on all three surfaces: finished/failed downloads, media
  jobs and torrents raise native Windows notifications (click focuses the window,
  settings-gated, canceled never notified, torrents fire on seeding), the same events
  surface as Fluent toasts in-app with engine interruptions (restarting/unavailable)
  mapped once, and the tray keeps a live count with Start/Pause all plus close-to-tray
  that only engages while a real tray icon exists. All transition semantics live in one
  tested classifier in contracts v1.12.0; storage stays v9; the core stays settings-free.
- Next: Phase 18 (auto-update channel) per docs/PHASES.md.

---
Task ID: 18
Agent: Super Z (main agent)
Task: Phase 18 — Auto-update channel ("فاز ۱۸"): verify Phases 0–17, then
Plan → Implement → Test → Fix → Document → Review → Commit.

Work Log:
- Verified Phase 0–17 from git history (all delivered; Phase 17 = 5639945); repaired the
  sandbox-wiped Rust toolchain again (rustup 1.99.0 + rustfmt/clippy; 11th reset) before
  the gates ran.
- Ground truth: electron-updater 6.8.10 is the latest stable (npm dist-tag v26, pairs with
  the electron-builder 26 line Phase 19 will use); its 6.x event semantics and
  quitAndInstall behavior drove the design. Pinned exact via --save-exact.
- Plan: docs/phase-18-plan.md — electron-updater as TRANSPORT, our controller as POLICY;
  consent-gated end to end (check never downloads, download never installs); fail-closed
  feed resolution; install teardown-before-spawn ordering pinned by test.
- Contracts v1.13.0 (additive): domain/update.ts (UpdateStatus ×9, UpdateUnavailableReason,
  UpdateProgress, UpdateState), settings.updateAutoCheck (default true), 5 append-only
  error codes (update_feed_invalid/check_failed/download_failed/install_failed/
  not_downloaded), update.getState/check/download/install (main), update.state event,
  updateState fixture + appSettings extension; dc-protocol mirror 1.13.0 (zero Rust surface
  otherwise — cargo stays 268).
- Main: domains/updates.ts (resolveUpdateFeed fail-closed matrix + UpdateController state
  machine + 500ms progress throttle + notes sanitization + registerUpdateDomain);
  domains/updates-adapter.ts (electron-updater glue: autoDownload=false,
  autoInstallOnAppQuit=true, allowDowngrade=false, disableWebInstaller=true; env feed via
  setFeedURL, packaged app-update.yml implicit; no-feed port throws classified SyntaxDmError);
  main.ts wiring (controller after tray, emit via router, auto-checks 2min+12h,
  stopAutoChecks on before-quit, install teardown: quitting flag + tray destroy +
  supervisor.stop BEFORE port.install).
- Renderer: stores/updates.ts (dumb mirror), main.tsx subscribeUpdateState, SettingsPage
  "Updates" section (version/status/progress/release notes/error bar + Check now /
  Download update / Restart to update + auto-check switch + honest consent copy).
- Fixed during Test/Fix: TS2783 literal-then-spread in snapshot() (initialState now builds
  full snapshots; patch merge is total); missing status in onProgress setState; junk type
  parameter in test harness; auto-check interval test needed a round-closing
  onNotAvailable (the in-flight guard correctly skipped round 2 from a stuck `checking`);
  review-stage hardening: check/download now reject while `installing` (no lifecycle churn
  mid-teardown) with a pinning test.
- Gate: scripts/verify-all.sh end-to-end "all checks passed" — typecheck ×2 clean; cargo
  fmt/clippy -D warnings clean; cargo test 268 (unchanged, by design); contracts vitest
  109 (was 102); desktop vitest 260 + 1 skip (was 223 + 1); vite build green.

Stage Summary:
- The auto-update channel is complete and honest: feed resolution is fail-closed
  (env https > packaged app-update.yml > classified unavailable), the lifecycle is
  consent-gated at three points, stale checks can't clobber a downloaded update, the
  install path reuses the real quit teardown before spawning the installer (closing the
  close-to-tray trap), dev builds never self-update, and the Settings surface claims
  exactly what is verified (sha512 integrity; authenticity = signing in Phase 19+).
  Contracts 1.13.0; storage stays v9; the core stays settings-free and update-free.
- Next: Phase 19 (packaging — electron-builder NSIS installer, user-side build) per
  docs/PHASES.md.

---
Task ID: GH-1
Agent: main
Task: Publish the repository to GitHub as "Syntax Download Manager" (public, licensed, documented)

Work Log:
- Verified Phase 0-18 state directly from the repository (28 phase commits, verify-all green
  at Phase 18) rather than from continuation summaries.
- Repo hygiene: untracked the sandbox AI-skills tree (1,076 files), the deliverables staging
  dir, and the sandbox .env; .gitignore now covers all three permanently.
- Product rename UniDM -> Syntax Download Manager across the whole tree: @syntaxdm/* package
  scope, SyntaxDmError/SyntaxDmBridge types, SYNTAXDM_* env vars, the yt-dlp
  --progress-template sentinel (emitter + parser renamed in lockstep), .syntaxdm-media scratch
  dir, tray icon asset (git mv), AppUserModelID, UI strings, docs, worklog.
- Rebuilt the gate from a clean sandbox (Rust toolchain reinstalled): npm install, contracts
  build, npm run typecheck, contracts + desktop vitest, full production build, cargo test.
- Wrote LICENSE (MIT grant + attribution requirement + project-name reservation) and a
  complete English README (features, architecture, layout, dev/verify/run instructions,
  roadmap, security stance, license summary).
- Committed as three logical commits (hygiene / rename / docs) authored as SyntaxCove.
- Created the public GitHub repo SyntaxCove/SyntaxDownloadManager via API, pushed the full
  commit history, set description/topics, tagged v0.5.0, published a release with English
  notes (source release; installer/portable arrive with the Phase 19 packaging milestone).
- Security: the provided PAT is used only from the local credential store outside the repo;
  never committed; rotation recommended since it was shared in chat.

Stage Summary:
- github.com/SyntaxCove/SyntaxDownloadManager is live: 31 commits, Phases 0-18, public,
  licensed, fully documented. Going forward every phase lands on GitHub after its gate.

---
Task ID: 19
Agent: main
Task: Phase 19 — Packaging (electron-builder NSIS installer + portable zip)

Work Log:
- Plan (docs/phase-19-plan.md): pinned electron-builder 26.15.3 to pair with the Phase 18
  electron-updater 6.8.10; packaged layout derived from the code's pre-existing contract
  (appRoot = process.resourcesPath) rather than changing main-process code.
- Implemented electron-builder.json (NSIS assisted per-user + portable zip + github
  publish feed for app-update.yml), scripts/gen-app-icon.py (hand-packed multi-size ICO:
  BMP 16-128 + PNG 256; PIL cannot mix bitmap formats), scripts/build-windows.ps1
  (canonical user-side one-shot), package.json dep split (react/zustand -> devDeps;
  asar carries true runtime deps only), version 0.5.0 -> 0.6.0.
- New drift-guard test package-layout.test.ts (10 tests) locking electron-builder.json to
  the code contract: appId <=> AppUserModelID, every extraResources path <=> paths.ts /
  resolveCoreBinaryPath, asar main entry, per-user install, deleteAppDataOnUninstall=false,
  publish feed, artifact names.
- Sandbox cross-build validation: llvm-mingw 20261006 toolchain (no root available);
  rustc windows-gnu needs -lgcc/-lgcc_eh which llvm-mingw does not ship -> compatibility
  symlinks to libclang_rt.builtins + llvm-mingw libunwind.a; download-core.exe built
  (PE32+ x86-64 release). electron-builder zip target completed and inventoried
  programmatically (asar: main entry + contracts + zod + electron-updater; resources:
  dist/renderer, dist/preload, toolchains.json, tray icon, core exe, app-update.yml).
- Discovery: electron-builder 26 removed the root "zip" config key (schema); portable zip
  artifact name moved to root artifactName with nsis.artifactName override. Discovered by
  schema validation failure, fixed, and asserted in the drift-guard test.
- Discovery: NSIS on Linux runs makensis under wine; sandbox kernel policy kills wine
  (SIGSYS at wineboot). NSIS validated up to that boundary; the installer is built
  user-side by scripts/build-windows.ps1. The partial 276 KB NSIS output was deleted so
  no broken artifact ships.
- Gate: typecheck clean; vitest 109 contracts + 271 passed/1 skipped desktop;
  vite build clean; cargo fmt clean (re-wrapped one renamed fixture line), clippy clean,
  268 cargo tests passed.

Stage Summary:
- Phase 19 delivered: real Windows portable zip artifact produced and verified; NSIS
  installer path fully configured, drift-guarded, and scripted for the user's Windows
  machine; honest limitations recorded (unsigned build; cross-built core binary note).

---
Task ID: 20
Agent: main
Task: Phase 20 — Diagnostics (structured logs, log export, health report)

Work Log:
- Plan (docs/phases/phase-20-plan.md): scope from docs/PHASES.md; design decisions —
  JSONL logger with ring+file sinks and write-time credential scrubbing, core tracing
  switched to JSON, contract v1.14.0 additive, export zip via yazl (promoted to runtime
  dep), health report assembled main-side from independently-degrading ingredients.
- Found and fixed a real reliability bug: the supervisor never consumed the core's stderr
  pipe (a chatty core could fill the 64 KiB OS buffer and deadlock on write). stderr is
  now consumed from spawn to exit flush through StderrLineSplitter → parseCoreStderrLine.
- Contracts v1.14.0: domain/diagnostics.ts (LogRecord, CoreHealthSnapshot, DiagCore,
  DiagToolkitStatus, HealthReport…), 3 main-served + 1 core-served methods, settings
  verboseLogging (default false), fixture diagnosticsCoreHealth, version bumps
  (contracts 1.14.0, app 0.7.0, Rust workspace 0.7.0).
- Rust: tracing-subscriber json feature; dc-protocol diagnostics module; dc-storage
  quick_check/db_page_stats/count_jobs_by_status/health_counts; JobManager::health_snapshot
  (read-only) + server dispatch arm; JSON tracing subscriber in main.rs.
- Main: JsonlLogger (ring 2000, daily files main-YYYY-MM-DD.jsonl, 5 MiB day-cap rotation
  with exact-fit file selection, 7-day retention, scrubbing, I/O-failure survival,
  unhandledRejection/child-process-gone hooks, uncaughtException deliberately untouched);
  supervisor stderr option + restarts/lastExit/pid/readyUptime getters + verboseCoreLogging
  env; domains/diagnostics.ts (assembly with contract-validated core snapshot, zip export
  with directory validation); window.ts console-error + render-gone forwarding; full
  main.ts wiring (logger first, ipc/supervisor/tray logs routed through it, verbose live
  for main logger).
- Renderer: diagnostics store (zustand), DiagnosticsPage (app/core/toolkit-updater cards,
  quick-check + degraded badges, 200-line tail with level filter, 10 s bounded auto-
  refresh, export flow via app.pickDirectory, verbose switch), AppShell nav entry.
- Environment: Rust toolchain reinstalled (sandbox reset); bun.lock regenerated for the
  yazl dependency move; version bumps carried into all manifests.
- Gate: typecheck clean; vitest 112 contracts + 296 desktop (1 pre-existing skip); vite
  build clean; cargo fmt/clippy clean (rustfmt/clippy components reinstalled); 270 cargo
  tests green. 24 new tests (logger, stderr parser/splitter, supervisor stderr+lifecycle,
  diagnostics assembly/export incl. zip round-trip via yauzl).

Stage Summary:
- Phase 20 delivered: the app now has persistent, scrubbed, rotating structured logs
  across main/core/renderer surfaces, a dead-lock class removed (stderr consumption),
  a health report with a SQLite quick check on the job database, in-app log tail, and a
  consent-gated diagnostics zip export. Docs updated (README, PHASES, phase-20.md).
  Next: phase 21 — accessibility + i18n (fa/en).

---
Task ID: 21
Agent: main
Task: Phase 21 — Accessibility + i18n (fa / en)

Work Log:
- Plan (docs/phases/phase-21-plan.md): survey found AppLanguage already in settings
  (contract untouched at v1.14.0), ThemeProvider dir/lang groundwork from Phase 3, and
  real a11y bugs (mouse-only Browse tab strip, mouse-only Media format rows, Library
  icon buttons with title-only naming, main-side OS-notification English constants).
- Engine: i18n/translate.ts (interpolate with loud-missing placeholders, pluralKey
  .one/.other, createT with lang/dir/locale), i18n/format.ts (Intl-based, fa-IR →
  Persian digits + Jalali calendar; formatBytes/formatEta moved here from
  DownloadsPage; percent/bitrate/duration/number/date helpers), i18n/context.tsx
  (useI18n provider + module-level currentT() for non-React toast localization +
  documentElement lang/dir sync). Zero new npm dependencies.
- Dictionaries: 10 section files (common/browse/downloads/media/torrents/scheduler/
  proxy/library/settings/diagnostics), en+fa co-located per file; en.ts `as const`
  defines TKey; fa.ts is Record<TKey,string> (compile-enforced completeness); 474 keys
  per language. Language switch applies live (no restart).
- Pages: all nine pages + AppShell + ToastHost + ThemeProvider rewritten onto t();
  SettingsPage language radios now switch the whole UI; UpdatesSection status line and
  MediaToolkit badges localized; tool-label fallback never throws on future ids.
- RTL: FluentProvider gets dir; shell chrome → logical properties (paddingInlineStart,
  marginInlineStart auto); Browse Back/Forward + Diagnostics export icons swap to RTL
  variants; tab-strip arrow navigation follows visual direction.
- a11y: skip-to-content link → focusable main landmark; Browse tabs focusable +
  Enter/Space + roving arrows; Media tables valid ARIA (columnheader/cell) with
  keyboard-selectable rows; aria-labels for all icon-only buttons; aria-labelledby
  field wiring; progress-bar labels; h1/h2 heading semantics; decorative icons
  aria-hidden; log tail keeps deliberate aria-live="off".
- Main side: main/i18n.ts notification tables; describeTransition(+lang="en") keeps
  English default (existing callers/tests stable); notify engine passes live
  settings.language; coreStateToast decision stays in contracts — renderer maps copy
  by known state only.
- Tests: new i18n.test.ts (dictionary parity, empty-value guard, placeholder parity,
  plural-pair completeness, interpolation semantics, pluralKey, dir/locale, unknown-
  key throw, en-US + fa-IR formatting ladders incl. Persian digits ۱٬۰۲۴/۱٫۵ KiB/۴۲٪
  and Jalali ۱۴۰۵; local-noon epochs for tz-independence) + notify fa titles.
  ICU verified in-sandbox (fa-IR → ۲۵ مهر ۱۴۰۵ for 2026-10-17).
- Gates: typecheck (contracts+main+renderer) clean; vitest 112 contracts + 314
  desktop (1 pre-existing skip); vite build + full desktop build clean; cargo
  fmt/clippy clean, 270 cargo tests green (no Rust changes — gate only). Version
  0.7.0 → 0.8.0 (contracts untouched).
- Docs: phase-21-plan.md + phase-21.md reports; PHASES.md row 21 delivered; README
  status line + roadmap updated to 0–21 with next phase 22.

Stage Summary:
- Phase 21 delivered: the product UI is fully bilingual (English / Persian with RTL,
  Persian digits and Jalali dates), switches live from Settings, ships a survey-driven
  accessibility pass (keyboard-operable tabs/tables, skip link, complete ARIA naming),
  and localizes both in-app toasts and OS notifications. 474-key dictionaries are
  compile-checked for fa/en parity. Honest boundaries documented (error codes, log
  data, boot splash stay English; no binaries → source release only).

---
Task ID: 22
Agent: main
Task: Phase 22 — Performance budgets (startup, memory, UI latency) ("فاز ۲۲")

Work Log:
- Sandbox reset recovery first (12th): rustup stable/minimal + rustfmt/clippy reinstalled;
  baseline re-verified green (typecheck, 112 contracts + 314 desktop vitest, 270 cargo,
  vite build) before planning. Git credentials wiped by the reset — push handled at commit
  time (see below).
- Ground truth measured with a calibration probe (scripts/measure-core-perf.sh, kept as a
  repo tool): core spawn→ready 38–42 ms (debug), RSS after ready ~17 MB, JSONL echo
  round-trip 82–91 µs, renderer bundle 1,075,944 B single JS chunk.
- Plan: docs/phases/phase-22-plan.md — budgets as JSON source of truth + three enforcement
  surfaces + honest boundary: GUI wall-clock is instrumented (not sandbox-enforceable —
  no Electron binary here) and reported on real Windows runs.
- Budgets: scripts/perf-budgets.json (core cold start 2 s / RSS 64 MiB / echo 2 ms;
  renderer total JS 1.2 MB / largest chunk 1.2 MB / CSS 150 kB; TS dispatch 1 s per 2000,
  store hot path 1 s, queue sort 500 ms) — every entry carries its measured baseline and a
  budget≥measured integrity test.
- Contracts v1.15.0 additive: domain/perf.ts (BootPhase closed enum ×5, BootPhaseTiming,
  BootTimingReport with nullable core-derived totals, IpcCounters, PerformanceSnapshot,
  perf.getSnapshot main-served) + performanceSnapshot fixture + version pin ≥1.15 +
  dc-protocol constant mirror 1.15.0 (zero other Rust surface, main-served precedent).
- Main: perf/boot-clock.ts (injected-clock BootClock, 5 marks, duplicate/unknown guards,
  skew clamping; main.ts marks at pre-existing lifecycle points — zero behavior change;
  boot report logged ONCE per session via JsonlLogger component "perf"); ipc/router.ts
  monotonic counters (requestsServed/eventsEmitted/invalidDropped — integer increments
  only, no per-request timing); core-supervisor.ts sampleCoreRssBytes (Linux /proc VmRSS,
  null off-Linux/dead pid, never throws); domains/perf.ts assembling the snapshot from
  independently-degrading ingredients.
- Renderer: diagnostics store loadPerf + DiagnosticsPage Performance card (boot ladder,
  cold start, both RSS figures, IPC counters) on the existing 10 s bounded auto-refresh;
  16 new i18n keys per language (en/fa parity compile-enforced).
- Gates wired: scripts/check-budgets.mjs into verify-all.sh after the renderer build
  (bundle breach fails the gate); core/crates/download-core/tests/perf.rs (3 tests over
  the real spawned binary: cold-start, RSS cfg(unix), echo average); renderer
  __tests__/perf.test.ts (dispatch throughput, store hot path, queue sort — observed
  values printed and recorded in budgets.json: 7.2 ms / 41.5 ms / 6.0 ms);
  main __tests__/perf.test.ts (11 tests: boot clock, counters, RSS sampling incl. self-pid
  /proc path, budgets integrity).
- Fix during Test/Fix: diagnostics health-report test pinned contract "1.14.0" → now
  asserts CONTRACT_VERSION (bump-resilient); import.meta banned in CJS main tests →
  cwd-walk file resolution (Phase 19 drift-guard strategy); noUncheckedIndexedAccess in
  the hot-path test; BootClock type-only/value import split.
- Gate: scripts/verify-all.sh end-to-end "all checks passed" — typecheck clean; vitest
  118 contracts (+6) + 328 desktop (+14); budget gate ok (1,079,543 / 1,200,000 B, +3.6 kB
  from this phase's card); cargo fmt/clippy clean, 273 tests (+3 perf).

Stage Summary:
- Phase 22 delivered: performance is now numbers with consequences — a single JSON budget
  table enforced by a build gate, 3 real-binary Rust budget tests, 3 TS latency gates,
  BootClock instrumentation that reports true startup numbers on every Windows run,
  monotonic IPC counters, core RSS sampling, and a localized Diagnostics Performance card.
  Contracts 1.15.0; app 0.9.0; workspace 0.9.0. Next: phase 23 — security audit (IPC
  surface, CSP, permission policy review) per docs/PHASES.md.
