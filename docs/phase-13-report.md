# Phase 13 Report — Torrent Engine + UI

> Contract **v1.7.0 → v1.8.0 (additive activation)** · Baseline: Phase 12 (`8013c3d`) ·
> Storage migration v7 (`torrent_jobs`) · New crate `dc-bt` · Gate: cargo 223 (+64) ·
> vitest 197 (+20) · typecheck ×4 · vite build — all green.

## What shipped

A native BitTorrent engine inside `download-core` — the end user installs **no torrent
client** (the master spec's bundling rule is satisfied by implementing the protocol in the
Rust core, not by shipping a third-party daemon). Support matrix as planned:

| Element | As built |
|---------|----------|
| Bencode | Own codec; the decoder preserves raw spans so the info-hash is SHA-1 over the exact `4:info…` bytes — never a re-encode |
| Metainfo | v1 single/multi-file; hybrid works via v1; v2-only → classified refusal (`torrent_v2_unsupported`); traversal-proof path sanitization (segments, device names, drive letters) |
| Magnet URIs | `xt=urn:btih` (40-hex or 32-base32), `dn`, `tr` (multi), `xl`; metadata fetched from peers via BEP 9/10 and **verified against the magnet's info-hash before it can name a single file** |
| Trackers | HTTP(S) GET announce + UDP tracker (BEP 15), compact peers (BEP 23) + dict fallback, `interval` respected (≤ 120 s cap), `event=completed` announced |
| DHT | BEP 5 minimal-real: bounded closest-N routing table, ping/find_node/get_peers/announce_peer with token validation (rotating secret, current+previous), iterative get_peers (α=8, ≤ 3 rounds), bootstrap non-blocking |
| Peer wire | BEP 3 handshake + messages, 16 KiB blocks, pipelined requests (8/peer), rarest-first with random tiebreak, on-demand endgame with cross-peer dedup + cancel, per-piece SHA-1 verification **before** any write counts as owned |
| Seeding | Sessions keep running after completion and serve verified pieces; eager unchoke on interest (≤ 4 slots) + rotation |
| Proxy | Phase 9 fail-closed: missing profile → paused (`proxy_profile_not_found`); https-hop → paused (`torrent_proxy_unsupported`); with a proxy attached, peer TCP rides SOCKS5/HTTP-CONNECT and **DHT + UDP trackers are suspended — direct leakage is never an option** |

Lifecycle: `torrent.add/list/get/pause/resume/cancel/remove` (all core-served), throttled
`torrent.progress` (500 ms; byte counts are **verified** bytes only) + authoritative
`torrent.updated`. Status model: `queued → metadata (magnets) → downloading → seeding`,
parking as `paused` / `completed` (a completed torrent pauses as `completed`), `failed`
(piece corruption after 3 retries → `checksum_mismatch`, disk failure → `io_error`),
`canceled` (user cancel). Boot recovery flips `queued/metadata/downloading/seeding →
paused` — a fresh core never auto-starts torrents (the Phase 8 baseline rule).

## Key decisions (as planned → as built)

- **The swarm is the persistent source.** There is no expiring URL to rebind: resume =
  re-announce + re-connect + request only the pieces the persisted have-map still lists as
  missing. The have-map is the integrity authority — `received_bytes` on the wire is
  derived from it at session start, never from a possibly stale counter.
- **Session bodies never cancel their own token.** The first draft's teardown cancelled
  the token inside the body, which raced `run_session`'s select (body-vs-stop) and
  randomly overwrote a just-persisted `seeding` status with `paused`. Restructured: the
  body returns its outcome plus the helper-task handles; `run_session` cancels and drains.
- **Completion is tick-driven.** The 500 ms ticker runs the one-time completion
  transition (`finalize_completion`), so a fast swarm (64 KiB over loopback completes in
  milliseconds) is claimed as `seeding` within one tick, and the session keeps serving.
- **BEP 9 metadata is the bare info dict.** The first draft hashed the whole .torrent
  file; the spec (and every real swarm) exchanges only the `4:info` value. The verified
  dict is wrapped under a canonical `4:info` key into an announce-less metainfo that is
  parsed and persisted verbatim (resume reconstructs everything from the blob).
- **One UDP socket per role.** UDP tracker announces use an ephemeral socket per announce;
  DHT owns the well-known port. No demux needed, and the announced port stays honest.
- **Honest progress.** `received_bytes` counts hash-verified pieces only — the UI can
  never show bytes the swarm did not prove.

## Fixed during Test/Fix

- `decode_top_with_span` recorded the info span but returned `None` unconditionally —
  the info-hash would have been minted wrong for every torrent (found via a scratch
  binary; the fixture hash comparison in tests would not have caught it).
- `Message::KeepAlive.encode()` produced zero bytes (writes nothing) instead of the
  4-byte zero-length frame — keep-alives were invisible on the wire.
- Peer driver: the responder re-read a handshake the acceptor had already consumed
  (inbound peers starved until the read timeout). Responder now answers immediately;
  self-connections are dropped at the acceptor by peer-id.
- `DhtNode::get_peers` drained `..ALPHA` from a possibly shorter vec (panic on small
  tables); `fresh.drain(..ALPHA.min(len))`.
- std `Mutex` deadlock: the Interested handler re-locked `shared.peers` while holding the
  guard — restructured into a single-lock decision + a second short lock for the send.
- Peer in-flight blocks were never released on Piece arrival (downloads stalled after the
  first pipeline window); released per-peer on arrival, on disconnect, and by the 45 s
  stale-request sweep.
- UDP tracker client read the connect/announce reply fields at wrong offsets (action vs
  txn echo) — corrected per BEP 15 layout; transaction echoes now validated both ways.
- The magnet's `btih` hex path silently accepted a 40-char base32 string as hex (`0xAA…`);
  magnet parsing keeps hex/base32 strictness tests.
- Peer-id prefix is 8 chars (`-UN0100-`), not 7 — `copy_from_slice` caught it immediately.
- Rust wiring details: `EventsTx`/`ProxyMap` clones in `JobManager::new`; `MutexGuard`
  held across await in `remove`/`send_stop` (clone-then-await); borrow conflicts in
  `FileWriter::write_piece`/`read_range`; `TorrentSourceKind::as_str` for rusqlite.

## Verification gate

| Check | Result |
|-------|--------|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo test` | **223 passed** (was 159; +13 dc-bt lib units … +46 dc-bt total, +4 dc-storage, +4 dc-protocol, +7 download-core torrent integration) |
| `vitest` (contracts + desktop) | **68 + 129 = 197 passed** (was 61 + 116; +7 contracts, +13 desktop) |
| `npm run typecheck` (×4 configs) | clean |
| `npm run build:desktop` | green |

Integration coverage (fake swarm over real sockets — HTTP tracker, UDP tracker, seeder
with optional BEP 9 metadata, throttled seeder, leecher): `.torrent` completes with
byte-identical output; magnet → verified metadata → download → seeding; pause mid-download
→ **core restart over the same DB** → resume → the seeder never sees a re-request for a
verified piece; completed torrent seeds to a leecher (uploaded counters persist); UDP
tracker announce feeds the swarm; v2-only/invalid base64/broken bencode/dual-source
classified refusals; proxy fail-closed pause (`proxy_profile_not_found`); magnet metadata
timeout → paused + `torrent_metadata_timeout` → resume re-enters the metadata phase.

## Out of scope (later phases)

MSE encryption, uTP (BEP 29), PEX (BEP 11), per-file priorities, v2-only merkle torrents,
per-job torrent bandwidth caps (the Phase 8 token bucket stays HTTP-only), NAT/port
forwarding (the peer port is ephemeral), and browser-integrated magnet capture — all
documented in the plan and surface honestly (no silent degradations).
