# Phase 15 Report — Scheduler jobs + automation

Status: DELIVERED (2026-10-13). Contracts 1.9.0 → **1.10.0** (additive). Storage v8 → **v9**.
Prior state: Phases 0–14 delivered (git `d4622b2`).

## What shipped

### 1. Persistent scheduler engine (core-side, storage v9)
- **Rows in the core's SQLite database**: new `scheduler_jobs` table (migration v9) with a
  `(enabled, next_run_at)` index. The core owns the schedule; the renderer never computes
  fire times. A **1-second tick** (next to the queue pump) runs one indexed due query —
  worst-case fire latency ~1 s, and the persisted `next_run_at` makes catch-up-after-restart
  automatic. Schedules survive renderer reloads, core restarts and app shutdowns.
- **Closed action set** (no arbitrary RPC passthrough): `download.create`,
  `download.startAll`, `download.pauseAll`, `media.download`, `torrent.add`. Each kind's
  payload is exactly the target method's params schema — zod-validated at the boundary and
  re-validated per kind in the core (`validate_payload`). Dispatch goes through the same
  `JobManager` methods the IPC handlers use: identical validation, identical fail-closed
  proxy/toolkit posture, zero new privileged surface, no new error codes.
- **Outcome recording**: every fire stamps `last_fired_at` + `last_result_code` (`"ok"` or a
  classified error code) + `last_result_message` on the row and emits `scheduler.updated`.
  A failed action never kills a repeating schedule and never destroys the row; the fired
  row is always the audit trail.

### 2. Time model (wall-clock recurrence, DST-safe)
- `startAt` is an epoch-ms anchor; the core additionally persists **`wall_anchor`** (the
  anchor's naive local ms under the offset that was current when the anchor was set).
- Recurring slots advance in naive local ms — exactly 24 h / 7 d of wall clock — so when
  main pushes the local-UTC offset (**`scheduler.setClock`**, at startup and from the same
  10-minute drift-guard timer as `download.setPolicy`), repeating rows re-derive
  `next_run_at` and future fires **snap back to the same local time** after a DST/travel
  change. One-shots never move with the clock.
- **Anchor semantics** (documented, deterministic): the anchor is always the first
  occurrence — `create` (and a `startAt` edit) schedule it verbatim, past or future, so a
  one-shot created in the past catches up at the next tick; every later slot is strictly
  future (`k = floor(elapsed/step) + 1`), so a missed repeating run collapses into ONE
  catch-up fire, never a replay of every missed day.
- **Firing**: due = `enabled AND next_run_at <= now`, fired sequentially in `next_run_at`
  order (a slow probe never becomes a burst). `repeat: none` → the row disables itself and
  clears `next_run_at`. A per-job in-flight guard (Drop-safe) makes tick-vs-runNow double
  fires impossible; a concurrent second `runNow` is refused with `invalid_state`.
- **`scheduler.runNow`** fires immediately, records the outcome, and never touches the
  schedule (explicit user intent; also the integration-test hook for the fire pipeline).

### 3. Row mutation rules (update)
- `kind` is immutable (audit-trail coherence; create a new job instead). `update` accepts
  `startAt?`, `repeat?`, `enabled?`, `payload?` (full payload replacement, re-validated
  against the row's kind). Everything is validated **before** anything is mutated.
- A new anchor is honored verbatim (`next_run_at = new startAt`); repeat switches and
  re-enables re-derive from the wall anchor (future slots only — no per-missed-day burst);
  re-arming a fired one-shot points it at its original anchor again; disabling keeps the
  row inert and recompute happens on re-enable.

### 4. UI surface (Scheduler page)
- New **Scheduler** nav entry with job cards: per-row enable `Switch` (optimistic, then the
  authoritative snapshot), kind label, payload summary, anchor/next-run local times, and
  the **last-run outcome** (green `ok` / red classified code + message, or "never fired").
- Actions: **Run now**, **Edit** (kind locked; per-kind payload fields + local datetime
  picker + repeat + enabled), **Remove**. The create dialog covers all five action kinds
  with their natural fields (URL / page URL + format ids / magnet URI / destination dir,
  pre-filled from the settings download dir) and states the catch-up semantics explicitly.

## Contracts v1.10.0 (additive)
- `domain/scheduler.ts` activated exactly like the Phase 13 torrent stub: the v1
  `SchedulerRepeat` values (`none | daily | weekly`) are preserved verbatim; everything
  else is built out. New `SchedulerAction` enum, `SchedulerJob` v2 (always-serialized
  nullable `nextRunAt`/`lastFiredAt`/`lastResultCode`/`lastResultMessage`), 6 core methods
  (5 renderer-facing + `scheduler.setClock` main→core only), `scheduler.updated` event,
  and a per-kind payload map (`SCHEDULER_PAYLOAD_SCHEMAS`) that reuses the existing param
  schemas — `create` superRefine-validates the payload against the chosen kind.
- Fixtures: `domain.json` gained `schedulerJob`; parity tests on both sides prove
  byte-identical wire shapes (explicit nulls for the nullable outcome fields included).
- `CONTRACT_VERSION` 1.10.0 mirrored in dc-protocol; npm package 1.10.0.

## Layer-by-layer changes
| Layer | Files |
|---|---|
| contracts | `src/domain/scheduler.ts` (activated), `src/protocol/methods.ts`, `src/protocol/events.ts`, `src/version.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` |
| dc-protocol | `src/scheduler.rs` (new), `src/lib.rs`, `tests/fixtures.rs` (+3 parity tests) |
| dc-storage | `src/lib.rs` (migration v9, `SchedulerJobRow` + CRUD + due query), `tests/storage.rs` (+5 tests) |
| download-core | `src/scheduler.rs` (new: occurrence math + engine + dispatch), `src/manager.rs` (6 delegation methods + tick spawn), `src/server.rs` (6 dispatch arms), `tests/scheduler.rs` (new, 9 tests), `tests/server.rs` (+2 wire tests) |
| main | `domains/scheduler.ts` (new, thin proxy), `main.ts` (setClock push at ready + 10-min timer) |
| renderer | `stores/scheduler.ts` (new), `pages/SchedulerPage.tsx` (new), `app/AppShell.tsx` (nav), `main.tsx` (event subscription) |

## Fixed during Test/Fix
- **4 pre-existing version-comparison defects in contracts tests** (exposed by the 1.10.0
  bump): three `CONTRACT_VERSION >= "1.x.0"` lexicographic string compares (which break at
  any minor ≥ 10) and one stale exact-pin — all replaced with the numeric
  major/minor comparison the Phase 9 block already used.
- Engine-time model: the first draft advanced occurrences in pure epoch space
  (`next = anchor + k·24h`), which silently drifts local wall time across DST. Rebuilt
  around the persisted `wall_anchor` (naive local ms) with conversion helpers at the
  edges — the recurrence math is now offset-free and the DST snap is unit-tested.
- Test arithmetic/timing: due-query expectations (a row due at 3000 is not due at 2500),
  `valid_ulid(n)` ignores its argument (fresh ULID per call — capture ids in variables),
  1 ms `now_ms()` drift between create and assert (capture `start` once), and three
  assertions that misread the manual-fire contract (runNow leaves `enabled`/`next_run_at`
  exactly as they were).
- Renderer bridge re-validation caught the store test's hand-made row ids (not ULIDs) —
  the mocks now return schema-valid fixtures.
- clippy `unnecessary_to_owned` in the scheduler test.
- **Review-stage defect: `set_clock` could steal a pending catch-up fire.** The boot-time
  clock push runs before the first post-boot tick; recomputing a currently-due repeating
  row would push its missed slot into the future and silently skip the run. `set_clock`
  now leaves currently-due rows untouched (the fire itself advances them) — covered by a
  dedicated regression test.

## Verification gate
- `cargo fmt --check` clean; `cargo clippy --workspace --all-targets -D warnings` 0 warnings.
- `cargo test --workspace`: **268 passed** (was 240): dc-storage 28 (was 23), dc-protocol
  fixtures 18 (was 15), download-core lib 9 scheduler unit tests, integration +10 (fire
  pipeline, boundary classification, clock recompute, update semantics, catch-up guard)
  and server wire +2 (create/list/update/remove/setClock round-trip, runNow outcome over
  the wire).
- `vitest`: contracts **84** (was 75), desktop **182 passed + 1 skipped** (was 169 + 1).
- `typecheck` ×2 workspaces clean; `vite build` green (pre-existing chunk-size notice only).
- `scripts/verify-all.sh` end-to-end: **all checks passed**.

## Non-goals (honest scope)
No cron expressions, no monthly/yearly repeats, no per-job timezone override (the repeat
set is the v1 stub's `none/daily/weekly` in app-local time). No scheduler-side retry
policy: a fired action that fails is recorded with its classified code and the engine's
own retry/recovery takes over for HTTP/media/torrent jobs. No "run each missed occurrence"
backfill: a missed repeating run collapses into one catch-up fire. `scheduler.setClock`
carries the offset only — the core never learns the timezone name.
