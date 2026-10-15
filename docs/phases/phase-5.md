# Phase 5 — Rust Core v1: Supervised Resumable Download Engine (delivered)

## Plan
`download-core` is a supervised Rust subprocess owning the SQLite database. Boundaries:
- **Wire**: JSONL envelopes (protocol v1) over stdio; stdout carries only protocol traffic,
  stderr carries logs. Requests validated on both ends (TS zod + serde types).
- **Crates**: `dc-protocol` (wire types + ULID, mirrors packages/contracts), `dc-storage`
  (rusqlite bundled, WAL + synchronous=FULL, ordered migrations), `download-core` (engine,
  manager, stdio server).
- **Engine v1** (single stream, resumable): probe via `GET Range: bytes=0-0` captures
  size/ETag/Last-Modified/Content-Type/accept-ranges; resume sends `Range: bytes=N-` **with
  `If-Range: <part validator>`**; a 200 answer (source changed) truncates the part and
  restarts from zero — never splices foreign bytes (data integrity > speed). Completion
  fsyncs, then atomically renames `.part` → final (auto-uniquified). Progress persisted
  every 500ms; header set persisted for faithful resume.
- **Manager**: at most N tasks (user's parallel-downloads setting via
  `download.setConcurrency`), queued jobs pumped as slots free; pause/cancel/resume
  transitions validated against job status; failures map to typed contract error codes
  (network_error/http_error/range_not_satisfiable/io_error/disk_full/…).
- **Supervisor (main)**: spawn with SYNTAXDM_DB/SYNTAXDM_MAX_CONCURRENT, exponential backoff
  restart (500ms→15s, give up after 8 consecutive failures, healthy stretch resets streak),
  `core.state` events to the renderer, graceful stop (shutdown request → SIGTERM → SIGKILL).
- **Renderer**: Downloads page — create-by-URL (save dir from settings), live progress bars
  with speed/ETA, pause/resume/cancel/remove, engine-state banner; events-only state flow.

## Test (all green)
- **Rust 25 tests**: ULID validity/monotonicity; envelope round-trips; **cross-language
  fixtures** (Rust must deserialize TS fixtures and re-serialize byte-identical JSON);
  migrations + job CRUD + reopen durability; **engine integration against a real local HTTP
  server**: fresh download byte-exact + rename, resume-from-20000 appends only the missing
  range, **source-change integrity (If-Range mismatch → stale part discarded, pure new
  content)**, pause mid-stream → persisted → resume completes, dead-URL → network_error;
  protocol server over duplex streams (ping/parse_error/method_not_found/unsupported_version/
  invalid_params/create+list+failure observability) and **spawned-binary end-to-end**
  (core.ready + pong over real stdio).
- **TS 54 tests total (42 desktop)**: backoff policy matrix; CoreClient framing at the stream
  level (id matching, typed error rejection, request timeout, event payload validation with
  drop policy, stream-close rejection of inflight); supervisor unavailable-state + binary path
  resolution; download domain registration; settings/browser/url-input suites from Phases 2–4.
- fmt + clippy (`-D warnings`-level clean) + typecheck across all three tsconfigs.

## Fix (found by tests — exactly why they exist)
1. Fixture job ID ended in `U` (not Crockford) — Phase 1 fixture bug surfaced by ULID validation.
2. `speedBps` serialized as float in Rust vs int in TS → both sides pinned to integers.
3. **If-Range must carry the PART's validators, not freshly probed ones** — the first
   implementation overwrote validators before building the resume request, which would splice
   bytes from a changed source. Test asserted the wire request and forced the fix.
4. reqwest 0.13 renamed `rustls-tls`→`rustls`; tokio needed `io-std`; Electron 44
   `navigationHistory.canGoBack()` is a method.

## Result
Commits `phase(5)`. Headless-verified end-to-end at the process level; GUI verification
(Downloads page driving the real core, browser downloading from the web) runs on the user's
Windows device. Contract additions this phase (unreleased v1): headers/destinationDir/filename
on DownloadJob, `browser.setViewportBounds`, `download.setConcurrency`, `core.state` event.
