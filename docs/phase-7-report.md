# Phase 7 Report — Recovery engine v2 (source re-acquisition, multi-signal revalidation, rebind, gap-fill)

> Status: DELIVERED. Plan: docs/phase-7-plan.md. Contract: v1.2.0 (additive). Rust workspace
> 0.6.0. All seven steps (Plan → Implement → Test → Fix → Document → Review → Commit) executed
> in order; no phase skipped.

## What was built

### 1. Multi-signal revalidation (`download-core/src/recover.rs`, pure + unit-tested)

- `SourceSignals { totalBytes, etag, lastModified, contentType }` and `RevalidateVerdict`
  (`Identical` / `ChecksumArbitrated` / `Restart`) with the documented decision matrix:
  1. equal ETag (weak-marker tolerant) → `Identical` — the strongest identity signal; a lying
     ETag is still caught later by the 206 Content-Range total gate;
  2. equal Last-Modified + equal size → `Identical`;
  3. known sizes differ → `Restart`;
  4. media-type **kind** (before `;`, case-insensitive) differs → `Restart` (the classic
     expired-URL-now-serves-an-HTML-login-page trap);
  5. known sizes equal, identity unproven → `ChecksumArbitrated` when the job carries an
     expected checksum, else `Restart` (no proof → integrity outranks bytes);
  6. sizes unknown without identity signals → `Restart`.
- `classify_source_failure(status)`: 404/410 → `source_gone`, 401/403 → `source_forbidden`,
  else `http_error` — dead/expired sources now fail with actionable codes.

### 2. Engine integration (drive-loop revalidation, `engine.rs`)

- The full part provenance (validators **plus** size and content type) is captured before the
  probe overwrites the row. Every run that resumes written bytes revalidates first:
  - `Identical` → the Phase 6 If-Range resume, unchanged;
  - `ChecksumArbitrated` → journal kept (equal size ⇒ equal plan), segments run **without
    If-Range** (the part's validators differ from the fresh source by definition); any
    200-on-ranged still hits the bounded clean-restart path and the completion checksum
    arbitrates the mixed-provenance file;
  - `Restart` → journal + part wiped **pre-flight** (no transfer against a stale source —
    two Phase 6 tests updated: the stale validator must never be presented), bounded by the
    same restart budget.
- The old unconditional "unprovable part" discard is replaced by the matrix: a part without
  validators can now be kept under checksum arbitration, never without proof.
- Restart-budget exhaustion and repeated source changes now fail with `source_changed`
  (was generic `http_error`) so the UI can offer recovery.
- A job that previously failed `checksum_mismatch` is always restarted clean on recovery —
  known-bad bytes cannot be rehabilitated by signals.

### 3. Recovery cycle + rebind (`Engine::recover`, `JobManager::recover` / `replace_url` / `retry`)

- `download.recover { id }`: re-probes the current URL. Probe failure persists the classified
  error and the call still succeeds (the outcome is data, not an RPC fault). On a live source:
  revalidate → `Identical`/`ChecksumArbitrated` rebind (persist fresh signals,
  `recoveryCount += 1`, `reboundAt = now`, clear error, requeue) or `Restart` (wipe journal +
  part, rebind onto the fresh source, requeue). The pump gap-fills on the next run.
- `download.replaceUrl { id, url }`: rebinds a dead/expired source to a new URL; bytes and
  journal untouched; http(s)-only (`url_invalid` otherwise, mirrored in the TS schema via
  `HttpUrl = z.url({ protocol: /^https?$/ })`); rejected for active/completed jobs.
- `download.retry { id }`: requeue failed/canceled/paused (same path as resume — distinct UI
  verb). Deliberately deferred, documented: `download.start` (create auto-pumps; resume/pump
  cover every entry) and `download.openFolder` (Electron-main shell concern, downloads-library
  phase).
- New job fields (always serialized, nullable): `recoveryCount`, `reboundAt`.

### 4. Contracts v1.2.0 (additive) + storage v3

- Error codes appended: `source_gone`, `source_forbidden`, `source_changed` (both languages,
  append-only).
- `download.recover` / `download.replaceUrl` / `download.retry` registered in `METHODS` with
  zod schemas; `HttpUrl` pins the protocol rule at every boundary.
- Fixtures: `recoveryCount`/`reboundAt` round-trip (null legacy + set recovered variant),
  validated on both vitest and `cargo test`.
- dc-storage migration v3: `recovery_count`, `rebound_at` columns with full read/write wiring
  (migration-version test tightened to ≥ 3).

### 5. Electron + renderer

- `domains/download.ts` proxies the three new methods (router-validated, defense in depth).
- Downloads store: `recover` / `replaceUrl` / `retry` actions (recover upserts the returned
  job — the outcome is data).
- DownloadsPage: failed/canceled/paused rows gain **Recover** (re-acquire) and **Replace
  URL…** (Fluent Dialog with a URL input) actions; failed rows show a per-code recovery hint
  (`source_gone` → "Source expired or gone — try Recover, or paste a fresh/mirror URL", etc.);
  a `recovered ×N` badge renders the audit trail; the old Restart button on failed rows now
  calls `download.retry`.

## Verification (Review gate)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass (0 findings) |
| `cargo test --workspace` | **74 passed, 0 failed** (Phase 6: 49) |
| `npm run typecheck` (contracts + desktop) | pass |
| `vitest` (contracts + desktop) | **65 passed, 0 failed** (Phase 6: 60) |
| `vite build` | pass |

New Rust coverage: the revalidation matrix (12 unit cases incl. ETag-equal-with-lying-length,
weak ETag markers, media-type kind traps, checksum arbitration both ways), probe-failure
classification, and nine integration scenarios — expired-URL resume preserves part + journal
byte-exactly and fails `source_gone`; `recover()` after an outage rebinds and requests only
ranges ≥ the kept prefix (asserted via the server's request log) and stamps `recoveryCount`;
`recover()` against a still-dead source keeps the classified failure; `replaceUrl` completes
from a mirror on kept bytes; non-http(s) schemes and completed jobs are rejected;
checksum-arbitrated honest gap-fill completes without a single If-Range header and verifies;
the same-size lying server is caught by the checksum verdict with the part kept for
inspection; the checksum-less changed source restarts clean (pure v2 bytes); 403 classifies
`source_forbidden`; and the full JSONL RPC e2e (`recover` → still-failed, `replaceUrl` →
completed with audit trail, terminal-state rejections).

Fix step findings: the two Phase 6 source-change tests asserted the old mechanism (If-Range
presented, then 200-restart) — under Phase 7 the revalidation verdict fires pre-flight, so
the assertions were updated to the stronger invariant (the stale validator is never
presented; the final file is pure v2). The initially drafted arbitration test was split into
honest-re-acquisition (completes, verified) vs lying-server (fails, part kept) after review
showed a mixed-provenance file can only verify when the source really serves the same bytes.

## Notes & constraints honored

- No AI features; no placeholders/mocks/TODOs in deliverable code; no DRM/paywall circumvention
  — recovery only re-acquires sources the user or their browser context can legitimately reach.
- `recover()` probes inline (bounded by the engine's 20 s connect timeout; the CoreClient RPC
  timeout is 30 s). No background auto-retry in this phase — scheduling policies are Phase 8.
- No URL history is persisted (privacy): only the count and timestamp of rebinds.
- Linux sandbox built and headless-tested everything (toolchain reinstalled after another
  sandbox reset: rustc 1.99.0 / rustfmt 1.10.0 / clippy 0.1.99); Windows GUI execution and the
  NSIS installer remain user-device steps.

## Next

Phase 8 — Queue, scheduler policies, concurrency and bandwidth management.
