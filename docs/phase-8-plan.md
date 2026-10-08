# Phase 8 Plan — Queue, Scheduler Policies, Concurrency & Bandwidth Management

Status: PLANNED → IN PROGRESS
Contracts: v1.2.0 → **v1.3.0** (additive minor)
Storage: migration v3 → **v4** (additive columns)

## Goal

Turn the current "start queued jobs in storage order" loop into a managed queue:

1. **Queue order** — persisted per-job queue position; the pump starts queued jobs in
   queue order; the user can reorder (top/up/down/bottom) and see the order in the UI.
2. **Queue controls** — `download.startAll` (resume every paused job) and
   `download.pauseAll` (pause everything active or waiting).
3. **Scheduler policies** — engine-level policy delivered from main:
   - `autoStartNew`: `download.create` queues (true, default) or parks the job as `paused` (false).
   - `scheduleMode: "always" | "window"` with a daily local time window (wrap-over allowed,
     e.g. 22:00–06:00): on window close the queue **pauses auto-started runs only**
     (user-initiated runs are honored and never interrupted); on window open the pump resumes.
   - Wiring of the previously dead `speedLimitKBps` setting (it existed in the settings
     contract since Phase 3 but was never enforced — correctness fix).
4. **Bandwidth management** — token-bucket rate limiting in the Rust core:
   - global limit (`speedLimitKBps`, shared by every segment of every job);
   - per-job limit (`download.setSpeedLimit`), persisted on the job row and applied live
     to a running job.

Non-goals (phase boundaries): time-based automation/recurring jobs = Phase 15; proxy-aware
bandwidth rules = Phase 9.

## Design decisions

### Data model (contracts v1.3.0, additive)

- `DownloadJob` gains:
  - `queuePosition: number | null` — **nullable → always serialized**; non-null only while
    the job is `queued` (cleared when a run starts, on pause, and in terminal states).
  - `speedLimitKBps?: number` — **optional → omitted when unset**; 0 = unlimited (acts as
    "no limit" too); persisted, survives restarts.
- New methods (all `server: "core"`, registered in `METHODS`):
  - `download.queueMove  { id, direction: "top"|"up"|"down"|"bottom" }` → `{ job }`
  - `download.startAll   {}` → `{ started: number }`
  - `download.pauseAll   {}` → `{ paused: number }`
  - `download.setSpeedLimit { id, kbps }` → `{ job }`  (kbps ≥ 0; 0 = unlimited)
  - `download.setPolicy  { autoStartNew, scheduleMode, windowStartMinute,
                           windowEndMinute, speedLimitKBps, tzOffsetMinutes }` → `{ applied: true }`
    - minutes are local minutes-of-day 0..=1439; `tzOffsetMinutes` is the local-UTC offset
      (e.g. +210 for UTC+03:30) so the core evaluates the window in the user's local time.
- `AppSettings` gains (additive, defaults preserve today's behavior):
  `autoStartNewDownloads: true`, `scheduleEnabled: false`,
  `scheduleStart: "00:00"`, `scheduleEnd: "00:00"` (`HH:MM` regex-validated).
  `speedLimitKBps` (already present) becomes live.

### Storage (migration v4)

- `ALTER TABLE jobs ADD COLUMN queue_position INTEGER;`
- `ALTER TABLE jobs ADD COLUMN speed_limit_kbps INTEGER;`
- `update_job` / `get_job` / `list_jobs` read+write both columns. No schema-normalized
  queue table — the queue is a projection over jobs; positions are small integers.

### Queue semantics (core)

- **Enqueue**: whenever a job enters `queued` without a position (create / resume /
  recover / replaceUrl / retry) it gets `max(queue_position)+1` (end of the queue).
- **Pump order**: queued jobs sorted by `(queue_position, created_at)`; the pump starts
  them while `running < max_concurrent` (unchanged slot rule).
- **Leave queue**: when a run starts (`probing`) or the job leaves `queued`, the position
  is cleared. A later resume re-enqueues at the end.
- **Reorder** (`queueMove`): only touches `queued` jobs; positions are normalized to
  `0..n-1`, the move is applied, all changed rows are persisted and re-emitted. Moving a
  non-queued job → `invalid_state`.
- **Start/pause all**: `startAll` resumes every `paused` job (explicit user intent;
  failed/canceled jobs keep their dedicated recover/retry semantics), `pauseAll` pauses
  every `queued|probing|downloading` job.

### Scheduler policy (core)

- `JobManager` holds `Mutex<Policy>`; a 30 s tick task evaluates the window:
  - `in_window(minute_of_day, start, end)`: `start < end` → `start <= m < end`;
    `start > end` → wrap-over (`m >= start || m < end`); `start == end` → treat as full
    day (window inactive).
  - The FIRST tick establishes the baseline (no action): queued jobs are never
    implicitly started by core startup.
  - **On outside→inside transition:** pump.
  - **On inside→outside transition:** pause every running job whose run was started by
    the **pump** ("auto"). Jobs the user explicitly started (resume/retry/startAll/
    recover/replaceUrl) are exempt — explicit user intent outranks the window.
- Run source tracking: `manual_ids: Mutex<HashSet<JobId>>` — user-initiated paths insert
  the id; the pump consumes the flag when spawning and records `manual` on the
  `JobHandle`. The tick only pauses handles with `manual == false`.
- `autoStartNew == false` → `download.create` persists status `paused` (the job never
  enters the queue until the user starts it).
- Main re-applies the policy at core-ready, on `settings.changed`, and every 10 min
  (keeps `tzOffsetMinutes` accurate across DST/travel changes).

### Bandwidth limiter (core, `rate_limit.rs`)

- `TokenBucket { capacity, refill_bps, tokens, last }` behind `tokio::sync::Mutex` per
  bucket; `acquire(n)` is cancellation-aware (`select!` against the stop token) and
  sleeps in bounded slices; granular refill (tokens = capacity are worth ≤ 1 s of
  bandwidth) so low limits (e.g. 32 KiB/s) still let small chunks through smoothly.
- Two buckets per segment read: the **global** bucket (shared by all jobs, set from
  `speedLimitKBps`) and the **job** bucket (from the job's persisted limit). A job chunk
  must be granted by both before the write. `0 bps` = pass-through (no bucket hold).
- Engine holds `Arc<AtomicU64>` for the global rate + `Mutex<HashMap<JobId, Arc<AtomicU64>>>`
  for per-job rates; `run_job` inserts the job's entry at start (seeded from the persisted
  row) and removes it at the end; `setSpeedLimit` updates the atomic live for a running
  job and persists the row for the next run.
- Limitation documented: reqwest delivers ~8–64 KiB chunks, so short bursts above the
  limit are possible; the 1 s bucket cap bounds them and the steady-state rate converges
  to the configured limit over a few seconds. Integrity is unaffected (no bytes are
  dropped; only pacing changes).

### IPC / UI wiring

- `server.rs`: dispatch arms for the five new methods (params validated by serde types
  mirroring the zod schemas).
- Electron `download.ts` domain: new methods join the validated proxy list.
- `main.ts`: `applyPolicy()` next to the existing `applyCoreLimits()`.
- Renderer:
  - downloads store: `queueMove / startAll / pauseAll / setSpeedLimit` actions.
  - DownloadsPage: queue badge + move controls (Top/Up/Down/Bottom) on queued rows;
    Start all / Pause all buttons; per-row "Speed limit" dialog (0 = unlimited).
  - SettingsPage: auto-start toggle; schedule toggle + start/end time inputs.
- Sort order of the queued section follows `queuePosition` (nulls last, then createdAt).

## Test plan

**Rust (cargo):**
- `rate_limit`: passthrough at 0; capacity bound; steady-state rate respects the limit
  (measured over ≥ 1 s of grants); cancellation during acquire; global+job buckets compose.
- queue: enqueue assigns end position; pump starts in position order; move top/up/down/
  bottom (incl. single-element and no-op edges); moving a non-queued job is rejected;
  position cleared when a run starts / on pause.
- policy: window evaluation (inside/outside/wrap-over/equal bounds); window close pauses
  auto runs and spares manual runs; window open re-pumps; `autoStartNew=false` creates
  parked jobs.
- `startAll` resumes paused only; `pauseAll` pauses queued+active.
- `setSpeedLimit`: persists, live-updates a running job's limiter, 0 clears.
- storage: migration v4 on a v3 database (columns exist, legacy rows default NULL,
  schema_version ≥ 4).
- integration: two jobs where one is limited and the other unlimited — the limited one
  takes measurably longer; global limit applies across both.
- fixtures: v1.3 job JSON (queuePosition present/null, speedLimitKBps present/absent)
  parses on both sides.

**TS (vitest):**
- contracts: new method schemas round-trip; `HH:MM` validation; defaults of the new
  settings; job fixture with v1.3 fields.
- main: policy computation (`HH:MM` → minute, tz offset sign) unit tests.
- renderer: downloads store queue actions call the bridge; DownloadsPage renders
  Start all/Pause all and move controls for queued jobs; SettingsPage renders the new
  controls.

## Verification gate (must be green before commit)

`cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` (≥ 74→~95 tests) +
`npm run typecheck` + `npm run test` (≥ 65→~80 tests) + `npm run build:desktop`.

## Files touched (expected)

- `packages/contracts`: domain/download.ts, domain/settings.ts, protocol/methods.ts,
  version.ts, fixtures/domain.json; package version 1.3.0.
- `core/crates/dc-protocol`: lib.rs (version), job.rs (new fields).
- `core/crates/dc-storage`: lib.rs (migration v4 + columns).
- `core/crates/download-core`: rate_limit.rs (new), manager.rs (queue + policy + tick),
  engine.rs (limiters + queue clearing), server.rs (dispatch), lib.rs (module).
- `apps/desktop/src/main`: main.ts (policy apply), domains/download.ts (methods).
- `apps/desktop/src/renderer`: stores/downloads.ts, pages/DownloadsPage.tsx,
  pages/SettingsPage.tsx.
- docs: phase-8-plan.md, phase-8-report.md, PHASES.md, worklog.md.
