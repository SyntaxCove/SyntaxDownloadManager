# Phase 29 — Performance validation: real-device budget report harness

Status: planned · Contract **v1.15.0 → v1.16.0 (additive)** · App 0.15.0 → **0.16.0**

## Problem

Phase 22 made performance *enforced* where the sandbox can measure: the build gate owns the
bundle budgets, vitest owns the TS latency gates, cargo owns the core's cold start / RSS /
echo gates, and the BootClock logs true boot numbers on real devices. What it deliberately
did NOT do was close the loop on the device: a real Windows run reports its boot ladder into
the logs, but nothing on the device **assembles measurements against the shipped budgets and
says pass or breach**. The honest numbers exist; the verdict machinery does not. This phase
ships that machinery as a user-visible, contract-typed, log-persisted harness — with zero
change to what the budgets are.

## Design

### 1. Budgets become an app-shipped asset (single source of truth preserved)

`scripts/perf-budgets.json` moves to `apps/desktop/resources/perf-budgets.json` — the
established home for side files that must reach the packaged app (same mechanism as
`resources/toolchains.json`): one copy, read by the build gate, by the vitest gates, and now
by the running app. `electron-builder.json` gains
`{ "from": "resources/perf-budgets.json", "to": "perf-budgets.json" }` in `extraResources`;
`paths.ts` gains `perfBudgets` (dev: `resources/perf-budgets.json`, packaged:
`perf-budgets.json` — the toolchains precedent). All consumers move with it:
`scripts/check-budgets.mjs`, the renderer and main vitest perf gates.

### 2. Contracts v1.16.0 (additive minor) — the verdict vocabulary

`domain/perf.ts` adds, alongside the existing measurement types:

- `BudgetId` — closed enum of the nine shipped budgets (`core.coldStartReadyMs`,
  `core.rssAfterReadyKb`, `core.echoAvgUs`, `renderer.maxTotalJsBytes`,
  `renderer.maxLargestChunkBytes`, `renderer.maxTotalCssBytes`, `ts.ipcDispatch2000Ms`,
  `ts.uiStoreHotPathMs`, `ts.uiQueueSortMs`).
- `BudgetUnit` (`ms` | `us` | `bytes` | `kb`), `BudgetVerdict` (`pass` | `breach` |
  `skipped`), `BudgetReportSource` (`packaged-app` | `dev` | `headless-test`).
- `BudgetMeasurement` — `{ id, budget, actual, unit, verdict, detail }` with an arithmetic
  honesty refine enforced by the schema itself: `skipped` ⇔ `actual === null`; `pass` ⇔
  `actual ≤ budget`; `breach` ⇔ `actual > budget`. The wire type cannot lie.
- `BudgetReportSummary` and `BudgetReport` — the report carries environment facts (app
  version, contract version, platform, OS release, source), exactly one measurement per
  `BudgetId` (refine), a summary whose parts sum to the total (refine), and an overall
  verdict (`healthy` ⇔ zero breaches, refine).
- `RendererMeasurements` — the three renderer-side numbers the renderer can only measure
  about itself (dispatch, store hot path, queue sort), passed as optional params to
  `perf.runReport`; absent ⇒ those budgets report `skipped` with a reason.
- Methods (main-served): `perf.probe` — a fixed tiny validated round-trip the renderer's
  dispatch bench hammers; `perf.runReport` — assembles and returns the report.
- Cross-language fixture `budgetReport` (pass + breach + skipped mix). dc-protocol mirrors
  the version constant only — main-served precedent (v1.13.0, v1.15.0).

### 3. Windows RSS sampler — closing the Phase 22 "null on Windows" gap

`CoreSupervisor.sampleCoreRssBytes()` gains a `win32` branch: a PowerShell
`(Get-Process -Id <pid>).WorkingSet64` probe (hide window, bounded timeout), with a small
TTL cache so the 10 s diagnostics refresh and a report run never stampede. The command
builder and output parser are exported pure helpers and unit-locked; the live branch is
device-verified (documented honestly). Linux `/proc` path unchanged.

### 4. Renderer benches — measuring the renderer about itself

`src/renderer/src/perf/benches.ts`: `benchIpcDispatch` (2,000 sequential real
`window.syntaxdm.rpc("perf.probe")` round-trips through the real preload bridge and the real
process boundary — strictly stronger than the in-process vitest gate),
`benchStoreHotPath` (2,000 upserts + 2,000 patches over 200 jobs on a **throwaway vanilla
store** built from the same exported state creator — never touches the live singleton's
state), `benchQueueSort` (the pure comparator, same shape as the gate). `stores/downloads.ts`
is refactored to export its state creator (`createDownloadsState`) with byte-identical
behavior — the singleton stays the singleton.

### 5. Main harness — assembly, single-flight, persistence

`src/main/perf/budget-report.ts`: `assembleBudgetReport(deps)` merges independent producers,
each allowed to skip (diagnostics posture — a report that throws is worthless):

- `core.coldStartReadyMs` ← BootClock `coreSpawnToReadyMs` (null until the marks exist);
- `core.rssAfterReadyKb` ← the supervisor sampler;
- `core.echoAvgUs` ← average of 100 sequential real `core.ping` round-trips (any failure ⇒
  skipped — partial timing is not a measurement);
- `renderer.*` bundle bytes ← inventory of `dist/renderer/assets` under the app root (same
  relative path dev and packaged; missing dir ⇒ skipped);
- `ts.*` ← the optional renderer measurements, zod-validated.

The budgets JSON is read through the `paths.ts` resolver and shape-checked (all nine ids,
positive budgets) — a missing or malformed budgets file is a packaging bug and fails LOUD
(`internal_error`), never a silently-green report. Concurrent `perf.runReport` calls
single-flight onto one assembly; every finished report is logged once through the
JsonlLogger (`component: "perf"`) so the verdict rides the Phase 20 pipeline into every
exported diagnostics zip.

### 6. Wiring

`composition.ts` gains a `perfReport` dep block (paths, app facts, source label); `main.ts`
passes `source: "packaged-app" | "dev"`; the E2E harness passes `source: "headless-test"`.
The perf domain registers `perf.probe` and `perf.runReport` beside `perf.getSnapshot`.

### 7. UI — Diagnostics page Budget report card

A card under the Performance card: description, **Run report** button (runs the renderer
benches locally, then `perf.runReport`), then a localized table — budget label, actual vs
budget, verdict chip (pass / breach / skipped) — plus the summary line and the overall
verdict badge, and **Copy report** (markdown rendering, `navigator.clipboard`, button-state
feedback, no toast dependency). en + fa dictionaries in full parity (Phase 21 compile-lock).

### 8. Verification plan

- Contracts: fixture round-trip, arithmetic-refine rejections (a lying measurement cannot
  parse), exactly-once ids, summary/verdict consistency, params validation. (+7)
- Main unit: assembly math on injected producers (breach/skip/summary), budgets-file shape
  check, single-flight, logging, PowerShell probe helpers. (+~13)
- Renderer: benches on the real store creator / comparator / mocked probe. (+3)
- E2E (`perf-report.e2e.test.ts`, suite 21): over the REAL core — report is schema-valid,
  cold start + RSS + echo are real measured numbers, breaches === 0 (headroom holds),
  2,000 real probe round-trips, single-flight returns the same report. (+5)
- Gate: `verify-all.sh` green end-to-end (118+ contracts, 376+ desktop, 300 cargo, budget
  gate, checksums selftest, fmt/clippy).

### 9. Honest limitations

- The sandbox cannot run Electron's real process boundary; `benchIpcDispatch`'s device
  number (bridge + serialization) is measured only on devices. The vitest gate keeps
  enforcing the in-process router cost; the E2E suite exercises the real router path.
- The Windows RSS branch executes only on Windows (no win32 runner in this repo today);
  its pure pieces are unit-locked and the branch is fenced to fail null, never throw.
- `input-to-paint` latency remains out of scope (no instrumentation exists; Phase 22's
  documented posture stands).
