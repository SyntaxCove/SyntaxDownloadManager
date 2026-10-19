# Phase 25 — E2E suites (headless renderer + main + core integration)

Status: delivered 2026-10-19 · Contract **unchanged at v1.15.0** · App 0.11.0 → 0.12.0

## What was built

Until this phase the three surfaces were tested separately: vitest mocked the supervisor
and Electron, and cargo drove the core's `serve()` over in-memory duplex pairs. Nothing
proved that the real Electron-main composition, the real Rust binary, and the real
renderer API layer agree on the wire for complete user stories. Phase 25 closes that with
**20 E2E tests in 4 suites** (`apps/desktop/src/e2e/`) that run headlessly in the Linux
sandbox and in CI, with exactly one stub boundary class: the Electron-only ports.

### The shipped composition is now shared, not copied

`src/main/composition.ts` extracts the thirteen domain registrations out of `main.ts` into
`registerAppDomains(deps)` (settings → download → media → torrent → scheduler →
browser-data → app-reveal → proxy → toolkit → dialogs → notify → diagnostics → perf, in
the shipped order) plus `pushCoreRuntimeState(deps)` — the ready-transition re-push of
runtime proxies, toolkit paths, concurrency, policy and scheduler clock. `main.ts` calls
both; the E2E harness calls the **same functions**, so the suites exercise the shipped
wiring and cannot drift from it. Moving the settings registration next to the others also
removes a microscopic pre-window race (no window exists before the block runs).

### Harness posture (honest about the sandbox)

The sandbox has no Electron binary, so a real Electron boot is impossible here. Everything
that CAN be real is real:

| Boundary | E2E posture |
|---|---|
| Rust core process | **REAL** — the debug `download-core` binary built by `verify-all.sh` before the TS step; supervised through the production `CoreSupervisor` (stdio JSONL, stderr drain). |
| HTTP servers | **REAL** — `node:http` fixtures with Content-Length / ETag / Last-Modified / Content-Disposition / Range-206 / slow-stream / 404 behaviors, every request recorded. |
| SQLite persistence | **REAL** — per-suite temp database; restart drills reopen it. |
| IpcRouter + zod | **REAL** — production validation on both envelopes and handler schemas. |
| Main-process domains | **REAL** — `registerAppDomains`, the shipped composition. |
| Renderer bridge + stores | **REAL** — production `bridge.ts` (`rpc`, `onEvent`) and the real Zustand stores wired exactly as `main.tsx` does (`subscribeDownloadEvents`, `subscribeSettingsChanged`); `window.syntaxdm` is a preload-faithful mirror (`router.handleRequest` + `EventEnvelope` filtering). |
| Electron ports (Notification, shell, dialog, safeStorage, updater, windows/tabs/tray) | **STUBBED at the injectable port interfaces only**; tabs/tray stay out of headless scope (unit-tested; need a real Electron binary). |

### The four suites

1. **boot.e2e.test.ts** — spawn → `core.state` ready; `core.ping` over the supervisor
   returns the pinned `CONTRACT_VERSION`; the renderer can NOT reach `core.ping` directly
   (fail-closed router, Phase 23 boundary); settings round trip emits `settings.changed`;
   `diagnostics.getHealthReport` reports sqlite `quick_check: "ok"` through the real
   binary; `perf.getSnapshot` shows boot phases, /proc-sampled core RSS and monotonic IPC
   counters; typed error ladder (method_not_found / invalid_params); graceful stop leaves
   no PID and refuses further core RPC with `core_unavailable`.
2. **download-flow.e2e.test.ts** — real bytes: 256 KiB download completes with
   byte-identical file, streamed sha256 match, `checksumVerified: true`, captured
   ETag/validators, queued→completed snapshots, and an OS-notification transition recorded
   by the stub port; 1 MiB throttled download paused mid-flight (bytes frozen), resumed
   **via real HTTP Range requests** to byte-perfect completion; a 404 source lands in
   `failed` with a typed `errorCode` and the row survives (expired URL never destroys the
   job); removing a paused job deletes the `.part` sidecar from disk; and **persistence
   across core death**: a fresh supervisor + router + composition over the same database
   keeps the completed job with identical integrity facts and a byte-identical artifact.
3. **renderer-bridge.e2e.test.ts** — the production renderer code over the production
   composition: full download through typed `rpc` with result re-validation; renderer-side
   contract violations (`javascript:`, `file:`, checksum-length mismatch) rejected before
   any wire traffic; unregistered methods rejected through the raw preload surface; the
   downloads store mirrors the engine through its own actions and real progress events,
   pause/resume/remove included; the settings store round-trips with live
   `settings.changed` sync and rolls back an invalid patch.
4. **scheduler-history.e2e.test.ts** — scheduler create → `runNow` → outcome recorded
   (`lastResultCode: "ok"`, schedule untouched per contract) with `scheduler.updated`
   events; per-kind payload validation refuses mismatched payloads; history
   record/search/delete/clear and bookmark create/find/update/remove through the real
   SQLite storage; non-http(s) history rejected at the core boundary.

## Real defects found and fixed (the suites paid for themselves immediately)

- **F-1 (core, user-visible): `download.remove` ignored `deletePartialFile` — forever.**
  `RemoveParams` in the core's server declared `delete_partial_file` with
  `#[serde(default)]` but **no `#[serde(rename = "deletePartialFile")]`** — serde expected
  snake_case on the wire, never matched the contract's camelCase name, and silently
  defaulted the flag to `false` on every remove since Phase 5. The `.part` sidecar was
  never deleted. Fixed with the rename; a full audit of every multi-word field in every
  params struct found no sibling of this bug class (dc-protocol mirrors all carry
  renames). Locked by a new Rust regression test (`remove_paused_job_deletes_part_file`)
  that drives the actual `serve()` dispatch with the camelCase wire name.
- **F-2 (core, robustness): `manager.remove` unlinked the `.part` file while the engine
  task could still be exiting.** `remove()` cancelled the task but unlinked immediately —
  an in-flight writer must never outlive the unlink. `remove()` now waits (bounded 5 s)
  for the task to observe cancellation and remove its own handle before the unlink.
  Covered by the same regression test (pause → remove drill over a throttled server).
- **F-3 (renderer store): a stale async RPC response could regress the job mirror.**
  The engine-async pause resolves with a "downloading" row that can land *after* the
  newer "paused" event snapshot, clobbering it (E2E: the store never showed paused).
  `upsertJob` now ignores rows older than the mirrored one (`updatedAt` guard — events
  and rows carry the same monotonic stamp). Locked by 3 unit tests in
  `downloads-store.test.ts`.

## Build-order change

`scripts/verify-all.sh` now builds the core binary **before** the TS test step so the E2E
suites always find it (`cargo build -p download-core`); the suites `skipIf` visibly when
the binary is absent so a cargo-less machine still runs the rest of the TS gate.
`apps/desktop` gains `test:e2e` and a third typecheck project (`tsconfig.e2e.json`).

## Verification

- `scripts/verify-all.sh` end-to-end green: typecheck (contracts, desktop main/renderer/
  e2e), **118 contracts + 365 desktop (343 prior + 20 E2E + 2 net new store-guard tests) +
  280 cargo (+1 regression test)**, renderer build + Phase 22 budget gate respected,
  cargo fmt/clippy clean.
- Contract unchanged at 1.15.0; no wire changes (the F-1 fix makes the core honor the
  wire contract that existed all along).
- Honest scope note: Electron window/tab/tray/update paths remain unit-tested only; a
  real Electron runtime E2E is only possible on a machine with the Electron binary —
  the harness and composition extraction are the prepared ground for that future step.
