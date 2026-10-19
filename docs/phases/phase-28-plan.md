# Phase 28 — Data-Integrity Validation Sweep (Plan)

> Authoritative scope (docs/PHASES.md line 58): **"Data-integrity validation sweep —
> checksum/recovery deep verification"**. Engineering priority: data integrity outranks
> everything. This phase does not add features; it attacks the integrity machinery built in
> phases 5/6/7/24/25 with the adversarial cases the earlier suites did not cover, fixes what
> falls out, and locks the fixes with tests.

## 1. Audit findings (read line-by-line before writing any test)

Re-read `engine.rs` (1770 lines), `recover.rs`, `segments.rs`, `manager.rs`, `dc-storage`
and the existing suites (`engine`, `recover`, `server`, `torrent`). The core rules hold: the
206 Content-Range gates, the window write cap, If-Range provenance, fail-closed revalidation,
checksum-mismatch part preservation, fsync-before-rename, WAL+FULL storage. Three real defect
classes survive outside that coverage:

- **F-1 — journal claims bytes nothing on disk proves → zero-hole splice.** The run start
  trusts the segment journal unconditionally. If the `.part` is deleted or truncated
  externally (user cleanup, disk cleaner, crash with lost page-cache writes) the engine
  re-creates the part sparse / extends it with `set_len` and resumes at the journal cursors —
  the claimed ranges are zeros. Without an expected checksum the job completes corrupt.
  Reachable today: pause a download, delete the `.part`, resume. The final hash pass covers
  holes only when a checksum was supplied.
- **F-2 — crash between rename and status update → phantom all-done journal.** `complete()`
  renames the part to the final path, then updates the job row. A crash in between leaves a
  completed file on disk with a journal that says "all segments done" and a job still marked
  running. On resume the destination is re-resolved (uniquified to `name (2)`), the part is
  re-created empty, every segment reports done at its cursor, and the engine hashes an
  all-zero file — completing corrupt when no expected checksum exists.
- **F-3 — journal durability gap.** Cursors are persisted after `file.flush()` (page cache),
  not `fsync`. A power loss can drop bytes the journal already claims — the same zero-hole
  class as F-1, triggered by power rather than a user. The phase-6 guarantee "the journal
  never leads the file" is only honest if data is durable before the cursor advances.

Torrent: piece SHA-1 verification, failure-bounded re-fetch and the typed
`checksum_mismatch` surrender exist and are sound, but **no test ever serves a corrupt
piece** — the corruption paths are unexercised code.

## 2. Design

### 2.1 Pure reconciliation module (`src/reconcile.rs`, new)

A total decision function over on-disk facts; the engine applies the verdict, the unit tests
own the table:

```text
ReconcileFacts { journal_written_total, part_exists, part_len, final_exists,
                 final_len, total_bytes (None = open-ended append mode),
                 has_expected_checksum, expected_matches (Option<bool>) }

part exists:
  offset mode (total known):  journal > part_len OR journal > total → ResetJournal
                              else                                   → Proceed
  append mode (total unknown): journal > part_len                     → ClampToPart(part_len)
                              else                                    → Proceed
part missing:
  final exists:
    total known && final_len != total        → ResetJournal   (size never verified)
    expected present && !matches             → ResetJournal   (hash refuses the file)
    total known && size ok                   → AdoptFinal     (pre-crash run size-verified)
    total unknown && expected matches        → AdoptFinal     (hash proven)
    total unknown && no expected             → ResetJournal   (fail-closed: unprovable)
  final missing                              → ResetJournal   (bytes gone)
```

Rationale: adoption is only allowed when the pre-crash `complete()` verified the artifact by
a signal we can re-check now (size in offset mode, hash when an expected checksum exists).
Everything else is re-downloaded — integrity outranks bytes.

### 2.2 Engine wiring (`engine.rs`)

- Reconciliation runs after Phase-7 provenance revalidation, before the part file is
  pre-sized. `ResetJournal` wipes journal rows and restarts the plan fresh;
  `ClampToPart` rewrites the (single) append cursor to the provable length; `AdoptFinal`
  hashes the final file, records `checksum_actual` / `checksum_verified`, marks the job
  completed and deletes the segment rows.
- **Destination rebinding fixed**: a resumed job with a persisted `destination_path` reuses
  that exact path (the part is bound to it) instead of re-uniquifying to `name (2)`.
- **F-3 fsync discipline**: `sync_data()` before every journal cursor persistence — the
  periodic ≤1 MiB flush, the per-segment "done" mark, every stop path, and `finalize_run`
  (one file-level sync before cursors are written). Cost: one fsync per ~1 MiB per segment,
  the standard journaling trade-off.
- `hash_file_streaming()` extracted from `complete()` and shared with the adopt path.

### 2.3 Torrent corruption drill (fixture toggle, no engine change)

The fake seeder gains a per-piece corrupt-serve budget. Two drills:
- corrupt the first serve of one piece → hash fails once, picker re-queues, honest re-serve
  verifies → completion is byte-identical (re-fetch path proven);
- corrupt every serve of one piece → `PIECE_MAX_FAILURES` reached → job fails typed
  `checksum_mismatch` with the payload preserved.

### 2.4 Adversarial suite (`tests/integrity.rs`, new)

Byte-identity asserted on every completion via SHA-256 against the served body:

1. part deleted between runs (offset mode) → clean re-download, byte-identical;
2. part deleted between runs (append mode) → same;
3. part truncated below the journal cursor (append) → clamped, byte-identical;
4. tampered journal beyond the part size → reset, byte-identical;
5. crash-after-rename adoption with expected checksum → completed with **zero** HTTP
   requests (no re-download), checksum_verified recorded;
6. same without expected checksum → adopted on size proof, byte-identical;
7. adoption refusal: corrupt final + expected checksum → hash mismatch → clean re-download;
8. bit-rot inside a paused part + expected checksum → completion fails
   `checksum_mismatch`, part kept, job recoverable;
9. journal-never-leads-disk sampled live: during a throttled run the persisted cursor is
   always ≤ the part file length (append mode);
10. resume after crash-mid-completion reuses the destination path (no `name (2)` drift).

### 2.5 Verification gate

`verify-all.sh` must stay green: contracts 118 + desktop 376 + cargo (280 + new), budget
gate, checksums selftest, fmt/clippy clean. Version 0.14.0 → 0.15.0 everywhere; contract
1.15.0 untouched (integrity behavior is not a wire change).

## 3. Honest scope notes

- Bit-rot inside a sparse region without an expected checksum is undetectable by size-based
  reconciliation — the expected checksum is the designed defense and the docs say so.
- Real power-loss testing is impossible in this sandbox; the fsync discipline is enforced by
  code review + the live journal-leads-disk sampling test (process-level proxy).
- Media mux output verification and supply-chain/SBOM belong to their own phases (12 / 30).
- The Windows GUI behaviors (delete-while-running shell interactions) are user-device
  validation; the sweep proves the engine contract at process level.
