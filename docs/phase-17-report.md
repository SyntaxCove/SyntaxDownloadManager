# Phase 17 Report — Notifications, toasts, tray integration

Status: DELIVERED (2026-10-13). Contracts 1.11.0 → **1.12.0** (additive). Storage stays v9.
Prior state: Phases 0–16 delivered (git `4c19393`).

## What shipped

### 1. OS notifications (main, Electron `Notification`)
- New `domains/notify.ts`: a notification engine tapping the router's already-validated
  event stream (`download.updated` / `media.updated` / `torrent.updated`) through ONE
  `router.onEvent` listener. The Electron surface is an injectable `OsNotificationPort`
  (`supported()` + `show({title, body})`, click → restore/show/focus the shell window —
  the same policy as second-instance), so the domain is headless-testable.
- **Transition discipline**: only a KNOWN ACTIVE previous status may produce a
  notification (`JobEndTracker` — see §3). Repeat terminal snapshots, boot snapshots,
  removal-time `completed` and `canceled` (user-initiated) never notify. The tracker map
  is deliberately kept across core restarts: statuses persist in the core DB and a
  resumed run re-emits an active status before any end state, so dedupe holds.
- **Torrent semantics**: a torrent finishes into `seeding` (all pieces verified,
  `finalize_completion`), not `completed` — which appears only when the job is removed.
  The "Torrent finished" toast fires on `downloading/metadata → seeding`.
- Settings gates `notifyOnComplete` / `notifyOnFailure` are read live at event time from
  the settings store — no caching, changes apply instantly.
- Bodies are basenames of `destinationPath`/`filename`/`url` (media: `title`, torrent:
  `name`/`infoHash`), failures carry the classified error code, everything clipped to
  120 chars.
- `app.setAppUserModelId("com.unidm.desktop")` for the Windows notification identity
  (documented dev caveat: unpackaged runs have no shortcut carrying the AUM ID, so
  Windows may not deliver toasts in dev; Phase 19 packaging registers it).

### 2. In-app toasts (renderer, Fluent UI v9 `Toaster`)
- New `app/toasts.ts`: a tiny pub/sub bus (`publishToast` / `subscribeToasts`), the
  status wiring (`subscribeStatusToasts`) over the same validated events via the bridge,
  and a concurrency budget — at most 5 non-error toasts in flight (slots release on the
  intent timeout: 6 s success/info, 10 s error); failures always pass.
- New `app/ToastHost.tsx`: mounts `<Toaster position="bottom-end">` once in the AppShell;
  dispatches bus payloads with intent icons (checkmark / dismiss / info) and theme/RTL
  aware styling. React 19's `useId()` is prefix-less, so the toaster id is built around it.
- **Engine interruptions surface too**: `core.state` ready→`restarting` (info) and
  →`unavailable` (error) toast exactly once via the shared `coreStateToast` mapping; boot
  (`starting` → `ready`) stays silent.
- Toast click does not navigate anywhere yet (no view-switch bus — non-goal; the strings
  get restructured in the Phase 21 i18n pass).

### 3. Shared transition classifier (contracts, v1.12.0)
- New `packages/contracts/src/domain/transitions.ts`: `JobEndTracker`, `jobEndKind`,
  `jobEndLabel`, `coreStateToast` — the single source for "which status change is a job
  end" across both surfaces. It encodes the meaning of the three status enums, so it
  belongs to the contract layer; both consumers already depend on the package. The two
  *surfaces* remain fully independent (a dead renderer never kills OS notifications and
  vice versa) — only the pure classifier is shared. Nine contracts tests pin the rules.

### 4. Tray integration (main)
- New `domains/tray.ts`: `TrayController` over an injectable `TrayPort` (tooltip /
  context menu / click / destroy), a pure `buildTrayMenuModel` (Open UniDM; disabled
  info line "UniDM — N active · M queued"; Start all downloads — enabled iff queued > 0;
  Pause all downloads — enabled iff active > 0; Quit UniDM), `countsFromStatuses`
  (probing/downloading = active, queued = queued) and `shouldHideOnClose`.
- Menu rebuilds are throttled to one per second (progress events are ~500 ms); counts
  come from a job-status mirror in main, **seeded from `download.list` on every core
  ready transition** and updated from validated `download.updated` snapshots — the tray
  is correct immediately after boot/crash-restarts, not just after the first event.
- Tray actions go straight to the core supervisor (`download.startAll` /
  `download.pauseAll` — the same methods the UI calls); classified failures (core
  restarting) are ignored, the counts heal from the next event. Tray click opens the
  window; a second launch reveals a tray-hidden window (`win.show()` added to
  second-instance).
- **Close-to-tray**: the shell window's `close` event is prevented and the window hidden
  only when `shouldHideOnClose(closeToTray, trayReady, quitting)` — i.e. the setting is
  on AND a tray icon actually exists AND no quit is in progress. If tray creation fails
  (headless dev, missing Linux indicator host, missing icon file → `nativeImage.isEmpty()`
  guard), closing keeps the Phase 2 quit behavior: an app that vanishes with no tray icon
  would strand the engine and the user's only way back in. `before-quit` flips the
  quitting flag first and destroys the tray so the icon never lingers.
- Icon: a real 256×256 PNG asset (`resources/icons/unidm-tray.png`, generated once by
  `scripts/gen-tray-icon.py` — rounded dark tile + accent download arrow matching the
  shell window), resolved by `paths.ts` (dev: `resources/icons/…`, packaged:
  resourcesPath, wired for Phase 19 `extraResources`).

### 5. Settings UI
- Settings page gains a **Notifications & tray** section: three switches
  (notify on completion / on failure / close-to-tray keeps downloads running) with hints
  stating the honest semantics — including that close-to-tray needs a live tray icon and
  otherwise falls back to exiting.

## Contracts v1.12.0 (additive)
- `AppSettings.notifyOnComplete` / `notifyOnFailure` / `closeToTray` (booleans, defaults
  true), `SETTINGS_DEFAULTS` extended, `appSettings` fixture refreshed, new
  `domain/transitions.ts` exports. No new methods or events — the tray talks to the core
  supervisor directly and toasts are renderer-internal; `CONTRACT_VERSION` 1.12.0
  mirrored in dc-protocol (the core surface is otherwise untouched; storage stays v9).

## Layer-by-layer changes
| Layer | Files |
|---|---|
| contracts | `src/domain/settings.ts`, `src/domain/transitions.ts` (new), `src/index.ts`, `src/version.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` |
| dc-protocol | `src/lib.rs` (version constant) |
| main | `domains/notify.ts` (new), `domains/tray.ts` (new), `main.ts` (AUM id, engine + tray wiring, close handler, counts seed, before-quit), `paths.ts` (trayIcon), `resources/icons/unidm-tray.png` (new), `scripts/gen-tray-icon.py` (new) |
| renderer | `app/toasts.ts` (new), `app/ToastHost.tsx` (new), `app/AppShell.tsx` (host mount), `main.tsx` (status subscription), `pages/SettingsPage.tsx` (Notifications & tray section) |

## Tests
- contracts **102** (was 90): three settings keys default/type/fixture, version ≥ 1.12.0
  (the exact-pin test generalized to the numeric compare, same fix pattern as before),
  and the transition-classifier matrix.
- main (vitest) **+16** in two new files (`notify.test.ts`, `tray.test.ts`): once-only
  ends, canceled/boot silence, seeding-vs-completed torrents, live settings gates,
  unsupported-OS port, unsupported payload safety; close-to-tray
  guard matrix, counts, menu enable/disable, tooltip, throttled pushes (fake timers),
  action dispatch (startAll/pauseAll → core, open/quit → callbacks), failing-port
  resilience, destroy.
- renderer (vitest) **6 toasts**: mirrored transition matrix over the bridge stub
  (proving surface independence), core-state mapping, bus budget (cap drop, error pass,
  slot release), unsubscribe.
- Gate: `scripts/verify-all.sh` end-to-end "all checks passed" — typecheck ×2 clean;
  cargo fmt/clippy -D warnings clean; cargo test 268 (unchanged, by design); renderer
  build green. (The sandbox wiped the Rust toolchain again — 10th reset — repaired from
  `scripts/rustup-init.sh` before the gate.)

## Known limits (honest)
- Dev-mode Windows toast delivery depends on the OS shortcut/AUM registration (packaged
  installs deliver; the in-app toasts always work).
- The tray shows the download queue only (media/torrent live on their pages).
- Toast click navigation intentionally deferred (needs a view-switch bus; Phase 21 i18n
  restructures the strings first).
