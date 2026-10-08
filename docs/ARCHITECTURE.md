# UniDM — Architecture

Unified Browser + Advanced Download Manager for Windows 11 x64 (also runs on Linux/macOS for
development). No AI features. Data integrity first.

## Process architecture

```
┌───────────────────────────── Electron ─────────────────────────────┐
│                                                                    │
│  Renderer (React 19 + Fluent UI v9 + Zustand, per-domain stores)   │
│      │  typed contextBridge API (window.unidm)                     │
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

## Directory map

```
packages/contracts     TS contracts (zod schemas + inferred types) + fixtures
apps/desktop
  src/main             Electron main process (router, tab manager, supervisor, settings)
  src/preload          contextBridge exposing the typed window.unidm API
  src/renderer         React app (Fluent UI v9, Zustand stores, views)
core/                  Rust workspace
  crates/dc-protocol   wire types mirroring packages/contracts (serde)
  crates/dc-storage    SQLite storage + migrations
  crates/download-core the supervised binary (JSONL RPC + engine)
docs/                  phase map, architecture, per-phase reports
scripts/               development helper scripts
```
