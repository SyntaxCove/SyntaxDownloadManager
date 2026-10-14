# Phase 18 Report — Auto-update channel

Status: DELIVERED (2026-10-14). Contracts 1.12.0 → **1.13.0** (additive). Storage stays v9.
Plan: `docs/phase-18-plan.md`. Commit: `phase(18)`.

## What shipped

The app can now keep itself current: it resolves an update feed (fail-closed), checks it on
a consent-gated schedule, downloads a found update only when the user clicks, verifies it
(electron-updater's feed-embedded sha512 + blockmap integrity), and applies it — either on
the next quit or through an explicit "Restart to update" — with the same teardown path as
a real quit. The Rust core learns nothing about updates; the whole domain is main-process.

## Architecture

- **`domains/updates.ts` (pure, fully tested)** — `resolveUpdateFeed` (env `UNIDM_UPDATE_FEED_URL`
  https-validated → packaged `resources/app-update.yml` → classified `none`), the
  `UpdateController` state machine (`idle → checking → available|not-available →
  downloading → downloaded → installing`, plus `error`/`unavailable`), progress throttling
  (500 ms floor, final flush at 100), release-notes/message sanitization, and
  `registerUpdateDomain` for the four `update.*` methods.
- **`domains/updates-adapter.ts` (thin glue, untested)** — electron-updater **6.8.10**
  (exact pin; npm dist-tag `v26`, pairing the electron-builder 26 line Phase 19 will use)
  configured `autoDownload=false`, `autoInstallOnAppQuit=true`, `allowDowngrade=false`,
  `disableWebInstaller=true`; its events drive the controller; the env feed goes through
  `setFeedURL({ provider: "generic", url })`, the packaged `app-update.yml` is implicit.
  A no-feed install gets a port that throws classified `UniDmError`s — defense in depth
  behind the controller's guards.
- **`main.ts` wiring** — controller constructed after the tray (the install teardown needs
  both), methods registered, snapshots emitted through `router.emit` (zod-validated,
  dropped-not-sent on drift), auto-checks started, timers cleared on `before-quit`.
- **Renderer** — `stores/updates.ts` (dumb mirror of `update.state`), a Settings
  "Updates" section (current version, status line, progress bar, release notes, error
  MessageBar, Check now / Download update / Restart to update, auto-check switch, honest
  consent copy). No feed URLs and no paths ever reach the renderer (Phase 10 toolkit
  precedent).

## Decisions that matter

1. **electron-updater as transport, our controller as policy.** Security (priority #2)
   outranks maintainability: NSIS choreography, differential blockmap downloads and
   sha512 verification are a decade of battle-tested edge cases; re-implementing them is
   a bigger integrity risk than adopting the vetted engine. Every DECISION (consent,
   gating, classification, ordering) stays in our tested controller.
2. **Install-before-teardown ordering, pinned by test.** `quitAndInstall` may not run
   `before-quit` on every electron-updater version, and the Phase 17 close-to-tray
   handler would hide instead of closing. `install()` therefore runs the quit teardown
   (quitting flag → tray destroy → supervisor stop) BEFORE `port.install()`; the test
   asserts the exact sequence `["teardown", "port.install"]`.
3. **A stale check never clobbers progress.** `onAvailable`/`onNotAvailable`/`onChecking`
   are ignored while `downloading|downloaded|installing` — a background refresh arriving
   mid-download cannot wipe the user's consented state.
4. **Dev never self-updates.** Unpackaged runs resolve to `unavailable/not_packaged`
   even with an env URL set; an http env URL is classified `update_feed_invalid`, never
   a silent direct-HTTP fallback.
5. **Error vocabulary.** Five append-only codes (`update_feed_invalid`, `update_check_failed`,
   `update_download_failed`, `update_install_failed`, `update_not_downloaded`) plus the
   existing `invalid_state` for download-without-available; `onUpdaterError` classifies
   electron-updater's opaque `error` event by current phase.

## Honesty notes (not hidden)

- **Integrity vs authenticity.** For an unsigned installer the guarantee is integrity:
  https transport + feed-embedded sha512 + blockmap. Authenticity (code signing +
  publisher verification) is a Phase 19 / release-engineering concern; the Settings copy
  claims exactly what is verified, nothing more.
- **No release channels, no force updates, no silent restarts.** One stable feed;
  `autoInstallOnAppQuit` is surfaced in the UI copy ("applies when you quit UniDM").
- **The `installing` event may never reach the renderer** (the IPC channel dies with the
  app); the UI treats the `update.install → { accepted: true }` response as the terminal
  signal.

## Verification

- `scripts/verify-all.sh` end-to-end "all checks passed": typecheck ×2 clean; cargo
  fmt/clippy `-D warnings` clean; **cargo test 268** (unchanged, by design — zero core
  surface beyond the mirrored `CONTRACT_VERSION` 1.13.0); **contracts vitest 109** (was
  102: fixture parity, registries, error-code tail, enums, caps, legacy-settings default);
  **desktop vitest 260 passed + 1 skipped** (was 223 + 1: 33 main-process engine tests —
  feed matrix, consent gates, throttling, stale-check protection, install ordering,
  auto-check timing — plus 4 renderer store tests); vite build green.
- Sandbox note: the Rust toolchain was wiped again by the environment reset (11th time)
  and re-provisioned via `scripts/rustup-init.sh` (rustup 1.99.0 + rustfmt + clippy)
  before the gate ran.

## Contract surface (v1.13.0, additive)

- `domain/update.ts`: `UpdateStatus` (9 values), `UpdateUnavailableReason`
  (`not_packaged | no_feed`), `UpdateProgress`, `UpdateState`, params/results for the
  four methods, `UpdateStateEvent`.
- `settings.ts`: `updateAutoCheck` (default true) + `SETTINGS_DEFAULTS` + fixture.
- `errors.ts`: 5 append-only codes.
- `methods.ts` / `events.ts`: `update.getState/check/download/install` (main),
  `update.state` (main).
- Fixture `updateState` (downloaded snapshot) + `appSettings.updateAutoCheck`.
- `dc-protocol` mirror: `CONTRACT_VERSION = "1.13.0"` (fails fast on mismatch, unchanged
  otherwise).

## Follow-ups

- Phase 19 (packaging) must generate the feed (`latest.yml` + blockmap) and
  `app-update.yml` via electron-builder `publish` config; the client consumes them as-is.
- Release engineering: decide the feed host and add installer signing — with a signing
  cert, electron-updater's publisher verification turns the integrity guarantee into an
  authenticity guarantee without any client change.
