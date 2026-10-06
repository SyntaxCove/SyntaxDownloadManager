# Phase 1 — packages/contracts v1 (delivered)
**Plan**: single source of truth for every boundary type. zod 4 schemas; epoch-ms timestamps;
ULIDs (Crockford, monotonic, mirrored later in Rust); string error codes; protocol v1 envelopes
(request / success / error / event, JSONL over stdio); method registry (core.*, download.*,
browser.*, settings.*) and event registry; media/proxy/torrent/scheduler shapes declared
contract-first for later phases. Cross-language JSON fixtures shared with cargo tests.
**Test**: 12 vitest cases — ULID monotonicity/sort/normalize, fixture parsing, negative parsing,
envelope round-trips, registry integrity, version export.
**Fix**: fixture tab ID ended in `U` (not Crockford) — caught by test, fixed fixture.
**Result**: commit `1d95ed1`. CONTRACT_VERSION=1.0.0, PROTOCOL_VERSION=1.
