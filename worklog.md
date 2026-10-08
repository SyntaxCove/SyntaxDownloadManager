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
