# Phase 14 Report — Browser history, bookmarks, downloads library

Status: DELIVERED (2026-10-13). Contracts 1.8.0 → **1.9.0** (additive). Storage v7 → **v8**.
Prior state: Phases 0–13 delivered (git `8ec3284`).

## What shipped

### 1. Browser history (persistent, http(s)-only, settled main-frame visits)
- **Recording**: the TabManager fires `onVisited` on settled main-frame navigations —
  `did-stop-loading` for full loads (title/favicon known by then) and `did-navigate-in-page`
  (`isMainFrame`) for SPA soft navigations. `domains/history-recorder.ts` is the pure gate:
  http/https schemes only (about:/devtools:/chrome:/data:/blob:/file: and unparsable inputs
  are never recorded) and a per-tab 1500 ms same-URL dedupe window pinned to the first
  admission (double-fires from one load cycle collapse; repeated manual reloads still record).
- **Persistence**: main forwards admitted visits to the core via `browser.history.record`
  fire-and-forget — a row lost during the seconds of a core restart is an accepted,
  documented trade-off (download bytes never take this path; they are fsync'd engine-side).
- **Storage v8**: `browser_history` (id/url/title/favicon_url/visited_at + visited & url
  indexes). The write path prunes to `MAX_HISTORY_ROWS` (50 000) inside every insert via an
  O(k) rowid-range delete — the table is bounded forever; listing orders by visit time with
  a rowid tiebreak, so backdated rows age out naturally.
- **Queries**: `browser.history.list` (case-insensitive substring over url/title, limit
  1..500 default 200, offset), `browser.history.delete` (invalid_state on unknown id),
  `browser.history.clear` (all or strictly-before a cutoff; returns the removed count).

### 2. Bookmarks (flat, position-ordered)
- `browser.bookmark.create` (position = max+1 assigned in the same transaction), `list`
  (position ASC), `getByUrl` (first by position — the address-bar star's source of truth),
  `update` (rename/re-URL with COALESCE partial semantics; bumps updated_at; rejects
  empty updates), `remove` (invalid_state on unknown id).
- URLs are pinned to http(s) at every boundary: zod `WebUrl` (TS), `ensure_web_url` (Rust).
- **UI**: the Browse address bar gained a star toggle (filled star = bookmarked; state
  re-checks on every active-URL change), and the Library page's Bookmarks tab lists,
  renames (dialog), removes and opens bookmarks in new tabs.

### 3. Downloads library (one view across the three job domains)
- **Projection, not aggregation**: `app/library-projection.ts` merges the renderer's live
  mirrors of download/media/torrent jobs into one newest-first list with per-kind badges,
  honest titles (filename → path basename → URL segment; torrents show a truncated info
  hash until metadata resolves a name) and `path: null` until an artifact is real.
  Filter axes: text (title+path), kind, status group (active/completed/stopped mapping
  every domain's lifecycle). Exhaustively unit-tested as a pure module.
- **`app.revealEntry { kind, id, mode }`** (main-served): the renderer never supplies
  paths. Main fetches the authoritative job row from the core (`download.get` /
  `media.get` / `torrent.get`), resolves the path exclusively from persisted fields
  (destinationPath; torrents = destinationDir + name), checks existence, then
  `shell.showItemInFolder` (folder) or `shell.openPath` (open). Classified failures:
  `entry_path_unavailable` (artifact not resolved yet), `file_missing` (gone from disk),
  `io_error` (shell refused). A compromised renderer can only reveal paths of real jobs.
- **Honest delete semantics**: HTTP downloads offer "Remove entry" only (the finished
  file stays on disk — `download.remove` never deletes user files); media and torrents
  additionally offer "Delete entry + files" through their existing `deleteFiles` paths.
  No new filesystem-deletion surface was invented.

### UI surface
- New **Library** nav entry with three tabs: Files (library), History (day-grouped,
  per-entry open/remove, "Clear older than 30 days" + "Clear all"), Bookmarks.

## Contracts v1.9.0 (additive)
- New `domain/browser-data.ts`: `HistoryEntry`, `Bookmark`, `WebUrl` (protocol-pinned),
  9 core method schemas + `app.revealEntry` main method, `LibraryEntryKind`.
- Error codes appended: `entry_path_unavailable`, `file_missing` (append-only preserved).
- Fixtures: `domain.json` gained `historyEntry` + `bookmark`; parity tests on both sides
  prove byte-identical wire shapes (including explicit nulls for nullable fields and
  camelCase request deserialization).
- `CONTRACT_VERSION` 1.9.0 mirrored in dc-protocol; npm package 1.9.0.

## Layer-by-layer changes
| Layer | Files |
|---|---|
| contracts | `src/domain/browser-data.ts` (new), `src/protocol/methods.ts`, `src/errors.ts`, `src/version.ts`, `src/index.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` |
| dc-protocol | `src/browser.rs` (new), `src/lib.rs`, `tests/fixtures.rs` (+4 parity tests) |
| dc-storage | `src/lib.rs` (migration v8, history/bookmark CRUD, `MAX_HISTORY_ROWS`), `tests/storage.rs` (+9 tests) |
| download-core | `src/manager.rs` (9 methods + `ensure_web_url` scheme re-validation), `src/server.rs` (9 dispatch arms) |
| main | `domains/history-recorder.ts` (new), `domains/tab-manager.ts` (visit events), `domains/browser.ts` (visitSink param), `domains/browser-data.ts` (new), `domains/app-reveal.ts` (new), `main.ts` (wiring; supervisor constructed before browser registration so the visit sink can capture it) |
| renderer | `app/library-projection.ts` (new), `stores/browser-data.ts` (new), `pages/LibraryPage.tsx` (new), `pages/BrowsePage.tsx` (star), `app/AppShell.tsx` (Library nav) |

## Fixed during Test/Fix
- main.ts ordering hazard: the visit-sink closure captured `supervisor` before its
  declaration — supervisor construction moved above browser-domain registration
  (constructor does not spawn; `start()` remains at the original call site).
- Prune query performance: the first implementation walked the ordered index per insert
  (O(n²) at scale — 60 s+ for 50 k inserts). Replaced with an O(k) rowid-range delete
  (50 005-row race test now finishes in ~1.8 s).
- Renderer types: Fluent `OptionOnSelectData.optionValue` (not `.value`);
  `TorrentJob` carries no sourceUri on the wire — the projection now labels unnamed
  magnets from the info hash instead of a nonexistent field.
- Test arithmetic (ordering/cutoff expectations) and a mangled test file rewritten cleanly.
- clippy: `unnecessary_cast` chain in the prune race test resolved cleanly.

## Verification gate
- `cargo fmt --check` clean; `cargo clippy --workspace --all-targets` 0 warnings.
- `cargo test --workspace`: **240 passed** (was 223): dc-storage 24 (was 15), dc-protocol
  fixtures 15 (was 11), server +3 (history ×2, bookmark ×1 round-trips).
- `vitest`: contracts **75** (was 68), desktop **169 passed + 1 skipped** (was 129).
- `typecheck` ×2 workspaces clean; `vite build` green (pre-existing chunk-size notice only).

## Non-goals (honest scope)
No bookmark folders or manual reorder (flat list ordered by creation), no favicon cache
(page-provided URLs stored as-is), no history events (Library pulls on activation; the
star re-checks on URL change), no per-entry history edit.
