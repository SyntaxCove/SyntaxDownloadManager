# Phase 14 Plan — Browser history, bookmarks, downloads library

Status: PLANNED → this plan is the Phase 14 "Plan" step.
Prior state: Phases 0–13 delivered (git `8ec3284` = phase(13)); contracts v1.8.0; storage v7;
223 cargo tests / 197 vitest tests green.

## Goal

Deliver the three persistence-grade library features the phase map names:

1. **Browser history** — every settled main-frame http(s) navigation in the managed browser is
   recorded persistently, searchable, deletable, clearable.
2. **Bookmarks** — flat, position-ordered bookmark list with create (address-bar star),
   rename, remove, open; star state reflects the active page.
3. **Downloads library** — one unified, searchable, filterable view over every downloaded
   artifact across the three job domains (HTTP downloads, media pipeline jobs, torrent jobs)
   with safe reveal/open actions and per-kind honest delete semantics.

## Architecture decisions

### D1 — History and bookmarks persist in the Rust core's SQLite database (storage v8)
The ground rules say the core owns *the* persistent database. History rows and bookmarks are
user data with the same durability expectations as jobs. New tables `browser_history` and
`bookmarks` arrive in **migration v8**; access only via new core methods (renderer never
touches storage; main is a thin validated proxy — same pattern as every other core domain).

History writes are fire-and-forget from main (`supervisor.request(...).catch(log)`): a visit
row lost during the seconds of a core restart is an accepted, documented trade-off — download
bytes/journal state never take that path (they live engine-side and are fsync'd).

### D2 — What gets recorded (and what never does)
Record on **settled** main-frame navigations only:
- `did-stop-loading` after a main-frame commit (title + favicon are known by then),
- `did-navigate-in-page` with `isMainFrame === true` (SPA soft navigations; title already set).

Filter rules (pure, unit-tested in `history-recorder.ts`):
- Only `http:` / `https:` schemes. `about:`, `devtools:`, `chrome:`, `data:`, `blob:`,
  `file:` and anything unparsable are never recorded.
- Per-tab dedupe guard: the same URL recorded again for the same tab within 1500 ms is
  dropped (kill double-fire from load cycles / in-page + settle overlaps).
- Reloads and back/forward revisits ARE recorded (each is a real visit — honest history).

### D3 — Downloads library is a renderer-side projection, not a new aggregation RPC
The renderer already mirrors all three job domains live (`download.updated/progress`,
`media.updated/progress`, `torrent.updated/progress`). A core-side SQL UNION would duplicate
row→wire knowledge for zero correctness gain and fight the "correctness > performance"
priority (client-side filtering is trivially correct at library scale). The merge/filter
logic lives in one **pure module** (`library-projection.ts`) with exhaustive unit tests.

### D4 — Reveal/open is a MAIN-process method; the renderer never supplies paths
`app.revealEntry { kind, id, mode }` — main fetches the **authoritative job row from the
core** (`download.get` / `media.get` / `torrent.get`), derives the path from persisted fields
only, checks existence, then acts:
- `download` / `media` → `destinationPath` (null → `entry_path_unavailable`);
- `torrent` → `join(destinationDir, name)` (name unresolved → `entry_path_unavailable`);
- `mode: "folder"` → `shell.showItemInFolder(path)`; `mode: "open"` → `await shell.openPath(path)`;
- missing on disk → `file_missing`; openPath error string → `io_error`.

A compromised renderer can therefore only reveal paths that genuinely belong to real jobs —
never arbitrary filesystem paths.

### D5 — Delete semantics are per-kind and honest (no invented fs deletion)
- HTTP download rows: `download.remove` (row + optional `.part`) — the finished file is the
  user's file; the Library offers "Remove entry" and the UI says the file on disk is kept.
- Media: "Remove entry" (files kept) and "Delete entry + files" (`media.remove(deleteFiles: true)`).
- Torrent: same pair via `torrent.remove(deleteFiles)`.
No main-process fs deletion surface is invented for HTTP artifacts in this phase.

## Contracts v1.9.0 (additive — minor bump, no breaking changes)

New file `packages/contracts/src/domain/browser-data.ts`:

```ts
HistoryEntry { id: Ulid, url: string(http/https), title: string|null,
               faviconUrl: string|null, visitedAt: int≥0 }        // nullable = always serialized
Bookmark      { id: Ulid, url: string(http/https), title: string,
                position: int≥0, createdAt: int≥0, updatedAt: int≥0 }
```

Core methods (server: "core"):
- `browser.history.record` `{ url, title?, faviconUrl?, visitedAt? }` → `{ recorded: true }`
- `browser.history.list` `{ query?, limit? (1..500, default 200), offset? (≥0) }` → `{ entries }` (newest first)
- `browser.history.delete` `{ id }` → `{ deleted: true }`
- `browser.history.clear` `{ before? (epoch ms) }` → `{ cleared: int }`
- `browser.bookmark.create` `{ url, title }` → `{ bookmark }` (position = max+1)
- `browser.bookmark.list` `{}` → `{ bookmarks }` (position ASC)
- `browser.bookmark.getByUrl` `{ url }` → `{ bookmark: Bookmark|null }` (first by position)
- `browser.bookmark.update` `{ id, title?, url? }` → `{ bookmark }` (≥1 field required)
- `browser.bookmark.remove` `{ id }` → `{ removed: true }`

Main methods (server: "main"):
- `app.revealEntry` `{ kind: "download"|"media"|"torrent", id: Ulid, mode: "folder"|"open" }` → `{ path }`

Error codes appended (append-only): `entry_path_unavailable`, `file_missing`.
Fixtures: `domain.json` gains `historyEntry` + `bookmark` (cross-language parity tests).
`CONTRACT_VERSION` 1.8.0 → **1.9.0** on both sides; npm package → 1.9.0.

## Storage migration v8

```sql
CREATE TABLE browser_history (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, favicon_url TEXT,
  visited_at INTEGER NOT NULL );
CREATE INDEX idx_history_visited ON browser_history(visited_at DESC);
CREATE INDEX idx_history_url ON browser_history(url);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE INDEX idx_bookmarks_position ON bookmarks(position);
```

CRUD (dc-storage): `insert_history_entry` (with built-in prune to 50 000 rows — the DB stays
bounded forever, hygiene enforced at the write path), `list_history(query, limit, offset)`
(case-insensitive substring on url/title), `delete_history_entry`, `clear_history(before?)`,
`count_history`; bookmark insert (position = max+1 in the same transaction), list, get_by_url,
dynamic update (bumps `updated_at`), delete.

## Implementation surface

| Layer | Files | Change |
|---|---|---|
| contracts | `src/domain/browser-data.ts` (new), `src/protocol/methods.ts`, `src/errors.ts`, `src/version.ts`, `fixtures/domain.json`, `package.json` | v1.9.0 additive set |
| dc-protocol | `src/browser.rs` (new), `src/lib.rs` | wire types + parity tests + version |
| dc-storage | `src/lib.rs` | migration v8 + history/bookmark CRUD + tests |
| download-core | `src/manager.rs`, `src/server.rs` | 9 delegation methods + dispatch arms |
| main | `domains/history-recorder.ts` (new), `domains/tab-manager.ts`, `domains/browser-data.ts` (new), `domains/app-reveal.ts` (new), `main.ts` | visit recording + thin proxies + reveal |
| renderer | `stores/browser-data.ts` (new), `app/library-projection.ts` (new), `pages/LibraryPage.tsx` (new), `pages/BrowsePage.tsx`, `app/AppShell.tsx` | UI |
| tests | cargo: storage + protocol + server; vitest: contracts + main domains + recorder + projection + store | gate below |

## Test plan

- **cargo (dc-storage)**: v8 schema version; history insert/list ordering/search/limit-offset;
  delete; clear(all) and clear(before); prune cap holds exactly 50k; bookmark CRUD,
  position ordering, getByUrl first-match, update bumps fields, delete.
- **cargo (dc-protocol)**: historyEntry + bookmark fixtures deserialize; Rust round-trip
  serializes byte-identically (parity).
- **cargo (download-core server)**: history record→list→delete→clear arm round-trip;
  bookmark create→list→update→getByUrl→remove round-trip; invalid params classified.
- **vitest (contracts)**: new schemas accept/reject; method registry entries; fixture parity.
- **vitest (main)**: history-recorder (scheme filter ×8, dedupe, in-page acceptance);
  browser-data domain forwarding (fake supervisor); app-reveal (path resolution per kind,
  entry_path_unavailable, file_missing, io_error propagation; renderer-supplied path never used).
- **vitest (renderer)**: library-projection (merge, kind/status/query filters, sort);
  browser-data store (load/search/toggle-star/remove/clear flows with mocked rpc).

## Verification gate (same as every phase)

`cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` (dc-storage, dc-protocol,
dc-bt, download-core) · `vitest` contracts + desktop · `typecheck` ×4 · `vite build` green,
then Document (phase-14-report.md, PHASES.md, worklog) → Review → Commit.

## Risks / non-goals

- No bookmark folders, no bookmark reorder, no favicon cache DB (page-provided favicon URLs
  are stored as-is) — honest v1 scope per the phase title.
- History is http(s) only; the managed browser records nothing for any other scheme.
- No new events: Library/History pages pull on mount (they mirror already-live job stores and
  refetch history/bookmarks on tab activation).
