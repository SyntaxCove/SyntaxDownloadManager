# Phase 8 Report — Queue, Scheduler Policies, Concurrency & Bandwidth Management

Status: **DELIVERED** (2026-10-08) · Contracts v1.2.0 → **v1.3.0** · Storage v3 → **v4**
Verification: `cargo fmt` clean · `cargo clippy -D warnings` clean · `cargo test` **93 passed** (was 74) ·
vitest **84 passed** (was 65) · `tsc` main+renderer clean · `vite build` clean.
Commit: `phase(8)` (see git log).

## What was delivered

### 1. Managed queue with persisted order
- `DownloadJob.queuePosition: number | null` — 0-based slot while `queued`; **always
  serialized** (null once the job leaves the queue). Persisted in the new
  `queue_position` column (migration v4).
- Enqueue rule: every user-initiated path (`resume`/`retry`/`recover`/`replaceUrl`)
  and `create` assigns `max(position)+1` — the end of the queue.
- The pump starts queued jobs sorted by `(queuePosition, createdAt)` while free slots
  exist (slot rule unchanged: `concurrentDownloads`, 1..8).
- Leaving the queue (run start, pause, cancel, terminal) clears the slot; a later
  resume re-enqueues at the end.
- `download.queueMove { id, direction: top|up|down|bottom }` — reorder restricted to
  `queued` jobs (non-queued → `invalid_state`); positions are renormalized to 0..n-1
  and every changed row is persisted + re-emitted.

### 2. Queue-level controls
- `download.startAll` → resumes every `paused` job (explicit user intent). Failed and
  canceled jobs deliberately keep their dedicated recover/retry/rebind semantics — a
  blanket "start all" must not blindly re-hit dead sources.
- `download.pauseAll` → pauses every `queued|probing|downloading` job; queued jobs
  release their slots; the user-start markers are cleared.

### 3. Scheduler policies (engine-level, pushed from main)
- `download.setPolicy { autoStartNew, scheduleMode, windowStartMinute, windowEndMinute,
  speedLimitKBps, tzOffsetMinutes }`:
  - `autoStartNew: false` → `download.create` parks new jobs as `paused` instead of
    queueing them.
  - `scheduleMode: "window"` gates auto-started runs by a daily local-time window
    (minutes-of-day; **wrap-over windows supported**, e.g. 22:00→06:00; equal bounds =
    whole day). A 30 s tick detects transitions:
    - outside→inside: pump;
    - inside→outside: pause **auto-started runs only** — runs the user explicitly
      started are never interrupted (run-source tracking via manual markers consumed
      by the pump; pause/cancel clears them).
  - Main applies the policy at core-ready, on `settings.changed`, and every 10 min
    (`tzOffsetMinutes` drift guard for DST/travel).
- Settings contract additions (additive, defaults preserve behavior):
  `autoStartNewDownloads: true`, `scheduleEnabled: false`,
  `scheduleStart: "00:00"`, `scheduleEnd: "00:00"` (HH:MM regex-validated).

### 4. Bandwidth management (token bucket, core-side)
- New `rate_limit.rs`: cancellation-aware token bucket with granular refill,
  1-second capacity cap, and **incremental grants** — a request larger than the
  capacity is delivered across refills instead of deadlocking (regression-tested).
- Two gates per segment chunk (both must grant before the write):
  - **global** bucket — `speedLimitKBps` setting, now live (it existed since Phase 3
    but was never enforced — correctness fix), applied live to running runs;
  - **per-job** bucket — `download.setSpeedLimit { id, kbps }` (0 = unlimited),
    persisted on the job row (`speed_limit_kbps` column), seeded at run start and
    updatable live while running.
- Pacing only delays writes; no byte is dropped or reordered, so every integrity
  guarantee (journal-after-write, If-Range gates, checksums) is untouched. Short
  bursts above the limit are bounded by the 1 s capacity and converge within seconds
  (chunk granularity note documented in the module).

### 5. IPC / UI
- Contracts v1.3.0: five new core methods registered + validated; new cross-language
  fixture `downloadJobQueued` (queuePosition set, speedLimitKBps present) parsed and
  round-tripped on both sides; legacy fixtures updated with `queuePosition: null`.
- Electron main: `policy.ts` (pure, unit-tested translation settings → setPolicy),
  validated proxy registration for the new methods.
- Renderer: Downloads store gains `queueMove/startAll/pauseAll/setSpeedLimit`;
  DownloadsPage shows queue position badges + move up/down controls on queued rows,
  Start all / Pause all header actions, and a per-row speed-limit dialog (0 =
  unlimited) with a "capped at N KiB/s" badge; display order groups active runs →
  waiting queue (slot order) → the rest (stable).
- SettingsPage: auto-start toggle, schedule toggle + HH:MM window inputs (regex-
  guarded), the previously dead speed-limit field is now wired to the engine.

## Storage migration v4
`ALTER TABLE jobs ADD COLUMN queue_position INTEGER; ADD COLUMN speed_limit_kbps INTEGER;`
— additive, old databases migrate forward; legacy rows default NULL (tested).

## Test/Fix notes
- **Rate-limiter deadlock (found in Test)**: an `acquire(n)` with n > bucket capacity
  could never be granted (tokens capped at capacity) — replaced with incremental
  grants + a dedicated regression test (`request_larger_than_capacity…`).
- **Startup-pump regression (found in Test)**: the policy tick's first fire acted on a
  synthetic `false→true` transition and implicitly started pre-existing queued jobs
  (breaking the Phase 7 contract that a seeded queued job is not started by unrelated
  manager operations). Fixed: the first tick establishes the baseline; queued jobs
  start only on user action or a genuine window-open transition.
- Queue display comparator initially returned 0 across status groups (queued jobs did
  not group); reworked to active → queue → rest grouping with in-group stability.
- Existing Phase 5–7 suites were not weakened — engine (14), recover (11), server (7)
  all pass unchanged.

## Test inventory (new)
- Rust `queue.rs` (11): position assignment + pump order; reorder top/up/down/bottom
  + non-queued rejection; pause→resume re-enqueue; startAll (paused only, failed
  untouched); pauseAll (active + queued); speed-limit persistence + 0-clears +
  unknown-job error; window pauses auto runs & spares manual runs; window evaluation
  (normal/wrap-over/equal bounds).
- Rust `rate_limit.rs` (7): pass-through, burst, steady-state pacing, surplus discard
  on lowered limit, oversized-request pacing, cancellation, zero-byte grant.
- Rust fixtures (2 updated/new): queued job round-trip + null-omission pins.
- TS contracts (7 new cases), main policy translation (5), downloads store queue
  actions + comparator (7).

## Phase boundary notes
- `in_window` uses the local-UTC offset supplied by main; equal window bounds mean
  "whole day" (documented); a stopped schedule equals `always` mode.
- Time-based automation / recurring jobs remain Phase 15; the window here only gates
  the download queue itself.
