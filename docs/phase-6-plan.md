# Phase 6 Plan — Segmented multi-connection engine, per-segment journal, integrity (checksums)

> Status: PLAN (approved for execution per phase protocol). Scope source: docs/PHASES.md #6.
> Predecessor: Phase 5 delivered a single-stream resumable engine (`.part` append model,
> If-Range restart-from-zero guard, SQLite persistence, supervised lifecycle).

## Goal

Upgrade the engine so that a job whose source supports HTTP ranges is downloaded by **N
parallel range connections**, with a **durable per-segment journal** (crash/pause resumes at
segment granularity, not whole-file), and **end-to-end integrity verification** (size check +
streaming SHA-256, compared against an optional user-supplied expected checksum).

Non-goals (later phases): mirror/source re-acquisition (Phase 7), bandwidth throttling and
queue policies (Phase 8).

## Design

### Two write modes (unified under one segment model)

- **Mode A — append (single stream)**: unknown total or server without `Accept-Ranges`.
  One window `(start=0, end=NULL)`; part file grows by append; resume = `Range: bytes=N-`
  with `If-Range` (Phase 5 semantics), journal tracks `written`.
- **Mode B — segmented (offset writes)**: total known AND ranges supported AND
  `total >= MIN_SEGMENT_BYTES` (1 MiB). Part file is pre-sized with `set_len(total)` (sparse);
  each window writes at `start + written` and is **hard-capped at its window end** (bytes
  beyond the window are never written, whatever the server sends). `received = Σ written`.

### Segmentation policy (pure function `plan_segments(total, ranges, max_conn, min_seg)`)

- `N = min(max_conn, ceil(total / min_seg))`, at least 1; contiguous windows, remainder
  bytes distributed one-each to the first `total % N` windows; last end = `total - 1`.

### Per-segment journal (dc-storage migration v2)

- New table `segments(job_id, seg_index, start_offset, end_offset NULL, written_bytes,
  status)` PK `(job_id, seg_index)`; `end_offset NULL` ⇒ Mode A.
- Jobs table gains nullable columns `checksum_algorithm`, `checksum_expected`,
  `checksum_actual`, `checksum_verified`, `segment_count`.
- Journal discipline: a segment's `written` is **always ≤ bytes actually on disk** (updated
  after the file write completes, flushed at ≤1 MiB deltas and on task exit) so a crash can
  only ever cause re-download of a small tail, never a hole.

### Per-segment connection loop (integrity guards)

- Request `Range: bytes={start+written}-{end}` **with `If-Range` = the part-file validators**
  (persisted before segments start; first run has none → clean start).
- `206`: parse `Content-Range`; `start` must equal the requested offset and the reported
  total must equal the planned total, else the source lies/changed → fail / restart.
  Stream chunks, cap at window end, journal every ~1 MiB; short stream → bounded retries
  (3 attempts, linear backoff) re-probing `written` from the journal each attempt.
- `200` on a ranged resume ⇒ source changed ⇒ **global restart**: cancel all segments, wipe
  journal, truncate part, re-probe, re-plan (bounded to 2 restarts, then fail).
- `416` ⇒ permanent failure `range_not_satisfiable`.
- Completion: all windows done ⇒ verify `Σ written == total` ⇒ streaming SHA-256 of the part
  file ⇒ persist `checksum_actual`; if `checksum_expected` present and mismatched ⇒
  `failed` + `checksum_mismatch` (part file kept for inspection); else fsync + atomic
  `.part` → final rename ⇒ `completed` (+ `checksum_verified` when compared).

### Contracts v1.1.0 (additive; protocol envelope unchanged)

- `DownloadJob` + optional nullable `checksumAlgorithm`, `checksumExpected`, `checksumActual`,
  `checksumVerified` (boolean), `segmentCount` (int ≥ 1).
- `DownloadCreateParams` + optional `checksum: { algorithm: sha256|sha1|md5, value }`
  (hex length validated: 64/40/32).
- `settings` + `maxConnectionsPerDownload` (1..16, default 4); `download.setConcurrency`
  params gain optional `maxConnectionsPerDownload`; core reads `SYNTAXDM_MAX_CONNECTIONS`.
- Fixtures: add a segmented `downloadJobSegmented` fixture consumed by vitest + cargo.

### Wiring

- CoreSupervisor gains `maxConnectionsPerDownload` (env + re-apply when settings change);
  main.ts passes the new setting; SettingsPage gets a connections slider; DownloadsPage gets
  a connections chip and checksum verdict (Fluent icons, no emoji).

## Test plan

- Rust unit: window planner edges (unknown/no-ranges/small/exact/remainder/cap), checksum
  hex validation, digest hex encoding.
- dc-storage: migration v2, segment replace/list/update round-trips, job column round-trip.
- Engine integration (local HTTP server): segmented assembly equals source bytes; pause
  mid-download → journal shows partial segments → resume completes; If-Range restart wipes
  journal; writes capped at window end against an over-sending server; Content-Range lie →
  fail; checksum match → `checksum_verified`; checksum mismatch → `checksum_mismatch` with
  part kept; no-range fallback; spawned-binary e2e with checksum verification.
- TS vitest: v1.1 fixtures (new + legacy backward compat), settings default/patch,
  setConcurrency params, create params with checksum.

## Verification gate (Review step)

`npm run typecheck` · `npm test` (vitest, all workspaces) · `cargo fmt --check` ·
`cargo clippy -- -D warnings` · `cargo test` · `vite build` — all green before commit.
