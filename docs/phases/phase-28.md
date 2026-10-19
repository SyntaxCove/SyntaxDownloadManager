# Phase 28 — Data-Integrity Validation Sweep (Report)

> Scope: `docs/PHASES.md` line 28 — "Data-integrity validation sweep — checksum/recovery
> deep verification". Plan: `docs/phases/phase-28-plan.md`. No features added; the phase
> attacked the phases-5/6/7/24/25 integrity machinery with the adversarial cases no earlier
> suite covered, fixed everything that fell out, and locked the fixes with tests.

## What the sweep found — four real defects, all fixed

- **F-1 — journal claims bytes nothing on disk proves (zero-hole splice).** The run start
  trusted the segment journal unconditionally: with the `.part` deleted or truncated
  externally, the engine re-created the part sparse / extended it and resumed at the journal
  cursors — the claimed ranges were zeros, and without an expected checksum the job
  **completed corrupt**. Reachable by: pause → delete the `.part` → resume.
  Fix: `reconcile.rs` — a pure, exhaustively-table-tested decision function run before the
  part is touched. The journal may only claim bytes some on-disk file proves; everything
  else is re-downloaded (append mode clamps a leading cursor to the provable length instead
  of discarding the whole part).
- **F-2 — crash between the completion rename and the status update (phantom journal).**
  `complete()` renames the part, then updates the row. A crash in the gap left a completed
  file on disk with an all-done journal and a job still running; resume re-uniquified the
  destination (`name (2)`), re-created an empty part, marked every segment done at its
  cursor and hashed an all-zero file — completing corrupt without an expected checksum.
  Fix: the destination of a resumed job is bound to its persisted `destination_path` (no
  re-uniquify), and when the part is missing but a size-verified (and, with an expected
  checksum, hash-verified) final file exists, the engine **adopts** it — records the
  verification, marks completed, drops the journal rows, zero bytes downloaded. A corrupt
  artifact is refused and re-downloaded; the suspect file is never destroyed.
- **F-3 — journal durability gap (power loss vs. "the journal never leads the file").**
  Cursors were persisted after `flush()` (page cache), not `fsync`: power loss could drop
  bytes a persisted cursor already claims — the same zero-hole class as F-1, triggered by
  power. Fix: `sync_data()` before every journal advance — the periodic ≤1 MiB flush, the
  per-segment done mark, every stop path, and one file-level sync in `finalize_run` before
  cursors are persisted. Cost: one fsync per ~1 MiB per segment.
- **F-4 — sha1/md5 expectations could never pass.** `create_job` accepted `sha1`/`md5`
  checksums (validated at their own hex lengths) but `complete()` always computed SHA-256
  and compared that digest against the expectation — **every honest sha1/md5 download failed
  with `checksum_mismatch`**. Fix: the verdict (and `checksum_actual`) now hashes with the
  job's declared algorithm; `hash_file_streaming()` is shared by the completion pass and the
  adoption path. Contract shape unchanged (`checksumActual` remains a hex string; the
  dc-protocol and TS doc comments now say "digest in the job's algorithm").

Torrent: the piece SHA-1 rejection machinery existed (`PIECE_MAX_FAILURES`, picker
re-queue, typed `checksum_mismatch` surrender) but no test had ever served a corrupt piece.
The fake seeder gained a per-piece corruption budget and two drills lock the behavior.

## Test inventory

- `src/reconcile.rs` — 7 unit tests including a full cross-product sweep of the decision
  table (part/final existence × size × checksum × journal claims) asserting adoption never
  happens without a re-checkable proof.
- `tests/integrity.rs` (new, 11): part deleted between runs (segmented + append) → clean
  re-download, byte-identical; part truncated below the journal → clamp/restart, never a
  zero hole; tampered journal beyond the part → not trusted; crash-after-rename adoption
  with expected checksum → completed with probe-only traffic, hash re-verified, no `name
  (2)` drift; adoption without checksum on size proof; adoption refuses a corrupt artifact
  and re-downloads while never deleting the suspect file; bit-rot in a paused part → typed
  `checksum_mismatch`, part kept; live journal-never-leads-part sampler across a throttled
  run; sha1+md5 expectations honored (the F-4 regression lock); wrong md5 fails typed.
- `tests/torrent.rs` (+2): corrupt-piece-once → hash rejection, picker re-queue, honest
  re-serve, byte-identical payload, re-fetch proven by the serve log; always-corrupt piece →
  job fails typed `checksum_mismatch` after the bounded retries.

## Verification

- `verify-all.sh` green with Rust on PATH: **118 contracts + 376 desktop (vitest) + 300
  cargo** (280 prior + 7 reconcile + 11 integrity + 2 torrent), renderer budget gate
  (1,146,759 / 1,200,000 B), checksums selftest (6 checks), `cargo fmt --check` clean,
  `cargo clippy -D warnings` clean. Log: `tool-results/verify-all-p28.log`.
- The 20 Phase-25 E2E suites ran against the rebuilt debug `download-core` binary containing
  all Phase-28 engine changes — no behavioral regressions.
- Contract 1.15.0 untouched (no wire change; doc-comment-only clarifications).

## Honest scope notes

- Bit-rot inside a sparse region without an expected checksum is undetectable by
  size-based reconciliation — the expected checksum is the designed defense (documented in
  the plan and the in-app help).
- Real power-loss testing is impossible in this sandbox; F-3 is enforced by code review and
  the live sampler test (process-level proxy for the page-cache discipline).
- Release artifacts (v0.15.0) are produced by the Phase 26 pipeline; supply-chain/SBOM is
  Phase 30.
