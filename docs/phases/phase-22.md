# Phase 22 — Performance budgets (startup, memory, UI latency)

Status: **delivered (2026-10-18)** · Contract **v1.14.0 → v1.15.0 (additive)** · App 0.8.0 → **0.9.0** · Rust workspace 0.7.0 → 0.9.0
Plan: [`phase-22-plan.md`](phase-22-plan.md) · Budget source of truth: [`scripts/perf-budgets.json`](../../scripts/perf-budgets.json)

## What shipped

Performance stopped being an aspiration and became **enforced engineering facts**. Every
budget now has (a) a number in one JSON source of truth, (b) a real measurement that runs
inside the repo's verification gate, and (c) a consequence — the gate fails when the
budget is breached.

### 1. Budgets with teeth — `scripts/perf-budgets.json` + three enforcement surfaces

| Budget | Ceiling | Measured baseline (this sandbox) |
|---|---|---|
| Core cold start (spawn → `core.ready`) | 2,000 ms | 38–42 ms (debug) |
| Core RSS after ready | 64 MiB | ~17 MB |
| Core JSONL echo round-trip | 2,000 µs avg | 82–91 µs |
| Renderer bundle total JS | 1,200,000 B | 1,079,543 B (post-Phase-22 build) |
| Renderer largest chunk | 1,200,000 B | 1,079,543 B |
| Renderer CSS total | 150,000 B | 0 B (Fluent styles are runtime) |
| Validated IPC dispatch (2,000 round-trips) | 1,000 ms | 7.2 ms (3.6 µs/op) |
| Downloads-store hot path (2,000 upserts + 2,000 patches, 200 jobs) | 1,000 ms | 41.5 ms |
| Queue display ordering (100 × 500-job sorts) | 500 ms | 6.0 ms |

Enforcement surfaces:

- **`scripts/check-budgets.mjs`** — new step in `scripts/verify-all.sh` (after the renderer
  build): inventories `dist/renderer/assets` and fails the gate on any bundle breach, with
  the exact numbers printed. Bundle grew 3,600 B with this phase's diagnostics card and
  sits at 89.9 % of budget.
- **`core/crates/download-core/tests/perf.rs`** — 3 integration tests over the REAL spawned
  binary: cold-start latency, RSS after ready (`#[cfg(unix)]` — on Windows the honest
  surface is the Diagnostics page, and the wire type is null there by contract), and echo
  round-trip average. Reuses the established `spawned_binary_end_to_end` spawn pattern.
- **`src/renderer/src/__tests__/perf.test.ts`** — 3 latency gates (dispatch throughput,
  store hot path, queue sort) reading their ceilings from the same JSON, printing observed
  values so the table above is measured, not invented.

### 2. Startup instrumentation — BootClock + one-time boot report

`apps/desktop/src/main/perf/boot-clock.ts`: an injected-clock state machine marking five
phases — `main-modules-evaluated → app-ready → window-created → core-spawned → core-ready`
— with per-phase durations, `totalToCoreReadyMs`, and `coreSpawnToReadyMs`. main.ts calls
`mark()` at lifecycle points that already existed (zero behavior change, nothing reordered).
The finished report is logged ONCE per session through the JsonlLogger (`component: "perf"`),
so **real Windows devices report their true startup numbers** into the Phase 20 log
pipeline, the diagnostics tail, and every exported diagnostics zip.

### 3. Wire surface — contracts v1.15.0 (additive)

`domain/perf.ts`: `BootPhase` (closed enum of the five phases), `BootPhaseTiming`,
`BootTimingReport` (core-derived totals nullable until the first ready transition),
`IpcCounters`, `PerformanceSnapshot`, and the main-served `perf.getSnapshot` method with a
cross-checked fixture (`performanceSnapshot` in `fixtures/domain.json`). dc-protocol mirrors
the version constant (1.15.0) with zero other Rust surface — the established main-served
precedent. Fixture round-trip, closed-enum, nullable-pre-ready, and counter-bounds tests
added on the TS side (6 new contracts tests).

### 4. IPC counters — 3 integer increments on the hot path

`IpcRouter` now counts `requestsServed` (every parsed envelope, error outcomes included),
`eventsEmitted` (validated, reached listeners), and `invalidDropped` (malformed envelopes /
schema-failed events). Deliberately NO per-request timing — that would tax the boundary the
budgets protect; dispatch latency stays a build-gate concern.

### 5. Core RSS visibility

`CoreSupervisor.sampleCoreRssBytes()` reads `/proc/<pid>/status` (Linux) and returns null
off-Linux or while the core is down — never throws. `perf.getSnapshot` assembles
BootClock + counters + `process.memoryUsage().rss` + this sample; the Diagnostics page
renders a localized **Performance card** (boot ladder, cold start, both RSS figures, IPC
counters) on the existing 10 s bounded auto-refresh. en + fa dictionary parity enforced by
the Phase 21 tests (16 new keys per language, incl. the five phase labels).

## Verification (all green)

- `npm run typecheck` (contracts + desktop) ✅
- vitest: **118 contracts** (+6) · **328 desktop** (+14, incl. the 3 perf gates) ✅
- `vite build` ✅ + **budget gate** ✅ (1,079,543 / 1,200,000 B)
- `cargo fmt --check`, `clippy -D warnings` ✅ · **273 cargo tests** (+3 perf) ✅
- Full `scripts/verify-all.sh` end-to-end: "all checks passed"

## Honest limitations

- The sandbox cannot run Electron (Phase 0 policy: no binary download, no GUI), so
  app-side startup wall-clock and input-to-paint latency are **instrumented but not
  sandbox-enforced** — the BootClock report on a real Windows run is the measurement
  surface, and the Diagnostics card shows it. Enforcing those numbers here would be theater.
- The memory budget compiles to a no-op on Windows (`#[cfg(unix)]`); user-side Windows
  numbers arrive via the same Diagnostics card (`coreRssBytes` null there today — the
  wire type anticipates a future Windows sampler).
- Latency ceilings carry large safety margins by design (24–140×): they exist to catch
  pathological regressions (sync I/O on the boot path, per-request file reads, accidental
  heavyweight imports) without failing CI on scheduler noise.
- Code-splitting was deliberately not pursued: the renderer loads from `file://` in
  production — no network waterfall exists, and total bytes is the honest startup proxy
  (documented in the plan).
- This phase ships no binaries → source release only (established Phase 19 split).
