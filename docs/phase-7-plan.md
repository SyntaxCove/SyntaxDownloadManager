# Phase 7 Plan — Recovery engine v2 (source re-acquisition, multi-signal revalidation, rebind, gap-fill)

Status: PLAN (Step 1 of 7). Baseline verified green before planning: cargo 49 ✓, vitest 60 ✓,
typecheck ✓, clippy clean, contracts dist rebuilt after the sandbox reset (toolchain reinstalled:
rustc 1.99.0, rustfmt 1.10.0, clippy 0.1.99).

## Goal (from docs/PHASES.md ground rules)

An expired URL never destroys the job or the bytes already downloaded. Recovery re-acquires a
source, revalidates with multiple signals (Content-Length / ETag / Last-Modified / Content-Type),
rebinds the job to the new source, and fills only the missing ranges.

Today (Phase 6 baseline): any validator mismatch on resume triggers a bounded clean restart that
**wipes the part**; a dead URL (404/410) fails the job with a generic `http_error` and there is no
way to rebind it to a refreshed URL. Phase 7 closes both gaps without weakening integrity.

## Design

### 1. Multi-signal revalidation (pure, unit-tested) — new module `download-core/src/recover.rs`

```rust
pub struct SourceSignals { total_bytes, etag, last_modified, content_type }  // all Option
pub enum RevalidateVerdict { Identical, ChecksumArbitrated, Restart }
pub fn revalidate(part: &SourceSignals, fresh: &SourceSignals, has_expected_checksum: bool) -> RevalidateVerdict
```

Decision matrix (data integrity outranks keeping bytes; documented + tested):

| Order | Condition | Verdict |
|---|---|---|
| 1 | ETag present on both and equal | `Identical` (strongest identity signal; a server lying about ETag+length is caught later by the 206 Content-Range total gate) |
| 2 | Last-Modified equal on both AND both totals known and equal | `Identical` |
| 3 | Both totals known and differ | `Restart` (representation changed) |
| 4 | Media-type kind (before `;`, case-insensitive) known on both and differs | `Restart` (classic expired-URL-now-serves-HTML case) |
| 5 | Both totals known and equal, no identity signal matched | `ChecksumArbitrated` when the job carries an expected checksum, else `Restart` (no proof → integrity outranks bytes) |
| 6 | Totals unknown on either side (and no signal matched) | `Restart` (cannot prove equivalence without size) |

### 2. Re-acquisition classification (pure, in `recover.rs`)

`classify_probe_failure(status) -> ErrorCode`: 404/410 → `source_gone`, 401/403 →
`source_forbidden`, else `http_error` (416 handled as today). New append-only error codes on both
language sides: `source_gone`, `source_forbidden`, `source_changed`. `source_changed` replaces the
generic `http_error` when the bounded clean-restart budget is exhausted — the UI can then offer
recovery.

### 3. Engine integration (`engine.rs`)

- Capture the FULL part provenance before the probe overwrites the row: `part_total` +
  `part_content_type` join the existing `part_etag` / `part_last_modified`.
- Resume path with written bytes: `revalidate(part, fresh, has_checksum)`:
  - `Identical` → today's path (If-Range resume, journal kept).
  - `ChecksumArbitrated` → journal kept (equal totals ⇒ equal plan), segments run **without
    If-Range** (validators differ by definition); any 200-on-ranged still hits the existing
    bounded clean-restart path (a server that cannot gap-fill must not be spliced against), and
    the final expected-checksum verdict arbitrates the mixed-provenance file.
  - `Restart` → existing bounded clean-restart path.
- Probe failures classified (§2) so a dead URL fails with a recoverable, actionable code.
- Restart exhaustion → `source_changed` (was `http_error`).

### 4. Recovery cycle — `Engine::recover(job)`

Allowed from `failed` / `paused` / `canceled` (manager validates; RPC errors for anything else).
Sets `probing`, probes the CURRENT url:
- Probe fails → job persists the classified error (`source_gone` / `source_forbidden` /
  `network_error` / `http_error`) and stays failed; the call still returns the job (recovery
  outcome is data, not an RPC fault).
- Probe succeeds → `revalidate` against the persisted part provenance:
  - `Identical` / `ChecksumArbitrated` → **rebind**: persist fresh signals
    (etag/lastModified/contentType/totalBytes) onto the row, `recoveryCount += 1`,
    `reboundAt = now`, status `queued`, error cleared, pump. After a rebind the row validators
    describe the source the missing ranges will come from; mixed-provenance parts remain guarded
    by the checksum verdict (and by every 206 Content-Range gate).
  - `Restart` → wipe journal + part (existing discipline), rebind metadata, queue.

Provenance model stays crash-safe: a fresh run persists probed validators BEFORE segments start,
so `drive()` always reads the provenance of what is actually on disk (Phase 6 discipline,
unchanged).

### 5. New IPC methods (contract v1.2.0, additive)

- `download.recover { id } → { job }` — the §4 cycle.
- `download.replaceUrl { id, url } → { job }` — rebinds the job to a new URL (http(s) enforced),
  `recoveryCount += 1`, `reboundAt = now`, clears the error, status `queued`, pump. Allowed from
  `queued` (no active task) / `paused` / `failed` / `canceled`; rejected for active or completed
  jobs (`invalid_state`).
- `download.retry { id } → { job }` — failed/canceled/paused → queued (same manager path as
  resume); distinct UI verb, zero new engine logic.
- Deliberately deferred (documented, not silently skipped): `download.start` (create auto-pumps;
  resume/pump cover every entry) and `download.openFolder` (Electron-main shell concern,
  downloads-library phase).

Job fields (nullable = always serialized, per the pinned wire rules):
`recoveryCount: number | null`, `reboundAt: number | null`.

### 6. Storage (dc-storage migration v3)

`ALTER TABLE jobs ADD COLUMN recovery_count INTEGER; ADD COLUMN rebound_at INTEGER;` plus
insert/update/row-mapping wiring and `max(0)` clamps consistent with existing columns.

### 7. Electron + renderer

- `domains/download.ts`: register the three methods; preload passthrough unchanged (generic).
- DownloadsPage: for failed jobs — a **Recover** action (calls `download.recover`), a **Retry**
  action (`download.retry`), and a **Replace URL…** Fluent Dialog (Input) that calls
  `download.replaceUrl`; recoverable codes show a hint line. Downloads store gains the three
  actions (zustand, existing pattern).

## Test plan

Rust pure (`recover.rs` + `segments.rs`-style unit tests): revalidate matrix (≈10 cases incl.
ETag-equal-with-lying-length, LM+total identity, kind change, checksum arbitration branch,
unknown totals), media-type-kind parsing, probe-failure classification.

Rust integration (`tests/recover.rs`, real local HTTP server):
1. expired URL: part + journal survive a `source_gone` resume failure byte-exactly;
2. `recover()` after the outage clears → Identical: only the missing ranges requested
   (range_starts assertion), `recoveryCount == 1`, completes with exact bytes;
3. `replaceUrl` to a second server serving identical content → keeps bytes, job.url updated;
4. `ChecksumArbitrated`: rotated source, same length, expected checksum → completes without any
   If-Range sent, checksum verified, file == v2 bytes;
5. changed source (different length, no checksum) → clean restart, final file == v2 (no splice);
6. fresh job against a 404 URL → failed `source_gone`;
7. RPC e2e: `download.recover` / `download.replaceUrl` / `download.retry` arms.

TS: contracts fixtures round-trip (new fields null + set), method-registry validation, error-code
registry; desktop tests for the domain method list and store actions.

## Verification gate (Review step)

cargo fmt --check · clippy `-D warnings` · cargo test (49 + new) · npm typecheck · vitest
(60 + new) · vite build. Then docs/phase-7-report.md, PHASES.md #7 → delivered, ARCHITECTURE.md
resumability section updated, worklog appended, single phase commit.

## Risks / non-goals

- `recover()` probes inline (bounded by the engine's 20 s connect timeout; CoreClient RPC timeout
  is 30 s) — no background recovery task in this phase; auto-retry scheduling belongs to Phase 8
  (scheduler policies).
- No URL history is persisted (privacy: old signed URLs are not kept; only counts/timestamps).
- No DRM/paywall circumvention anywhere; recovery only re-acquires sources the user or their
  browser context can legitimately reach.
