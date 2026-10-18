# Phase 24 Plan — Hardening (fault injection, framing limits, crash recovery)

Status: draft → delivered 2026-10-18 · Contract **stays v1.15.0** (no wire change) ·
App 0.10.0 → 0.11.0

## Scope (from docs/PHASES.md)

The grouped row "24–31 | Hardening, E2E suites, release engineering, docs, 1.0.0" is
split into individual phases in this commit (24 hardening · 25 E2E suites · 26 release
engineering · 27 docs · 28 data-integrity validation sweep · 29 performance validation ·
30 security & privacy final review · 31 v1.0.0). Phase 24 is the **hardening pass**: find
the places where an abnormal input, a crash, or a flood degrades the system, and close
them with fault-injection tests. Data integrity outranks everything, so the pass starts
at the core's process boundary and the persistence layer.

## Hardening survey results (what was checked and found sound)

- Scheduler windows: `in_window_minute` handles wrap-over (start > end spans midnight)
  and equal-bounds-is-all-day; transitions pause only auto-started runs — tested.
- Core supervisor: exponential backoff with give-up (`unavailable`) and healthy-streak
  reset — tested (backoff.test.ts, core.test.ts).
- Segment files: reopen truncates to the durable cursor ("drops any stale crash tail");
  v1 part migration sizes the journal from the real file length — tested in engine.rs.
- Storage: WAL + `synchronous=FULL` + foreign keys; open failure exits(1) with a clear
  stderr line; `quick_check` surfaced through the diagnostics health report.
- Address bar: `javascript:`/`data:`/control characters rejected; core URLs http(s)-only
  with argv hygiene (Phase 23 audit).

## Findings → fixes (this phase)

- **F-1 — core stdin framing is unbounded (Rust).** `server::serve` read stdin lines
  with no length limit and spawned an unbounded task per request: a runaway or
  compromised renderer (or a bug) could OOM the core. Fix: `MAX_LINE_BYTES` (4 MiB —
  orders of magnitude above any legitimate request) + `MAX_INFLIGHT_REQUESTS` semaphore
  (64, backpressure by stalling the read loop). An oversized/undecodable line answers a
  bounded `parse_error` (no echo of the content) and the channel stays alive.
- **F-2 — renderer crash never recovers (Electron).** `render-process-gone` was only
  logged. Fix: pure `rendererReloadDecision()` (window-recovery.ts, no Electron imports):
  non-clean-exit crashes auto-reload with 1 s/2 s/3 s backoff, **3 attempts per 60 s**
  sliding budget, then stop scheduling and log that the budget is exhausted — a crash
  loop must never become a reload loop. Surfaced through the Phase 20 diagnostics as a
  new `render-reload` kind (kind is never branched on; main logs it like the others).
- **F-3 — persistence fault injection was implicit (Rust).** Corrupt-input behavior of
  `JobStore` was never exercised. New `dc-storage/tests/corruption.rs`: a garbage file at
  open must fail with a typed StorageError (never a panic, never silent success), and a
  database corrupted post-creation must have its `quick_check` stop reporting "ok"
  (error or non-"ok" report — never a false green).

## Verification

- New Rust tests: oversized-line + channel-survival, pipelined-burst ordering/completeness
  (server.rs harness over the duplex pair); corruption drill (dc-storage).
- New desktop tests: rendererReloadDecision matrix (clean-exit, backoff ladder, sliding
  budget, budget reset after quiet period).
- Full `scripts/verify-all.sh` gate green; contract version unchanged.
