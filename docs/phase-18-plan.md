# Phase 18 Plan — Auto-update channel

Status: PLANNED (2026-10-14). Prior state: Phases 0–17 delivered (git `5639945`).
Contracts 1.12.0 → **1.13.0** (additive). Storage stays v9 (no new persistence).
**Main-process-only domain — the Rust core learns nothing about updates** (zero core
surface beyond the mirrored version constant).

## Scope

1. **Update feed resolution (main, fail-closed)** — an update source is either the
   `SYNTAXDM_UPDATE_FEED_URL` env override (must be https) or the `app-update.yml`
   electron-builder drops into `resources/` at packaging time (Phase 19). No feed → the
   updater reports `unavailable / no_feed`; unpackaged (dev) runs report
   `unavailable / not_packaged`. A non-https env URL is a classified failure
   (`update_feed_invalid`), never a silent direct-HTTP fallback.
2. **Check / download / install lifecycle (main controller)** — user-visible state machine
   over an injectable `UpdatePort`: `idle → checking → available | not-available`,
   `available → downloading → downloaded → installing`, `error`. Consent-gated end to end:
   a check NEVER downloads (`autoDownload=false`), download happens only via
   `update.download`, install only via `update.install` after `downloaded`.
   `updateAutoCheck` (settings, default true) gates a 2-min-delayed startup check and a
   12 h periodic check (read live at fire time); manual checks are always available.
3. **Renderer surface** — a Settings "Updates" section (current version, status line,
   auto-check switch, Check now, progress bar, Restart to update) fed by a Zustand store
   mirroring the `update.state` event. The tray/toast surfaces are untouched (an update is
   never urgent enough to interrupt; toasts stay job-scoped per Phase 17).

## Ground truth that shaped the design

- **electron-updater 6.8.10 is the transport engine** (npm dist-tag `v26`, pairs with the
  electron-builder 26 line Phase 19 will use; published 2026-10-08). Security (priority #2)
  outranks maintainability: NSIS choreography (silent flags, waiting for app exit,
  differential blockmap downloads, sha512 verification embedded in `latest.yml`) is a
  decade of battle-tested edge cases — re-implementing it would be a bigger integrity risk
  than adopting the vetted library. electron-builder (Phase 19) generates exactly the feed
  and `app-update.yml` it expects. For an unsigned build, integrity = https transport +
  feed-embedded sha512 + blockmap; authenticity upgrade path = code signing at release
  engineering (documented honestly in the report, not hidden).
- **electron-updater event semantics** (verified against the 6.x API): `checking-for-update`,
  `update-available` (only for a newer version; `allowDowngrade=false` default),
  `update-not-available`, `download-progress`, `update-downloaded`, `error`.
  `quitAndInstall(isSilent, isForceRunAfter)` closes windows — it may NOT run our
  `before-quit` handlers on every version and our Phase 17 close-to-tray handler hides
  instead of closing. **The install path therefore goes through our controller**, which
  runs the same teardown as a real quit (quitting flag, tray destroy, supervisor stop)
  BEFORE calling `port.install()` — closing the known trap.
- **A stale check result must not clobber a downloaded state**: `onAvailable` /
  `onNotAvailable` are ignored while `downloading | downloaded | installing`.
- **The renderer only sees sanitized state** — no feed URL, no filesystem paths (the
  Phase 10 toolkit precedent: renderer sees status shapes only).

## Design decisions

### Port/adapter split (the codebase's established shape)

- `domains/updates.ts` — pure, headless-testable: `UpdateFeedResolver`
  (`resolveUpdateFeed({ isPackaged, envFeedUrl, resourcesAppUpdateYmlExists })`), the
  `UpdateController` state machine (inputs: `onChecking/onAvailable/onNotAvailable/
  onProgress/onDownloaded/onError`; user actions: `check/download/install`), progress
  throttling (500 ms floor like media/torrent; final 100 % immediate), release-notes
  sanitization (string → capped 4000 chars; any other shape → null).
- `domains/updates-adapter.ts` — thin untested glue: constructs electron-updater
  `autoUpdater` (`autoDownload=false`, `autoInstallOnAppQuit=true`, `allowDowngrade=false`,
  `disableWebInstaller=true`), applies the resolved feed (`setFeedURL` only for the env
  kind — the `app-update.yml` kind is implicit), wires its events into the controller,
  exposes `UpdatePort { check, download, install }`.
- `main.ts` — wiring only: resolve feed, construct controller, register the four
  `update.*` methods, emit `update.state` through the router, start auto-checks,
  clear the timer on `before-quit`.

### Install-before-teardown ordering (test-pinned)

`install()`: precondition `status === downloaded` (else `accepted=false` + error state
`update_not_downloaded`) → state `installing` → `onQuitForInstall()` (main tears the
world down exactly like a real quit) → `port.install()` → `quitAndInstall(false, true)`.

### State snapshot + event

`update.state` carries the FULL `UpdateState` on every transition (throttled progress
included) — the renderer store is a dumb mirror; no client-side transition logic.
`lastCheckedAt` (epoch ms) is set when a check round completes successfully
(available or not-available), preserved on errors.

## Contract surface (v1.13.0, additive)

- `domain/update.ts`: `UpdateStatus` (9 values), `UpdateUnavailableReason`
  (`not_packaged | no_feed`), `UpdateProgress`, `UpdateState` (status, unavailableReason,
  currentVersion, availableVersion, releaseDate, releaseNotes, progress, errorCode,
  message, lastCheckedAt).
- Methods: `update.getState`, `update.check` → `{ started }`, `update.download` →
  `{ started }`, `update.install` → `{ accepted }` (server: main).
- Event: `update.state` (source: main).
- Settings: `updateAutoCheck: boolean = true` (v1.13).
- Error codes (append-only, 5): `update_feed_invalid`, `update_check_failed`,
  `update_download_failed`, `update_install_failed`, `update_not_downloaded`.
- Fixtures: `updateState` added; `appSettings` extended with `updateAutoCheck`.
- Version constants: contracts 1.13.0, dc-protocol mirror 1.13.0.

## Test matrix

- Contracts: UpdateState parses the fixture; status/reason enums; notes cap; defaults for
  the new settings key (legacy fixture without it parses to default true); methods/events
  registries; version ≥ 1.13.0 pin.
- Main feed resolver: env https ok / env http → invalid / env unset + packaged with
  app-update.yml → implicit feed / unpackaged → not_packaged precedence over no_feed.
- Main controller matrix: precondition rejection (not_packaged manual check → honest
  unavailable + started=false), happy paths (check → available/not-available with
  lastCheckedAt), re-entry guards (check while checking; download while downloading;
  install when not downloaded), download gating on status, progress throttling + final
  flush, stale check ignored while downloaded, error classification, auto-check timer
  (fake timers: 2 min delay, 12 h period, live `updateAutoCheck=false` gate, stop()),
  install ordering (teardown callback BEFORE port.install).
- Renderer: store load/check/download/install rpc shapes + `update.state` mirror.

## Non-goals (honest scope)

- No multiple release channels — one stable feed (the phase title's "channel" is the
  distribution channel itself; a channel picker would be UI for something that does not
  exist yet).
- No staged rollout / force-update semantics; no silent auto-install restarts — the user
  always consents, and `autoInstallOnAppQuit` is surfaced in UI copy.
- Actual installer signing and feed hosting are Phase 19 / release-engineering concerns;
  this phase delivers the client that consumes them.
