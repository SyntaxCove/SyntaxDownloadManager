# Syntax Download Manager — Architecture

Unified Browser + Advanced Download Manager for Windows 11 x64 (also runs on Linux/macOS for
development). No AI features. Data integrity first.

## Process architecture

```
┌───────────────────────────── Electron ─────────────────────────────┐
│                                                                    │
│  Renderer (React 19 + Fluent UI v9 + Zustand, per-domain stores)   │
│      │  typed contextBridge API (window.syntaxdm)                     │
│      ▼                                                             │
│  Main process                                                      │
│   ├─ IpcRouter — request/response + events, zod-validated          │
│   ├─ TabManager — one WebContentsView per tab (never BrowserView)  │
│   ├─ SettingsStore — userData/settings.json                        │
│   └─ CoreSupervisor — spawns/watches the Rust core                 │
│         │  JSONL envelopes over stdio (protocol v1)                │
│         ▼                                                          │
│  download-core (Rust, Tokio) — owns SQLite DB                      │
│   ├─ JSONL RPC server (stdout events / stderr logs only)           │
│   ├─ dc-storage — rusqlite + migrations                            │
│   └─ Engine — resumable HTTP jobs (Range + If-Range validation)    │
│                                                                    │
│  Bundled external tools (later phases): FFmpeg, yt-dlp (+EJS+Deno) │
└────────────────────────────────────────────────────────────────────┘
```

## Key decisions

- **Contract-first**: `packages/contracts` is the single source of truth for every type that
  crosses the IPC or core boundary. TypeScript (zod) and Rust (serde) implementations are pinned
  together by shared JSON fixtures tested on both sides.
- **Rust owns persistence**: the renderer and the Electron main process never open the database.
  The core is a supervised subprocess: crash → exponential-backoff restart; healthy > 60 s resets
  the backoff; 8 consecutive failures surface `core_unavailable` to the UI.
- **Resumability + recovery**: every job persists `received_bytes`, `etag`, `last_modified`,
  `content_type`, `total_bytes`. Resume issues `Range: bytes=N-` with `If-Range: <etag>`; if the
  server responds `200` (source changed), the engine restarts from zero rather than corrupting
  the file — data integrity outranks speed. The `.part` sidecar carries the job state between
  app runs. Recovery engine v2 (Phase 7): an expired URL never destroys the job or the bytes —
  resume revalidates the part's provenance against the fresh source with multiple signals
  (ETag / Last-Modified / Content-Length / Content-Type); proven identity resumes with
  If-Range, an equal-size change with an expected checksum runs a checksum-arbitrated gap-fill,
  anything else wipes the part and restarts clean (bounded). `download.recover` re-acquires the
  source, `download.replaceUrl` rebinds it to a fresh/mirror URL — the journal + part survive
  and only the missing ranges are fetched. Dead/forbidden sources fail with classified,
  actionable codes (`source_gone` / `source_forbidden` / `source_changed`).
- **Security**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict
  permission handlers, CSP for the renderer, zod runtime validation on every IPC boundary.
- **Versioning**: protocol envelopes carry `v`; contract mismatches fail fast at startup.
- **Torrent engine (Phase 13)**: a native BitTorrent stack in the Rust core (new `dc-bt`
  crate: bencode with raw-span info-hash, v1 metainfo with traversal-proof paths, magnet
  parsing, HTTP(S)+UDP trackers (BEP 15/23), peer wire (BEP 3) with per-piece SHA-1
  verification, BEP 9/10 metadata exchange for magnets, BEP 5 DHT, SOCKS5/HTTP-CONNECT
  peer tunnels). The swarm is the persistent source: resume requests only the pieces the
  persisted have-map still lists as missing; `received_bytes` counts verified bytes only.
  Proxy routing is fail-closed (missing profile → paused; proxied torrents suspend DHT and
  UDP trackers rather than leak direct traffic). A session keeps seeding after completion
  until the user pauses it.
- **Proxy routing (Phase 9)**: proxy profiles persist in Electron main only — passwords are
  safeStorage ciphertext at rest (`enc:v1:`), redacted (`null`) to the renderer and never
  logged. Main pushes the decrypted runtime set to the core via `proxy.setRuntime` (memory
  only; re-pushed after every core restart). Jobs persist only `proxy_profile_id` (storage
  v5): a run whose profile is missing from the runtime map **pauses** with
  `proxy_profile_not_found` — never a silent direct fallback (that would leak the real IP).
  Tabs route through dedicated `persist:proxy.<profileId>` sessions with fixed-server rules
  and a `login` handler answering proxy auth challenges; credentials are never embedded in
  Chromium rules. Bypass lists use a documented subset (`<local>`, exact host, `.domain`,
  `*.domain`, optional `:port`) with identical semantics on both sides. A settings-level
  default proxy (Phase 16) is injected by main into renderer-issued `download.create`
  requests that omit an explicit profile; the core never learns settings, and a run whose
  profile is missing stays fail-closed (paused, never a silent direct fallback).

## Directory map

```
packages/contracts     TS contracts (zod schemas + inferred types) + fixtures
apps/desktop
  src/main             Electron main process (router, tab manager, supervisor, settings, proxy profiles)
  src/preload          contextBridge exposing the typed window.syntaxdm API
  src/renderer         React app (Fluent UI v9, Zustand stores, views)
core/                  Rust workspace
  crates/dc-protocol   wire types mirroring packages/contracts (serde)
  crates/dc-storage    SQLite storage + migrations
  crates/dc-bt         BitTorrent protocol toolbox (bencode/metainfo/trackers/peers/DHT)
  crates/download-core the supervised binary (JSONL RPC + engine)
docs/                  phase map, architecture, per-phase reports
scripts/               development helper scripts
```
