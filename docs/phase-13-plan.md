# Phase 13 Plan — Torrent Engine + UI

> Baseline: Phase 12 (`8013c3d`), contract v1.7.0, storage v6, cargo 159 / vitest 177.
> Gate target: cargo fmt/clippy clean, cargo test ≥ 159 + new suites, vitest ≥ 177 + new,
> typecheck ×4, vite build — all green before commit.

## Scope (from docs/PHASES.md: "Torrent engine + UI")

A native Rust BitTorrent engine inside `download-core` — the end user installs no torrent
client (the master spec's bundling rule is satisfied by implementing the protocol natively,
not by shipping a third-party daemon). Support matrix for this phase:

| Element | Decision |
|---------|----------|
| Bencode | Own codec (decoder preserves raw spans so the info-hash is computed over the exact `4:info…` bytes) |
| Metainfo | v1 single-file + multi-file; hybrid (v1+v2) works via the v1 path; v2-only → classified refusal |
| Magnet URIs | `xt=btih` (40-hex or 32-base32), `dn`, `tr` (multi), `xl`; metadata fetched from peers via BEP 9/10 |
| Trackers | HTTP(S) GET announce + UDP tracker (BEP 15), compact peers (BEP 23) + dict fallback, reannounce on `interval` |
| DHT | BEP 5 minimal-real: k-buckets (K=8), ping/find_node/get_peers/announce_peer, token store, bootstrap; shares the UDP socket with the UDP tracker client through a packet demux |
| Peer wire | BEP 3 handshake + messages, 16 KiB blocks, pipelined requests, rarest-first (random tiebreak), endgame dedup + cancel, per-piece SHA-1 verify |
| Seeding | Serve verified pieces; simple unchoke (round-robin + optimistic) |
| Proxy | Phase 9 fail-closed: profile attached → HTTP(S) trackers + peer TCP via proxy (SOCKS5 CONNECT implemented natively); **DHT + UDP trackers are suspended while proxied (never leak direct)**; missing profile → paused (`proxy_profile_not_found`) |
| Out of scope (documented) | MSE encryption, uTP (BEP 29), PEX (BEP 11), per-file priorities, v2-only merkle trees, torrent bandwidth caps (Phase 8 token bucket stays HTTP-only) |

## Deliverables

1. **Contracts v1.7.0 → v1.8.0 (additive activation)** — the Phase-1 `torrent.ts` stub had
   zero consumers (no methods/events/UI), so extending it is classified additive; the stub's
   `TorrentStatus` enum is preserved and gains `canceled`. `TorrentJob` grows: `infoHash`,
   `sourceKind`, `destinationDir`, `uploadedBytes`, `numPieces`, `pieceLength`, `files`,
   `errorCode`, `proxyProfileId` (`name` becomes nullable until metadata/dn resolves).
   7 core methods: `torrent.add/list/get/pause/resume/cancel/remove`. Events:
   `torrent.progress` (throttled ~500 ms) + `torrent.updated` (authoritative). 3 append-only
   error codes: `torrent_invalid_metainfo`, `torrent_v2_unsupported`,
   `torrent_metadata_timeout`. Fixtures: `torrentJob`, `torrentProgress` (Crockford ULIDs)
   with byte-parity tests on both sides. `dc-protocol/src/torrent.rs` mirrors the wire.
2. **New crate `dc-bt`** (core/crates/dc-bt) — protocol library, no Electron/DB deps:
   bencode, metainfo, magnet, tracker client (HTTP+UDP), peer wire + extended handshake +
   ut_metadata, piece picker + assembler, SOCKS5 CONNECT client (own code, no new dep),
   DHT node. Workspace gains pinned `sha1 = 0.11` and `rand = 0.10` (versions verified via
   `cargo search` this session).
3. **Storage migration v7** — `torrent_jobs` table (source kind/uri, metainfo blob, have
   bitmap blob, files/trackers JSON, counters, error, proxy profile id) + CRUD + boot
   recovery reset (active → paused; a fresh core never auto-starts torrents).
4. **download-core** — `torrent_manager.rs`: one TCP listener + one UDP socket (packet demux
   tracker-vs-DHT), per-torrent session tasks, pump (≤ 3 active), 500 ms ticker (persist +
   throttled events), runner-ack pause/cancel, piece-verify → `checksum_mismatch` after
   bounded retries, path-traversal-proof file naming (security), magnet metadata timeout
   budget → classified code. `JobManager` integration + `server.rs` arms.
5. **Electron main** — `domains/torrent.ts` thin validated proxy (events already forwarded
   globally by the download domain).
6. **Renderer** — `stores/torrent.ts` (authoritative snapshots + progress patches, full
   lifecycle), `TorrentsPage.tsx` (add via magnet URI textarea or `.torrent` file picker
   base64 ≤ 8 MiB, destination dir from settings, optional proxy profile; job list with
   progress, speeds, peers/seeds, pause/resume/cancel/remove + delete-files), AppShell nav
   entry "Torrents".

## Test plan (headless, real sockets, fake swarm)

- **dc-bt unit**: bencode round-trip/spans/malformed; metainfo parse + info-hash against a
  hardcoded SHA-1 vector; magnet hex/base32/invalid; tracker response parse (compact/dict/
  failure reason); peer message + handshake + extended + ut_metadata codecs; picker
  ordering/endgame dedup; assembler verify/corrupt-piece; SOCKS5 client vs fake server;
  DHT message codec + k-bucket routing.
- **download-core integration**: fake HTTP tracker + fake UDP tracker + fake seeder (speaks
  the protocol via dc-bt over real TCP) → `.torrent` completes with byte-identical output;
  magnet → metadata from fake peer → download; pause mid → resume → complete; restart with
  same DB resumes from the persisted have-map (only missing pieces requested); seeding
  (fake leecher pulls from a completed torrent); v2-only refusal; metadata timeout;
  proxy fail-closed; DHT get_peers against a fake node feeds the session.
- **vitest**: contracts fixtures parity; torrent store lifecycle; domain registration.
- **Gate**: `verify-all.sh` equivalents.

## Risks / decisions

- **Info-hash integrity**: computed over raw spans, never a re-encode (an encoder that
  re-orders keys would mint a wrong identity for the whole session).
- **Privacy over performance**: proxied torrents suspend DHT/UDP rather than leaking direct.
- **Honest surfaces**: metadata phase shows real peers/seeds progress; no fake completion,
  no silent fallbacks; missing metadata → classified, recoverable via resume.
