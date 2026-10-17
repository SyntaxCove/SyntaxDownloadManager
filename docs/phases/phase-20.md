# Phase 20 — Diagnostics: structured logs, log export, health report

Status: **delivered (2026-10-17)** · Contract v1.13.0 → **v1.14.0** (additive) · App 0.6.0 → **0.7.0**
Plan: [`phase-20-plan.md`](phase-20-plan.md)

## What shipped

### 1. Structured logs (`{ ts, level, component, msg, data? }`)

- **`JsonlLogger`** (main process, `apps/desktop/src/main/logging/logger.ts`):
  - two sinks: a bounded in-memory ring (2 000 records → `diagnostics.getRecentLogs` /
    Diagnostics page tail) and append-only JSONL files `userData/logs/main-YYYY-MM-DD.jsonl`;
  - daily rotation + per-day size cap (5 MiB, `.1`/`.2`… suffixes, chosen file never grows
    past the cap) + 7-day retention pruning (by file-name day) at startup and each rotation;
  - credential scrubbing on **every** sink before anything is stored: `scheme://user:pass@`
    URLs, secret-looking query values (`token|key|secret|password|api_key|signature…`),
    and `Authorization: Bearer/Basic` headers; structured `data` is scrubbed recursively
    (depth ≤ 4, 50 entries/level, Errors reduced to `{name, message}`);
  - crash semantics preserved deliberately: `uncaughtException` is **not** subscribed (a
    listener would suppress Electron's default crash dialog); `unhandledRejection`,
    `child-process-gone` and renderer surfaces are logged instead;
  - I/O failures degrade to a one-time `console.error` — logging can never take the app down.
- **Core logs went JSON**: `tracing_subscriber` gained the `json` feature; `download-core`
  now emits one JSON object per stderr line. The supervisor consumes stderr through a
  `StderrLineSplitter` → `parseCoreStderrLine`: tracing records become structured records
  (`component: core:<target>`); anything non-JSON (panics, `eprintln!`) is captured raw as
  `error` under `core-raw` — a crash can no longer vanish from the logs.
- **Bug fixed in passing**: the supervisor previously created the core's stderr pipe but
  never consumed it — a chatty core could fill the 64 KiB OS pipe buffer and deadlock on
  write. The consumer now always exists, from spawn to exit flush.
- **Renderer surface**: shell-window console errors (level ≥ error) and
  `render-process-gone` events are forwarded to the logger (`window.ts`).
- **Verbosity control**: additive setting `verboseLogging` (default `false`; debug records
  off). Live for the main logger; the core is spawned with `RUST_LOG=debug` on the next
  (re)launch — documented honest limitation (no live tracing reload).

### 2. Health report (`diagnostics.getHealthReport` → `HealthReport`)

Assembled main-side from independent, degrading ingredients — the report never throws:

- **app**: version, Electron version, platform/arch, pid, uptime, RSS (getter-based, live);
- **versions**: mirrored contract/protocol versions;
- **settings**: the full sanitized `AppSettings` (proxy secrets are keychain-bound, never here);
- **core**: supervision facts (state, restarts, consecutive failures, last exit, pid,
  ready-uptime — new `CoreSupervisor` getters) + the core-reported
  **`diagnostics.health`** snapshot: `PRAGMA quick_check` on the job database (the
  product's most critical asset), page-count/page-size, download jobs grouped by status
  (SQL aggregate), row counts for media/torrents/history/bookmarks/scheduler, core uptime,
  mirrored versions. Unreachable core ⇒ `snapshot: null` (classified), contract-validated
  on arrival (a malformed snapshot degrades rather than propagates);
- **toolkit** (Phase 10 shape; `manifestVersion: null` is legal here via `DiagToolkitStatus`)
  and **updater** (Phase 18 `UpdateState`) — both reused verbatim, sanitized;
- **logs**: file listing (names/bytes/mtime) + total bytes.

### 3. Log export (`diagnostics.exportLogs { directory }` → `{ path, bytes }`)

- Writes `syntaxdm-diagnostics-<UTC-timestamp>.zip` into the folder the user picked via the
  existing `app.pickDirectory` consent flow; contains **all current log files** plus a
  fresh `health-report.json` (assembled at export time).
- Zip built with **`yazl`, promoted devDependency → dependency** (Phase 19 asar policy:
  true runtime deps only). Directory is stat-validated first (no partial writes);
  vanished-between-listing-and-stat log files are simply skipped.
- Security posture unchanged: `app.revealEntry` still derives paths exclusively from job
  rows; the only absolute path crossing to the renderer is the export destination the user
  chose themselves.

### 4. Diagnostics page (renderer)

New `DiagnosticsPage` (nav entry "Diagnostics", `PulseRegular` icon) + `diagnostics` store:
application / download-core (with quick-check badge + degraded badges) / toolkit & updates
cards, log-file summary, a 200-record log tail with level filter (newest last, monospace),
manual refresh + bounded 10 s auto-refresh while mounted, the export button (toast on
success/failure), and the verbose-logging switch. English-only strings — i18n is Phase 21.

## Contract (v1.14.0, additive)

- `domain/diagnostics.ts`: `LogLevel`, `LogRecord`, `CoreHealthCounts`, `CoreHealthSnapshot`,
  `DiagCoreSupervision`, `DiagCore`, `LogFileInfo`, `DiagLogs`, `DiagToolkitStatus`,
  `HealthReport`; methods `diagnostics.getHealthReport` / `getRecentLogs` / `exportLogs`
  (main-served) and `diagnostics.health` (core-served). No new events (polling a bounded
  tail beats a per-line IPC firehose — deliberate).
- Settings: `verboseLogging: boolean = false`.
- Cross-language fixture `diagnosticsCoreHealth` (domain.json) round-trips byte-for-byte
  through `dc-protocol::CoreHealthSnapshot` (BTreeMap ⇒ deterministic `jobsByStatus` order).

## Rust changes

- workspace: `tracing-subscriber` `json` feature; version 0.6.0 → 0.7.0.
- `dc-protocol`: `diagnostics` module (`CoreHealthCounts`, `CoreHealthSnapshot`), version mirror 1.14.0.
- `dc-storage`: `quick_check()` (bounded first row of `PRAGMA quick_check` — chosen over
  `integrity_check` for speed while still catching job-byte-threatening corruption),
  `db_page_stats()`, `count_jobs_by_status()` (GROUP BY, deterministic order),
  `health_counts()` (five indexed COUNTs).
- `download-core`: `JobManager::health_snapshot()` (read-only queries only — a diagnostics
  call never mutates job state) + `started_at`; `diagnostics.health` dispatch arm;
  JSON tracing subscriber in `main.rs`.

## Verification (all green)

- `npm run typecheck` (contracts + desktop main/renderer) ✅
- vitest: **112 contracts** + **296 desktop passed, 1 skipped (pre-existing)** ✅
- `vite build` (renderer) + full desktop build ✅
- `cargo fmt --check`, `clippy -D warnings`, **270 cargo tests** ✅ (was 268)

New tests (24): logger (levels, ring bounds, redaction incl. bearer/proxy-URL/query,
message caps, daily files, size-cap rotation with exact-fit selection, retention pruning,
I/O-failure survival), stderr parser + line splitter (JSON shapes, TRACE mapping,
panic/raw classification, chunk boundaries), supervisor stderr wiring (delivery across
chunks, exit flush, log-sink fallback, `RUST_LOG=debug` env), supervisor lifecycle facts
(restarts/lastExit/pid/ready-uptime incl. graceful-stop clearing), diagnostics domain
(contract-valid assembly, core-unreachable degradation, malformed-snapshot rejection,
zip export round-trip read back via `yauzl`, invalid directory rejection).

## Honest limitations

- Windows GUI behavior (toast paths, tray, installer) is validated user-side per the
  established sandbox/device split; the sandbox validated everything headless-testable.
- `verboseLogging` reaches the core at its next spawn (no live `EnvFilter` reload).
- Log export is unencrypted by design: it contains no secrets (scrubbing is tested), but
  users should still share exports only with parties they trust.
- Sandbox note: NSIS remains user-side (`scripts/build-windows.ps1`); this phase ships no
  binaries and therefore no binary release.
