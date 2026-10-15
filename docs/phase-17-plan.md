# Phase 17 Plan — Notifications, toasts, tray integration

Status: PLANNED (2026-10-13). Prior state: Phases 0–16 delivered (git `4c19393`).
Contracts 1.11.0 → **1.12.0** (additive). Storage stays v9 (no new persistence).

## Scope — three surfaces, one event source

1. **OS notifications** (main process, Electron `Notification`): download/media/torrent jobs
   reaching a meaningful end get a native Windows toast. Clicking one focuses the shell
   window. Gated by two new settings.
2. **In-app toasts** (renderer): the same terminal transitions plus download-engine
   interruptions surface as Fluent UI v9 toasts (bottom-end, auto-dismiss, theme/RTL aware)
   so the user is informed even when the window is focused (where OS toasts are suppressed).
3. **Tray integration** (main): a persistent tray icon with a context menu (Open,
   Start all, Pause all, live active/queued counts, Quit) and **close-to-tray** semantics —
   closing the window keeps downloads running (the explicit Phase 17 deferral noted in
   `window-all-closed` since Phase 2).

Single event source: the core's `download.updated` / `media.updated` / `torrent.updated`
snapshots, already schema-validated twice (CoreClient + `router.emit`). The engine taps
`router.onEvent` in main and a renderer mirror taps the same events through the bridge.

## Ground truth that shaped the design

- **The core emits `*.updated` only on real state transitions** (create, pause, resume,
  run start, completion, failure) — never for restored rows at boot. A last-status map in
  the notification engine therefore sees a clean transition stream and dedupes refires;
  it is intentionally NOT cleared on core restarts (statuses persist in the DB; a
  resumed run re-emits `queued`/`probing` before any terminal status, so dedupe holds
  across restarts).
- **Torrent "finished downloading" is `downloading → seeding`**, not `→ completed`
  (`finalize_completion` sets `seeding`; `completed` appears only when the job is removed).
  The notification moment for a torrent is the transition to `seeding`.
- **`canceled` is user-initiated** — never notified on any surface.

## Design decisions

### Transition engine (shared pure classifier in contracts)

Both main and renderer need "known-active → terminal" transitions. Implementation note
(refinement over the original "duplicate honestly" sketch): the classifier lives ONCE in
**contracts** (`domain/transitions.ts`: `JobEndTracker`, `jobEndKind`, `jobEndLabel`,
`coreStateToast`) — it encodes the meaning of the status enums, which is contract
knowledge, and both surfaces already depend on the package. The surfaces themselves (OS
port vs. renderer bus) stay fully independent: a dead renderer never kills OS
notifications and vice versa. Active sets: download `queued|probing|downloading` →
completed/failed; media `queued|extracting|downloading|muxing` → completed/failed;
torrent `queued|metadata|downloading` → seeding/failed. A terminal or unknown previous
status never notifies (repeat snapshots, boot emissions, removal-time `completed`).
All classifier rules are unit-tested in contracts; both consumers prove the wiring.

### OS notifications (main)

- `domains/notify.ts`: `NotificationEngine` with an injectable `OsNotificationPort`
  (`supported()`, `show({title, body})`) so the domain is headless-testable; the Electron
  port wraps `Notification.isSupported()` + `new Notification(...)` with
  `on("click") → focusShellWindow()` (restore + focus, same policy as second-instance).
- Settings gates read live at event time from `SettingsStore` (`notifyOnComplete`,
  `notifyOnFailure`) — no caching, so settings changes apply instantly.
- Titles/bodies are plain strings built from job fields
  (`destinationPath`/`filename`/`url`, media `title`/`destinationPath`, torrent `name`
  /`infoHash`), basename-extracted, truncated to 120 chars. No i18n (Phase 21).
- `app.setAppUserModelId("com.syntaxdm.desktop")` at startup (Windows notification identity).

### Tray (main)

- `domains/tray.ts`: `TrayController` over an injectable `TrayPort` (create/tooltip/menu/
  click/destroy) — headless-testable. The Electron port adapts `Tray` + `Menu`.
- Pure `buildTrayMenuModel({active, queued}, trayReady)` → items with `action` ids; the
  Electron adapter maps actions to: `open` (show + focus), `startAll` / `pauseAll`
  (`supervisor.request("download.startAll"|"download.pauseAll")` — the same core methods
  the UI uses; failures are classified and ignored: tray actions are best-effort),
  `quit` (sets the quitting flag, then `app.quit()`).
- Menu rebuild is throttled to 1/s and driven by `download.progress`/`download.updated`
  counts + tooltip `"{active} active · {queued} queued"` (also the window taskbar is the
  detail surface; the tray stays coarse).
- **Close-to-tray**: pure `shouldHideOnClose(closeToTray, trayReady, quitting)`. The
  window `close` handler hides instead of closing only when the setting is on AND the
  tray actually exists AND we are not quitting — if tray creation failed (headless dev,
  missing Linux indicators), close keeps the Phase 2 quit behavior. The app only really
  quits via tray Quit (or `window-all-closed`, which still fires when the window is
  destroyed by other means).
- Icon: a real 256×256 PNG asset generated for this phase
  (`resources/icons/syntaxdm-tray.png` — rounded dark tile + download arrow), loaded via
  `nativeImage.createFromPath` with an empty-image fallback if unreadable (then
  `trayReady` stays false and close-to-tray self-disables).

### In-app toasts (renderer)

- `app/toasts.ts`: a tiny pub/sub bus (`publishToast` / `subscribeToasts`) + the renderer
  transition tracker + core-state tracker. Toasts: download/media/torrent completed
  (success) and failed (error, body includes the classified `errorCode`), engine
  `unavailable` (error) and `restarting` (info) — the latter two only when the previous
  status was `ready`/`restarting` so app boot (`starting` → `ready`) stays silent.
- `app/ToastHost.tsx`: mounts Fluent's `<Toaster position="bottom-end">`; dispatches with
  timeouts (6 s success/info, 10 s error). Clicking a toast does nothing yet (no nav bus —
  non-goal below). Wired in `AppShell`; the engine subscribes in `main.tsx` boot.

### Settings (contracts v1.12.0, additive)

`notifyOnComplete: true`, `notifyOnFailure: true`, `closeToTray: true` — booleans with
defaults, appended to `SETTINGS_DEFAULTS`, `appSettings` fixture, Settings page
"Notifications & tray" section (three `Switch` rows in the Phase 16 pattern). Main reads
them live; the core never learns settings (zero Rust surface beyond the version constant).

## Layer-by-layer changes

| Layer | Files |
|---|---|
| contracts | `src/domain/settings.ts`, `src/domain/transitions.ts` (new), `src/index.ts`, `src/version.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` |
| dc-protocol | `src/lib.rs` (version constant) |
| main | `domains/notify.ts` (new), `domains/tray.ts` (new), `main.ts` (wiring, close handler, before-quit tray destroy), `resources/icons/syntaxdm-tray.png` (new) |
| renderer | `app/toasts.ts` (new), `app/ToastHost.tsx` (new), `app/AppShell.tsx` (mount host), `main.tsx` (engine subscribe), `pages/SettingsPage.tsx` (new section) |

## Tests

- **contracts**: three keys default/accept/reject types, `SETTINGS_DEFAULTS` coherence,
  fixture parse, version 1.12.0.
- **main (vitest)**: `notify.test.ts` — active→completed/failed fires once; repeat
  terminal snapshots never refire; `canceled` silent; seeding-transition torrent fires
  once with torrent labeling; settings gates (both off / failure-only); unknown→terminal
  silent (boot-snapshot safety); body truncation. `tray.test.ts` — `shouldHideOnClose`
  matrix; menu model counts/labels/disabled states; tooltip text.
- **renderer (vitest)**: `toasts.test.ts` — the same transition matrix (independence
  proof), core-state mapping (boot silent, ready→restarting/unavailable toast),
  bus subscribe/unsubscribe, concurrency cap with timeout-based slot release.
- **contracts (vitest)**: `JobEndTracker` transition matrix (once-only ends, canceled
  silent, paused/resume cycles, torrent seeding-vs-completed, per-domain independence),
  `jobEndLabel` basename/truncation, `coreStateToast` mapping.

## Non-goals (honest scope)

No toast click navigation (needs a view-switch bus; strings get restructured in the
Phase 21 i18n pass anyway), no per-domain notification settings, no notification sounds
(OS-owned), no tray progress badge / taskbar progress wiring, no launch-at-login
(packaging territory, Phase 19+), no i18n of new strings (Phase 21), no new IPC methods
or events (tray talks straight to the core supervisor; toasts are renderer-internal), no
media/torrent-specific tray counts (the tray shows the download queue; media/torrents
stay on their pages).
