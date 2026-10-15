# Phase 6 Report — Segmented multi-connection engine, per-segment journal, integrity

> Status: DELIVERED. Plan: docs/phase-6-plan.md. Contract: v1.1.0 (additive). Rust workspace
> 0.5.0 (unchanged). All seven steps (Plan → Implement → Test → Fix → Document → Review →
> Commit) executed in order; no phase skipped.

## What was built

### 1. Segmented engine (download-core v2)

- **Window planning** (`segments.rs`, pure + unit-tested): a job is split into contiguous
  `[start, end]` windows when the total is known, the server supports ranges, and the file is
  ≥ `MIN_SEGMENT_BYTES` (1 MiB). `N = min(connections_setting, ceil(total / min_segment))`;
  remainder bytes are distributed one-each over the first windows — deterministic and stable
  across runs, which the journal correctness depends on. Fallbacks: unknown total or
  range-less server → one open-ended append window (no Range header is ever sent);
  zero-byte file → empty plan, completed directly.
- **Per-segment tasks**: one tokio task per window, each opening its own file handle and
  writing at `window.start + written`. Writes are **hard-capped at the window end**; server
  surplus is dropped (`over_send` server test proves no overcounting).
- **Integrity gates on every response**: a `206` must report `Content-Range` start exactly
  equal to the requested offset (a lying server fails the job — tested) and a total equal to
  the planned total (a size change triggers a clean restart); `200` on any ranged request
  means the source changed → clean restart (bounded to 2, then fail); `416` → permanent
  `range_not_satisfiable`; 5xx/network errors → bounded retries (3 attempts, linear backoff).
- **Resume safety (Phase 5 semantics preserved)**: part validators are captured before the
  probe and used as `If-Range` on every resuming request. A fresh run persists the probed
  validators *before* segments start, so a crash always leaves provenance on disk.
- **Pause/cancel**: the driver aborts all segment tasks, flushes the in-memory cursors to the
  journal (`finalize_run`) and persists the paused/canceled state. A pause resumes exactly at
  the UI-reported byte count (asserted by test).

### 2. Per-segment journal (dc-storage migration v2)

- New `segments(job_id, seg_index, start_offset, end_offset NULL, written_bytes, status)`
  table; `end_offset NULL` marks append mode. Jobs gain `checksum_algorithm`,
  `checksum_expected`, `checksum_actual`, `checksum_verified`, `segment_count` columns.
- **Durability discipline**: the journal never leads the file. Per-segment cursors are
  persisted after bytes reach the OS (≤1 MiB cadence + on task exit + on pause/cancel), so a
  crash costs at most ~1 MiB of re-download per segment and can never create a hole.
- **v1 part migration**: a Phase 5-era part (bytes + validators, no journal rows) is migrated
  into one window covering the file — the user's existing bytes are preserved, never
  re-downloaded (tested: segment 1 resumes exactly at the migrated cursor).

### 3. Integrity verification (checksums)

- Optional expected checksum at creation: `checksum: { algorithm: sha256|sha1|md5, value }`
  with hex-length validation at every boundary (TS zod + Rust normalize + RPC param parse).
- On completion the engine verifies `Σ written == total`, then streams SHA-256 over the part
  file (256 KiB chunks) and stores `checksumActual`. With an expected checksum present, a
  mismatch fails the job with `checksum_mismatch` and **keeps the part file** for inspection
  (tested); a match sets `checksumVerified = true`. Fsync precedes the atomic rename, so a
  job is never "completed" before its bytes are durable.

### 4. Contracts v1.1.0 (additive)

- `DownloadJob` + `segmentCount` (nullable), `checksumAlgorithm`/`checksumExpected`
  (nullish), `checksumActual` (nullable), `checksumVerified` (nullable boolean).
- Wire rules fixed and pinned by cross-language round-trip fixtures: fields the TS side
  declares `.nullable()` are ALWAYS serialized (null, never omitted); `.nullish()` fields are
  omitted when unset. This also removed a latent Phase 5 divergence on `destinationPath`.
- `download.setConcurrency` accepts optional `maxConnectionsPerDownload` (1..16);
  `settings.maxConnectionsPerDownload` (default 4) added; core reads `SYNTAXDM_MAX_CONNECTIONS`
  at startup and live via the RPC.

### 5. Electron wiring + UI

- `CoreSupervisor` spawns the core with both env knobs; `main.ts` re-applies
  `download.setConcurrency { max, maxConnectionsPerDownload }` at core-ready and on every
  `settings.changed` event (previously the setting was startup-only).
- SettingsPage: "Connections per download" slider (1..16). DownloadsPage: connection-count
  badge while downloading, checksum verdict (verified / mismatch with digest tooltips) using
  Fluent icons.

## Verification (Review gate)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass (0 findings) |
| `cargo test --workspace` | **49 passed, 0 failed** (Phase 5: 25) |
| `npm run typecheck` (contracts + desktop) | pass |
| `vitest` (contracts + desktop) | **60 passed, 0 failed** (Phase 5: 54) |
| `vite build` | pass |

New Rust coverage: planner edges (unknown/no-ranges/zero/small/exact/remainder/caps),
journal CRUD + atomic reset, integrity column round-trips, segmented assembly (4 MiB × 4
connections), segmented pause→resume with journal flush equality, source-change restart of a
segmented run (If-Range history assertion), over-send capping, Content-Range lie, range-less
fallback, checksum success/mismatch, v1-part migration, and a full JSONL RPC e2e with
checksum verification. TS coverage: segmented/legacy fixtures, checksum validation,
setConcurrency extension, settings defaults/range.

Fixed along the way (Fix step): zero-byte/`*`-total Content-Range semantics, append-mode EOF
completion, stop-race in segment tasks (`Stopped` outcome + post-loop guard), test flake in
core.test.ts (rejection handler attached before the clock advances), several clippy findings
(explicit `truncate(false)` on positioned opens, `div_ceil`, iterator lints, dead test code).

## Notes & constraints honored

- No AI features; no placeholders/mocks/TODOs in deliverable code; no DRM circumvention.
- Linux sandbox built and headless-tested everything; Windows GUI execution and the NSIS
  installer remain user-device steps (unchanged from the accepted plan).
- sha2 pinned to 0.11.0 (crates.io max stable, verified 2026-10-07); Digest API confirmed
  compatible with rustc 1.99.0.

## Next

Phase 7 — Recovery engine v2: source re-acquisition, multi-signal revalidation, rebind,
gap-fill. The v2 journal and checksum metadata delivered here are the foundation Phase 7
extends (expired-URL rebinding onto mirror sources, per-range revalidation against
Content-Length/ETag/Last-Modified/Content-Type).
