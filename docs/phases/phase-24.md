# Phase 24 Report — Hardening (fault injection, framing limits, crash recovery)

Status: DELIVERED (2026-10-18). Plan: `docs/phases/phase-24-plan.md`. Contract **stays
v1.15.0** (no wire change). App → **0.11.0** (root + desktop + Rust workspace).

## Scope note

The grouped row "24–31" was split into individual phases in `docs/PHASES.md` this commit
(24 hardening · 25 E2E suites · 26 release engineering · 27 docs · 28 data-integrity
validation sweep · 29 performance validation · 30 security & privacy final review ·
31 v1.0.0). Phase 24 is the hardening pass: a fault-injection survey of the places where
an abnormal input, a crash, or a flood could degrade the system.

## Survey verdicts (checked and found sound)

Scheduler windows (wrap-over midnight + equal-bounds-is-all-day + transition semantics),
core supervisor restart policy (backoff, give-up, healthy-streak reset), segment file
reopen (durable-cursor truncation of stale crash tails), storage configuration (WAL +
`synchronous=FULL` + foreign keys, fail-loud open), address-bar and core URL admission.
All of these already carried tests; none needed changes.

## Fixes shipped (each locked by fault-injection tests)

1. **F-1 — core stdin framing was unbounded (Rust).** `server::serve` read stdin lines
   with no length limit and spawned an unbounded task per request — a runaway or
   compromised renderer could OOM the core process. Now: `MAX_LINE_BYTES` = 4 MiB (an
   oversized line is drained but never buffered) and `MAX_INFLIGHT_REQUESTS` = 64 (the
   read loop stalls on a semaphore — natural backpressure, nothing dropped). A framing
   violation answers a bounded `parse_error` that cites the limit and **never echoes the
   content**; the stream stays framed and the channel survives. Tests: 5 MiB line →
   bounded refusal → normal request still served; 128-request pipelined burst (2× the
   in-flight bound) → every response present, in order; invalid-UTF-8 line → bounded
   refusal → channel survives.
2. **F-2 — renderer crash never recovered (Electron).** `render-process-gone` was only
   logged; a crashed renderer left a dead window. Now: non-clean-exit crashes schedule a
   bounded auto-reload — 3 attempts per 60 s sliding window, linear 1 s/2 s/3 s backoff,
   budget exhausted logged through the Phase 20 diagnostics (new `render-reload` kind,
   which nothing branches on). The decision is a pure function
   (`window-recovery.ts`, no Electron imports) with a 7-case matrix test; the recovery
   path exists even when no diagnostics callback was passed.
3. **F-3 — persistence corruption behavior was never exercised (Rust).** New
   `dc-storage/tests/corruption.rs`: a garbage file at `open` must fail typed (never
   panic, never succeed); a zero-byte file opens as a fresh database (graceful path
   pinned); a database corrupted after creation must have `quick_check` stop reporting
   "ok" (error or non-"ok" report — never a false green on the diagnostics health card).

## Verification

- `scripts/verify-all.sh` end-to-end: **all checks passed** — typecheck clean; vitest
  **118 contracts + 342 desktop** (+7 window-recovery); renderer build + Phase 22 budget
  gate respected (bundle unchanged); cargo fmt/clippy clean; **279 Rust tests** (+3
  framing, +3 corruption).
- Contract unchanged at 1.15.0; wire format untouched (framing refusals reuse the
  existing `parse_error` shape with the synthetic `unknown` id).

## Environment note (honest log)

The sandbox reset wiped the Rust toolchain twice during this phase; rustup was
reinstalled (stable, minimal profile) and the full gate re-run to green afterwards. No
test or artifact was produced from a stale toolchain state.
