# Phase 20 — Diagnostics: structured logs, log export, health report

Status: planned (2026-10-17) · Contract v1.13.0 → v1.14.0 (additive) · App 0.6.0 → 0.7.0

## Problem

Until now, diagnostics data dies with the process: main-process `console.log`, the Rust
core's human-format tracing lines on stderr, and renderer errors are all invisible after a
crash — and worse, the supervisor creates the core's stderr pipe but never consumes it, so a
chatty core can fill the 64 KiB OS pipe buffer and deadlock on write. There is no way for a
user (or the developer of a bug report) to answer "what actually happened?"

## Scope (from docs/PHASES.md)

1. **Structured logs** — machine-readable JSONL records for main, core and renderer error
   surfaces, persisted with rotation + retention, plus a bounded in-memory ring for the UI.
2. **Log export** — one consent-gated action that bundles current logs + a health snapshot
   into a single zip the user picked a folder for (renderer never touches fs paths itself).
3. **Health report** — a sanitized, on-demand snapshot of app, core, storage, toolkit,
   updater and log state, viewable in-app and included in exports.

## Design decisions

- **Contract v1.14.0 (additive)**: new `domain/diagnostics.ts`; 3 main-served methods
  (`diagnostics.getHealthReport`, `diagnostics.getRecentLogs`, `diagnostics.exportLogs`)
  and 1 core-served method (`diagnostics.health`). No new events (the viewer polls; a
  firehose of log lines over IPC is noise, not signal).
- **Core logs go JSON**: `tracing_subscriber` gains the `json` feature; the supervisor
  parses each stderr line as JSON (non-JSON lines — panics, `eprintln!` — are recorded as
  raw `error` records). This both structures the data and fixes the unconsumed-pipe
  backpressure bug by attaching a consumer.
- **`JsonlLogger` (main process)**: record = `{ ts, level, component, msg, data? }`.
  Sinks: bounded ring buffer (recent-logs RPC) + daily files
  `userData/logs/main-YYYY-MM-DD.jsonl` (day-cap rotation, 7-day retention, prune at
  startup). Credential scrubbing (`user:pass@`, `token|key|secret|password|authorization=`
  values) happens at write time, on every sink.
  Crash semantics are preserved deliberately: `uncaughtException` is NOT hooked (a listener
  would suppress Electron's default crash dialog); `unhandledRejection`,
  `render-process-gone` and `child-process-gone` are logged.
- **Core health snapshot** (`diagnostics.health`, Rust): `PRAGMA quick_check` on the job
  database (the product's single most critical asset — engineering priority #1),
  page/page-size stats, download jobs grouped by status (SQL aggregate), row counts for
  media/torrent/history/bookmarks/scheduler, process uptime, mirrored contract versions.
- **Health report assembly (main)**: merges supervisor lifecycle state (state, restarts,
  consecutive failures, last exit, pid/uptime — new public getters), the core snapshot
  (degrades to classified `core_unavailable` nulls — never throws), existing sanitized
  toolkit status and update state, app/electron/platform facts, settings (no secrets live
  in settings; proxy secrets stay in the keychain store) and the logs directory listing.
- **Export**: `diagnostics.exportLogs { directory }` (directory comes from the existing
  `app.pickDirectory` consent flow) writes `syntaxdm-diagnostics-<ts>.zip` (log files +
  `health-report.json`) via `yazl`, promoted from devDependency to dependency (Phase 19
  asar policy: true runtime deps only). No new arbitrary-path reveal method — the security
  posture of `app.revealEntry` (job-row-derived paths only) is unchanged.
- **Verbose logging**: additive setting `verboseLogging: boolean = false` (v1.14). Raises
  the main logger to `debug` and spawns the core with `RUST_LOG=debug` (applies on next
  core spawn — documented, honest limitation; live core level reload is out of scope).
  The toggle lives on the Diagnostics page.
- **Renderer**: Diagnostics page (health cards, recent-log tail with level filter, export
  button, verbose toggle) + a `diagnostics` zustand store; AppShell gains the nav entry.
  English-only strings — i18n is Phase 21.

## Acceptance

- `verify-all` green: contracts build, typecheck, vitest (contracts + desktop), vite build,
  `cargo fmt/clippy/test`.
- New tests: logger (rotation, retention, ring bound, redaction, levels), stderr parser
  (JSON + raw fallback), supervisor stderr wiring + lifecycle getters, diagnostics domain
  (report assembly incl. core-unavailable degradation; zip export round-trip), contracts
  fixture round-trip for the core health snapshot, dc-storage `quick_check`/counts.
- The core's stderr is always consumed from the moment of spawn (deadlock class removed).
- No secrets in logs or exported artifacts; redaction is tested.
- Docs updated (PHASES.md, README, phase-20 report, worklog); GitHub commit + push; tags
  v0.6.0 (Phase 19, retroactive) and v0.7.0 (this phase) with honest source-only release
  notes (Windows installers are built user-side per the established environment split).
