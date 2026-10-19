# Phase 25 Plan — E2E suites (headless renderer + main + core integration)

Status: draft → delivered 2026-10-19 · Contract **stays v1.15.0** (no wire change) ·
App 0.11.0 → 0.12.0

## Scope (from docs/PHASES.md)

"25 | E2E suites — headless renderer+main+core integration." Until now the three surfaces
were tested separately: vitest mocks the supervisor / Electron, and cargo tests drive the
core's `serve()` over in-memory duplex pairs. Nothing proved that the *real* Electron-main
composition, the *real* Rust binary, and the *real* renderer API layer agree on the wire
for complete user stories. Phase 25 closes that gap with E2E suites that run headlessly in
the Linux sandbox (and therefore in CI), with exactly one stub boundary per Electron-only
API.

## Test strategy (honest about the sandbox)

The sandbox has no Electron binary (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`), so a real
Electron app boot is impossible here. The suites therefore pin every boundary that CAN be
real, and stub only what structurally cannot exist headlessly:

| Boundary | E2E posture |
|---|---|
| Rust core process | **REAL** — `cargo build` produces `core/target/debug/download-core`; the harness supervises it through the production `CoreSupervisor` (stdio JSONL, backoff, stderr drain). |
| HTTP servers | **REAL** — `node:http` fixtures with Content-Length/ETag/Last-Modified/Range/Content-Disposition/slow-stream/404 behaviors. |
| SQLite persistence | **REAL** — the core owns a database file in a per-test temp dir; restarts reopen it. |
| IpcRouter + zod validation | **REAL** — the production `IpcRouter`; requests go through `RequestEnvelope` validation, handlers through registered param/result schemas. |
| Main-process domains | **REAL** — extracted into `src/main/composition.ts` (`registerAppDomains`) and called by BOTH `main.ts` and the E2E harness, so the suites exercise the shipped wiring, not a hand-copied twin. |
| Renderer bridge + stores | **REAL** — the production `src/renderer/src/bridge.ts` (`rpc`, `onEvent`) and the production Zustand stores, driven with `window.syntaxdm` implemented as a faithful mirror of `preload.ts` over `router.handleRequest`. |
| Electron `BrowserWindow` / `WebContentsView` / `Tray` / `Notification` / `safeStorage` / `dialog` / `shell` / electron-updater | **STUBBED at the port level** — the same injectable ports the domains already define (`DirectoryPicker`, `OsNotificationPort`, `RevealShell`, `SafeStorageLike`, `UpdateController.getState`). Tabs and tray are out of E2E scope (no Electron binary); they keep their unit coverage and are marked honestly below. |

## Work items

1. **Extract the shipped domain composition** (`src/main/composition.ts`): move the
   thirteen domain registrations out of `main.ts` into `registerAppDomains(deps)` in the
   exact shipped order (settings → download → media → torrent → scheduler → browser-data →
   app-reveal → proxy → toolkit → dialogs → notify → diagnostics → perf). `main.ts` calls
   it; the E2E harness calls it. Renderer-facing behavior is unchanged (moving the
   settings registration next to the others removes a microscopic pre-window race — no
   window exists before the block runs in either version).
2. **E2E harness** (`src/e2e/harness.ts`): temp `userData` dir per boot; `JsonlLogger`;
   real `SettingsStore` + `ProxyProfileStore` (plaintext `SafeStorageLike` stub — the
   production Electron `safeStorage` is unavailable headlessly; the store is separately
   unit-tested); real `CoreSupervisor` over the built binary; `registerAppDomains` with
   recording stub ports; a preload-faithful bridge factory (`router.handleRequest` +
   `EventEnvelope` filtering); HTTP fixture server with Range/resume support. Tests skip
   (typed, visible) when the core binary has not been built.
3. **Suite 1 — boot, core surface, diagnostics** (`boot.e2e.test.ts`): core spawns and
   reaches `ready`; `core.state` events flow to listeners; `core.ping` returns the pinned
   contract version; settings get/set round trip emits `settings.changed`;
   `perf.getSnapshot` reports boot phases + monotonic counters; `diagnostics.getHealthReport`
   reports a healthy core (sqlite `quick_check` "ok") through the real binary; unknown
   method / invalid params / unregistered method error paths stay typed end-to-end;
   graceful stop shuts the core down cleanly.
4. **Suite 2 — download lifecycle** (`download-flow.e2e.test.ts`): real HTTP fixture,
   real bytes, real files. Create → progress events → completed; file on disk byte-identical
   to the served body; streamed sha256 matches and `checksumVerified` is true; pause of a
   throttled download freezes `receivedBytes`, resume finishes the job correctly (Range
   resumption through the real engine); `download.remove` deletes the row and partial file;
   a dead-URL job lands in `failed` with a typed `errorCode` and the job row survives
   (expired URL never destroys the job); **persistence across core death**: stop the
   supervisor, boot a fresh supervisor + router + domains on the same DB, `download.list`
   still returns the completed job with identical bytes/checksum facts.
5. **Suite 3 — renderer bridge + stores** (`renderer-bridge.e2e.test.ts`): the production
   renderer code against the production composition over the real core — `bridge.rpc`
   full download flow with renderer-side result re-validation; renderer-side invalid params
   reject before the wire; main-side typed errors propagate as `SyntaxDmError`; the real
   downloads store loads, creates, observes progress patches and `download.updated`
   snapshots, pauses/resumes and removes through its own methods; the settings store
   round-trips and reflects `settings.changed`.
6. **Suite 4 — scheduler + browser data** (`scheduler-history.e2e.test.ts`): scheduler
   create → list → `runNow` → outcome recorded + `scheduler.updated` event; history
   record/list/delete/clear; bookmark create/list/getByUrl/update/remove — all through the
   real binary and its SQLite storage.
7. **Build-order fix** (`scripts/verify-all.sh`): build the core binary (debug) *before*
   the TS test step so the E2E suites always find it; `apps/desktop/package.json` gains
   `test:e2e`. Suites remain `skipIf`-guarded so a machine without cargo still runs the
   rest of the TS gate.

## Verification

- `scripts/verify-all.sh` end-to-end green: typecheck, contracts tests, desktop tests
  (unit + E2E), renderer build + budget gate, cargo fmt/clippy/test.
- New E2E tests counted separately in the phase report.
- Contract version unchanged at 1.15.0; no wire changes anywhere in the phase.
