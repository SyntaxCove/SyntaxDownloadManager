# Phase 22 Plan — Performance budgets (startup, memory, UI latency)

Status: draft → delivered 2026-10-18 · Contract **v1.14.0 → v1.15.0 (additive)** · App 0.8.0 → 0.9.0

## Scope (from docs/PHASES.md)

"Performance budgets — startup, memory, UI latency." Turn performance from an aspiration
into **enforced engineering facts**: every budget has (a) a number in one source of truth,
(b) a real measurement that runs in this repo's verification gate, and (c) a consequence
(the gate fails when the budget is breached). GUI wall-clock timing on real Windows
hardware cannot be produced in this Linux sandbox (no Electron binary — Phase 0 policy);
that part ships as **instrumentation** (recorded into the Phase 20 log pipeline and shown
in Diagnostics) with documented user-side targets, and is stated honestly everywhere.

## Ground truth measured in this sandbox (2026-10-18)

| Metric | Measured (debug build) | Probe |
|---|---|---|
| `download-core` spawn → `core.ready` | 38–42 ms | `scripts/measure-core-perf.sh` (real binary) |
| `download-core` RSS after ready | ~17,000 KB | `/proc/<pid>/status` |
| JSONL echo round-trip (spawned binary, incl. write+read) | 82–91 µs/op avg | 100 × `core.ping` |
| Renderer bundle (vite build, single JS chunk) | 1,075,944 B | `dist/renderer/assets` |
| CSS assets | 0 B (Fluent styles are runtime) | same |

No startup-phase timing exists in the Electron main process today; the supervisor exposes
`readyUptimeMs` (uptime since ready) but never records spawn→ready; the IPC router counts
nothing; the downloads store hot paths (`upsertJob`/`patchProgress`, both O(n) over the
job list, plus the `compareQueueDisplay` sort) have no latency gate.

## Design

### 1. One source of truth for budgets — `scripts/perf-budgets.json`

Consumed by BOTH the build gate (Node) and vitest (TS). Fields carry `measured` (this
sandbox's baseline), `budget` (the enforced ceiling), and `note`. Calibrated budgets:

| Budget | Value | Rationale |
|---|---|---|
| `core.coldStartReadyMs` | 2,000 | 50× measured; catches pathological boot regressions (sync I/O on the startup path, accidental blocking); release builds are faster still |
| `core.rssAfterReadyKb` | 65,536 (64 MiB) | ~4× measured; catches boot-time allocation runaways |
| `core.echoAvgUs` | 2,000 µs | ~20× measured; catches accidental per-request work (double parse, sync fs) |
| `renderer.maxTotalJsBytes` | 1,200,000 | ~11.6% headroom over measured; catches new heavyweight deps / accidental double-imports |
| `renderer.maxLargestChunkBytes` | 1,200,000 | today's chunk == total; a split must not grow any single chunk past it |
| `renderer.maxTotalCssBytes` | 150,000 | 0 today; future CSS must not silently balloon |
| `ipc.dispatch2000Ms` | 1,000 | calibrated against real vitest run; 0.5 ms/op ceiling for validated dispatch |
| `ui.storeHotPathMs` | 1,000 | 2,000 `upsertJob` + 2,000 `patchProgress` over a 200-job list |
| `ui.queueSortMs` | 500 | 100 sorts of a 500-job list |

Code-splitting is deliberately **not** pursued: the renderer loads from `file://` in
production — no network waterfall exists, and total bytes is the honest startup proxy.
Documented in the phase report.

### 2. Startup instrumentation — `apps/desktop/src/main/perf/boot-clock.ts`

`BootClock` with an injected `nowMs` clock (unit-testable, no real timers): marks
`main-modules-evaluated` (module top-level — the earliest observable main-process point),
`app-ready`, `window-created`, `core-spawned`, `core-ready`; computes per-phase durations,
`totalToCoreReadyMs`, and the core `spawnToReadyMs`. main.ts calls `mark()` at the exact
existing lifecycle points (no behavior change, no reordering). On `core-ready` the full
report is logged once through the JsonlLogger (`component: "perf"`) — real Windows runs
expose their true startup numbers in the Phase 20 log pipeline and diagnostics zip.

### 3. Wire surface — contracts v1.15.0 (additive)

`packages/contracts/src/domain/perf.ts`:
- `BootPhaseTiming { phase, durationMs }` (phase = enum of the five marks),
- `BootTimingReport { phases, totalToCoreReadyMs, coreSpawnToReadyMs (nullable — null
  until the core's first ready transition), recordedAt }`,
- `IpcCounters { requestsServed, eventsEmitted, invalidDropped }` (monotonic per session),
- `PerformanceSnapshot { boot, ipc, mainRssBytes, coreRssBytes (nullable), sampledAt }`,
- method `perf.getSnapshot` (main-served), registry entry + fixture; dc-protocol mirrors
  `CONTRACT_VERSION` 1.15.0 with zero other Rust surface (established main-served-domain
  precedent from v1.13.0/v1.14.0). Numeric pin test ≥ 1.15.

### 4. Router counters — `ipc/router.ts` (3 integer increments on the hot path)

`IpcRouter` gains monotonic counters (`requestsServed` on every parsed request, regardless
of outcome; `eventsEmitted` on every accepted emit; `invalidDropped` when a request fails
envelope validation or an event payload fails schema). No per-request timing (that would
tax the hot path); dispatch latency stays a build-gate concern. Snapshot via
`router.counters()`.

### 5. Core RSS visibility — supervisor

`CoreSupervisor` gains `sampleCoreRssBytes()`: reads `/proc/<pid>/status` on Linux
(unix-gated; returns null elsewhere — Windows sampling arrives with the user-side runs,
and the field is nullable on the wire for exactly this reason). Diagnostics assembles the
snapshot: `perf.getSnapshot` merges BootClock + router counters + `process.memoryUsage().rss`
+ supervisor RSS sample (null-safe, diagnostics-style graceful degradation).

### 6. Enforced gates (the teeth)

- **`scripts/check-budgets.mjs`** — runs in `scripts/verify-all.sh` AFTER `build:desktop`:
  reads `perf-budgets.json`, inventories `dist/renderer/assets`, fails the gate on breach.
- **`core/crates/download-core/tests/perf.rs`** — new integration tests over the REAL
  spawned binary: cold-start→ready under budget; RSS-after-ready under budget (`#[cfg(unix)]`
  — compiles to a no-op on Windows, where the budget is checked user-side via Diagnostics);
  echo-latency average under budget. Reuses the `spawned_binary_end_to_end` spawn pattern.
- **`apps/desktop/src/renderer/src/__tests__/perf.test.ts`** — router dispatch throughput
  (2,000 validated dispatches), downloads-store hot path (2,000 upserts + 2,000 patches on
  a 200-job list), queue-sort ladder (100 × 500-job sorts) — all reading budgets from
  `perf-budgets.json`, all printing observed values for calibration and honest reporting.
- **Budget integrity test** — budgets.json parses, every budget ≥ its recorded measured
  value (a budget below reality would fail every run), renderer budgets re-assertable.

### 7. Diagnostics UI — Performance card

DiagnosticsPage gains a Performance card (boot phase ladder, core cold-start, main/core
RSS, IPC counters), fed by the existing 10 s bounded auto-refresh cadence; copy goes
through i18n (new `perf.*` keys in BOTH en and fa — the parity test enforces completeness).

## Test plan

1. boot-clock unit tests (injected clock: phase order, durations, null core timing before
   ready, snapshot immutability).
2. router counter tests (counts across success/parse-failure/emit-drop paths).
3. perf gates listed above; run twice in-sandbox to check stability margins.
4. contracts: schema round-trips, registry presence of `perf.getSnapshot` as main-served,
   version pin ≥ 1.15, fixture consistency (JS-side; dc-protocol constant asserted by the
   existing cross-language version check at core startup).
5. Full verify-all gate green (typecheck, vitest, vite build + budget check, cargo fmt/
   clippy/test).

## Out of scope (honest boundaries)

- Real-GUI startup/latency numbers on Windows hardware — produced by the instrumentation
  above on user runs; budgets for those are documented targets, not sandbox-enforced.
- Renderer input-to-paint profiling (requires a compositor; sandbox is headless).
- Code-splitting / lazy-loading (documented above: file:// load makes total bytes the
  meaningful metric).
- GC-behavior or long-run soak testing (the 64 MiB RSS budget bounds boot; leak detection
  beyond that needs real-device sessions).

## Verification gate

`scripts/verify-all.sh` end-to-end, now including the budget check after the renderer
build. Baseline at plan time: typecheck ✅ · vitest 112 contracts + 314 desktop (+1
pre-existing skip) ✅ · cargo 270 ✅ · vite build ✅.
