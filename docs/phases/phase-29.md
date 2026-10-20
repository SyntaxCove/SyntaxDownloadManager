# Phase 29 — Performance validation: real-device budget report harness

Status: **delivered (2026-10-20)** · Contract **v1.15.0 → v1.16.0 (additive)** · App 0.15.0 → **0.16.0**
Plan: [`phase-29-plan.md`](phase-29-plan.md) · Budgets (now app-shipped): [`apps/desktop/resources/perf-budgets.json`](../../apps/desktop/resources/perf-budgets.json)

## What shipped

Phase 22 made performance *enforced* where the sandbox can measure. Phase 29 closes the
loop on the device: **the running app now measures itself against the shipped budgets and
produces a typed, log-persisted verdict report** — user-visible on the Diagnostics page,
schema-checked at the wire, and impossible to fake (the contract's `superRefine` enforces
the verdict arithmetic, so a report that parses is an internally consistent report).

### 1. Budgets became an app-shipped asset — one file, three consumers

`scripts/perf-budgets.json` → **`apps/desktop/resources/perf-budgets.json`** (git mv; the
established side-file home, same mechanism as `toolchains.json`):
`electron-builder.json` packages it as `perf-budgets.json` next to the app's resources;
`paths.ts` resolves it dev/packaged exactly like the toolchains manifest; the build gate
(`check-budgets.mjs`) and both vitest perf gates now read the same bytes the running app
reads. Drift between "what CI enforces" and "what the device compares against" is now
structurally impossible.

### 2. Contracts v1.16.0 — the verdict vocabulary

`domain/perf.ts` adds (additive; dc-protocol mirrors the version constant only — the
main-served precedent of v1.13.0/v1.15.0):

- `BudgetId` — closed enum of the nine shipped budgets; `BudgetUnit` (ms/us/bytes/kb);
  `BudgetVerdict` (pass/breach/skipped); `BudgetReportSource` (packaged-app/dev/headless-test).
- `BudgetMeasurement` — with an **arithmetic honesty refine**: `skipped ⇔ actual === null`,
  `pass ⇔ actual ≤ budget`, `breach ⇔ actual > budget`. A lying measurement cannot parse.
- `BudgetReport` — environment facts (app/contract versions, platform, OS release, source),
  **exactly one measurement per id** (refine), a summary whose parts must sum to the total
  AND match the measurements (refine), and a verdict implied by the breach count (refine).
- `RendererMeasurements` — the three renderer-side numbers, bounded at one hour, optional
  params of `perf.runReport`; absent ⇒ those rows skip with a reason.
- Methods (main-served): **`perf.probe`** (fixed tiny validated round-trip) and
  **`perf.runReport`**. Cross-language fixture `budgetReport` (pass + breach + skipped mix).

### 3. Windows RSS sampler — the Phase 22 gap closed

`CoreSupervisor.sampleCoreRssBytes()` gained the win32 branch Phase 22 anticipated: a
PowerShell `(Get-Process -Id <pid>).WorkingSet64` probe (`-NoProfile -NonInteractive`,
hide-window, 3 s timeout) with a 4 s TTL cache and single-flight so the 10 s diagnostics
refresh and a report run never stampede PowerShell. Command builder and output parser are
exported pure helpers, unit-locked; the branch fails null, never throws. Linux `/proc` path
unchanged.

### 4. Renderer benches — the renderer measures itself, safely

`src/renderer/src/perf/benches.ts`: `benchIpcDispatch` (2,000 sequential real
`window.syntaxdm.rpc("perf.probe")` round-trips — the real preload bridge and process
boundary, strictly stronger than the in-process vitest gate), `benchStoreHotPath`
(2,000 upserts + 2,000 patches on a **throwaway vanilla store** built from the same
exported state creator — the live job list is provably untouched; a sentinel test pins
this), `benchQueueSort` (the pure comparator). `stores/downloads.ts` now exports
`createDownloadsState`/`DownloadsState` with byte-identical behavior; the singleton stays
the singleton.

### 5. Main harness — assembly, single-flight, persistence

`src/main/perf/budget-report.ts`: `assembleBudgetReport()` merges independently-degrading
producers (diagnostics posture — a report that throws is worthless):

| Budget id | Producer | Skips when |
|---|---|---|
| core.coldStartReadyMs | BootClock `coreSpawnToReadyMs` (last boot) | boot not finished |
| core.rssAfterReadyKb | supervisor sampler (÷1024 → KiB) | platform/running |
| core.echoAvgUs | avg of 100 real `core.ping` round-trips — **all must succeed** | any ping fails |
| renderer.*Bytes | inventory of `dist/renderer/assets` (same relative path dev + packaged) | dir absent |
| ts.* | optional renderer measurements | not provided |

The budgets file is shape-checked at run time (all nine ids, positive budgets) — a missing
or malformed file is a packaging bug and fails **loud** (`internal_error`), never a
silently-green report. Concurrent `perf.runReport` calls single-flight onto one assembly
(two Diagnostics windows share a report instead of stampeding the core); every finished
report is logged once through the JsonlLogger (`component: "perf"`, including the breached
ids) so the verdict rides the Phase 20 pipeline into every exported diagnostics zip.

### 6. UI — the Diagnostics page Budget report card

Under the Performance card: description, **Run report** (runs the renderer benches locally,
then `perf.runReport`), then the localized table — budget label, actual vs budget, verdict
chip (pass/breach/skipped), per-row provenance — plus the summary line, the overall
verdict badge (healthy/breached), and **Copy report** (deterministic Markdown via
`navigator.clipboard`, button-state feedback). en + fa in full compile-locked parity
(31 new keys per language, including the nine budget labels and the four unit formats).

## Verification (all green — `tool-results/verify-all-p29.log`)

- typecheck (contracts + main + renderer + e2e) ✅
- vitest: **126 contracts** (+8) · **400 desktop** (+24: 14 harness unit, 5 renderer
  bench/markdown, 5 E2E suite 21) ✅
- E2E suite 21 over the real core: report healthy with REAL measured cold start / RSS /
  echo; renderer breach math flips the verdict end-to-end; single-flight; 2,000 real
  probes ✅
- `vite build` ✅ + **budget gate** ✅ (1,158,502 / 1,200,000 B — the card cost ~11.7 KB;
  `perf-budgets.json` baselines re-measured honestly)
- `cargo fmt --check`, `clippy -D warnings` ✅ · **300 cargo tests** ✅ (no Rust surface —
  main-served precedent; the version pin enforces 1.16.0 at handshake)
- checksums selftest ✅ · full `scripts/verify-all.sh`: "all checks passed"

## Honest limitations

- The Windows RSS branch executes only on Windows (no win32 runner in this repo); its
  command builder and parser are unit-locked and the live path is fenced to null. Device
  reports are its verification surface.
- `benchIpcDispatch`'s device number (bridge + serialization + context switch) exists only
  on devices; the vitest gate keeps enforcing the in-process router cost, and the E2E
  suite exercises 2,000 real round-trips through the real router with a loose wall-clock
  bound (the strict budget stays a gate concern).
- Skips are first-class: a report can be `healthy` with all rows skipped. That is why the
  summary and per-row provenance are part of the typed wire — a healthy report with nine
  skips is visibly not a benchmarked one.
- `input-to-paint` latency remains uninstrumented (Phase 22 posture unchanged).
