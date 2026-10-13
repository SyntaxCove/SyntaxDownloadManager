# Phase 15 Plan — Scheduler jobs + automation

Status: PLANNED → this plan is the Phase 15 "Plan" step.
Prior state: Phases 0–14 delivered (git `d4622b2` = phase(14)); contracts v1.9.0; storage v8;
240 cargo tests / 245 vitest tests green.

## Goal

Turn the never-consumed `domain/scheduler.ts` v1 stub into a real, persistent **scheduler
engine** inside the Rust core: the user can create automation jobs that fire the app's own
actions at a scheduled time — once, daily or weekly — survive restarts, catch up on runs the
app missed while it was closed, and report every outcome honestly on the job row and through
an event. A new **Scheduler** page manages them (create / edit / enable / run-now / remove).

Phase 8 already shipped the *policy* half of scheduling (auto-start + a daily download window
gating the queue). Phase 15 adds the *job* half: explicit "at time T, do X" automations.

## Architecture decisions

### D1 — Scheduler jobs persist in the core's SQLite database (storage v9)
The ground rules say the core owns *the* persistent database, and a schedule that evaporates
when the renderer reloads is useless. New table `scheduler_jobs` in **migration v9**; a
1-second tick loop lives in the core (next to the queue pump), so schedules fire even while
no window exists, and the persisted `next_run_at` makes catch-up-after-restart automatic.
Access only via new core methods (main stays a thin validated proxy).

### D2 — Closed action set; no arbitrary RPC passthrough
A scheduled job must never be a "call any method with any payload" hole. The action is a
closed contract enum — `download.create`, `download.startAll`, `download.pauseAll`,
`media.download`, `torrent.add` — and the payload for each kind is **exactly** that method's
existing params schema (zod on the TS side, the same serde structs on the Rust side).
Dispatch goes through the same `JobManager` methods the IPC handlers use: identical
validation, identical fail-closed proxy/toolkit posture, zero new privileged surface. A fire
outcome reuses the existing classified `ErrorCode`s; no new error codes are invented.

### D3 — Time model: epoch anchor + local-wall-clock recurrence
- `startAt` is an epoch-ms anchor (the renderer converts the user's local date/time).
- `repeat: none | daily | weekly`. The core maintains `nextRunAt` (epoch ms) on the row.
- Recurring occurrences advance in **local wall clock**: `epoch → local-naive (anchor +
  k·24h/7d) → epoch` using the local-UTC offset main already computes (`-getTimezoneOffset()`).
  The offset is pushed by a new main→core method **`scheduler.setClock { tzOffsetMinutes }`**
  at startup and from the existing 10-minute policy timer (same drift-guard pattern as
  `download.setPolicy`), and on every clock push the core **recomputes** `nextRunAt` for
  repeating jobs from their anchor — so a DST/travel change snaps future fires back to the
  same local time (documented behavior; no silent 24h-epoch drift).
- The occurrence math is one pure function (`next_occurrence(anchor, rule, tz, now)`) —
  deterministic and unit-testable with fixed offsets.

### D4 — Firing semantics (honest and bounded)
- Due = `enabled = 1 AND next_run_at <= now`; fires in `next_run_at` order, **sequentially**
  (one at a time — a slow probe never becomes a burst).
- Every fire records `lastFiredAt` + `lastResultCode` (`"ok"` or the classified error code)
  + `lastResultMessage` on the row and emits `scheduler.updated { job }`.
- `repeat: none` → after firing: `enabled = false`, `nextRunAt = null` (the row stays —
  the user sees what ran and what it produced).
- Repeating jobs reschedule to the next local occurrence; **a failed action never kills the
  schedule** (the error is recorded, the next occurrence still happens).
- **Catch-up**: jobs missed while the app was closed fire at the first tick after boot —
  a schedule is persistent (mirrors the downloads ground rule: never silently dropped). The
  UI states this explicitly.
- `runNow` fires immediately regardless of the schedule, records the outcome, and never
  touches `nextRunAt`/`enabled` (explicit user intent; also the integration test hook).
  A per-job in-flight guard makes tick-vs-runNow double-fires impossible; a concurrent
  second `runNow` on the same job is refused with `invalid_state`.

### D5 — Row mutation rules
`kind` is immutable after create (change it by creating a new job — keeps the audit trail
coherent). `update` accepts `startAt?`, `repeat?`, `enabled?`, `payload?` (full payload
replacement, re-validated per kind). Changing `startAt`/`repeat` recomputes `nextRunAt`
(past occurrences are skipped — an edited daily job does not fire once per missed day).
Re-enabling a fired one-shot re-arms it at its original `startAt` (→ due again, catch-up rule
applies — uniform, documented).

## Contracts v1.10.0 (additive — minor bump; stub had zero consumers)

`packages/contracts/src/domain/scheduler.ts` activated exactly like the Phase 13 torrent
stub: the `SchedulerRepeat` enum values are preserved verbatim; everything else is built out.

```ts
SchedulerAction = "download.create" | "download.startAll" | "download.pauseAll"
                | "media.download" | "torrent.add"
SchedulerJob { id: Ulid, kind: SchedulerAction, payload: Record<string, unknown>,
               startAt: int≥0, repeat: "none"|"daily"|"weekly", enabled: boolean,
               nextRunAt: int≥0 | null,          // nullable = always serialized
               lastFiredAt: int≥0 | null,
               lastResultCode: string | null,     // "ok" or a classified ErrorCode
               lastResultMessage: string | null,
               createdAt: int≥0, updatedAt: int≥0 }
```

Payload-per-kind validation at the boundary: `download.create` → `DownloadCreateParams`,
`media.download` → `MediaDownloadParams`, `torrent.add` → `TorrentAddParams`,
`startAll`/`pauseAll` → `{}` (superRefine on create/update params).

Core methods (server: "core"):
- `scheduler.list {}` → `{ jobs: SchedulerJob[] }` (newest first)
- `scheduler.create { kind, payload, startAt, repeat, enabled? }` → `{ job }`
  (`startAt` may be in the past — catch-up semantics; UI says so)
- `scheduler.update { id, patch: { startAt?, repeat?, enabled?, payload? } }` → `{ job }`
- `scheduler.remove { id }` → `{ removed: true }`
- `scheduler.runNow { id }` → `{ job }` (outcome recorded; schedule untouched)
- `scheduler.setClock { tzOffsetMinutes }` → `{ applied: true }` (main→core only, like
  `download.setPolicy`; never registered on the renderer-facing router)

Event: `scheduler.updated { job: SchedulerJob }` (core → main → renderer via the existing
global core-event forwarder).

Fixtures: `domain.json` gains `schedulerJob` (cross-language parity tests).
`CONTRACT_VERSION` 1.9.0 → **1.10.0** on both sides; npm package → 1.10.0.

## Storage migration v9

```sql
CREATE TABLE scheduler_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  repeat TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at INTEGER,
  last_fired_at INTEGER,
  last_result_code TEXT,
  last_result_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_scheduler_due ON scheduler_jobs(enabled, next_run_at);
```

CRUD (dc-storage): `insert_scheduler_job`, `list_scheduler_jobs` (created DESC),
`get_scheduler_job`, `update_scheduler_job`, `delete_scheduler_job`,
`list_due_scheduler_jobs(now)` (enabled + due, `next_run_at` ASC — the fire order).

## Implementation surface

| Layer | Files | Change |
|---|---|---|
| contracts | `src/domain/scheduler.ts`, `src/protocol/methods.ts`, `src/protocol/events.ts`, `src/version.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` | v1.10.0 additive set |
| dc-protocol | `src/scheduler.rs` (new), `src/lib.rs`, `tests/fixtures.rs` | wire types + parity tests + version |
| dc-storage | `src/lib.rs`, `tests/storage.rs` | migration v9 + scheduler CRUD + tests |
| download-core | `src/scheduler.rs` (new), `src/manager.rs`, `src/server.rs` | SchedulerEngine + delegation + dispatch arms + tests |
| main | `domains/scheduler.ts` (new), `main.ts` | thin proxy + setClock push (ready + 10-min timer) |
| renderer | `stores/scheduler.ts` (new), `pages/SchedulerPage.tsx` (new), `app/AppShell.tsx`, `main.tsx` | Scheduler page + nav + event subscription |

## Test plan

- **cargo (download-core)**: `next_occurrence` pure-math unit tests (none/daily/weekly;
  fixed ±offsets; past-anchor catch-up counting; offset-change recompute);
  fire pipeline with `runNow` — an unreachable-URL `download.create` records a classified
  outcome on the row (offline-safe); a `startAll` fire records `ok`;
  none-job single-fire (enabled flips false, nextRunAt null); repeating job advances;
  in-flight guard refuses concurrent runNow; server arms create→list→update→remove round-trip.
- **cargo (dc-storage)**: v9 schema version; CRUD; due query ordering; outcome persistence.
- **cargo (dc-protocol)**: `schedulerJob` fixture parses; Rust round-trip byte-identical.
- **vitest (contracts)**: action enum; per-kind payload acceptance/rejection; registry +
  event entries; fixture parity; version.
- **vitest (desktop)**: scheduler store lifecycle with mocked rpc (load/create/update/
  runNow/remove, event upsert); scheduler domain forwarding with a fake supervisor.

## Verification gate (same as every phase)

`cargo fmt --check` + `cargo clippy --workspace --all-targets -D warnings` + `cargo test
--workspace` · `vitest` contracts + desktop · `typecheck` ×2 workspaces · `vite build` green,
then Document (phase-15-report.md, PHASES.md, worklog) → Review → Commit.

## Risks / non-goals (honest scope)

- No cron expressions, no monthly/yearly repeats, no per-job timezone override — the repeat
  set is `none/daily/weekly` in the app's local time (the stub's enum, verbatim).
- No scheduler-side retry policy of its own: a fired action that fails is recorded with its
  classified code; HTTP media/torrent jobs carry their own engine-level retry/recovery.
- No "run missed occurrences individually" backfill: a missed repeating run collapses into
  one catch-up fire (next occurrence math skips the whole past — documented).
- `scheduler.setClock` carries the offset only; the core never learns the tz *name*.
