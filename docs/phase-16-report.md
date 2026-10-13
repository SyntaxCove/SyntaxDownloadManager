# Phase 16 Report — Settings domain completion

Status: DELIVERED (2026-10-13). Contracts 1.10.0 → **1.11.0** (additive). Storage stays v9.
Prior state: Phases 0–15 delivered (git `e209412`).

## What shipped

### 1. Native directory picker (the Phase 3 deferral, closed)
- New main method **`app.pickDirectory`** (`{}` → `{ path: string | null }`; `null` = the
  user canceled — a valid result, never an error). Served by a new `domains/app-dialogs.ts`
  via `dialog.showOpenDialog` (`openDirectory` + `createDirectory`), parented to the shell
  window when one exists. The Electron dialog surface is an injectable `DirectoryPicker`
  port, so the domain is unit-testable headlessly.
- The Settings page "Default download directory" row now has a **Browse…** button next to
  the free-text input (which stays — absolute paths remain the contract).

### 2. Settings-level default proxy for new downloads (the Phase 9 deferral, closed)
- New setting **`defaultProxyProfileId: Ulid | null`** (default `null` = direct), persisted
  in the existing atomically-written `settings.json` (no storage migration).
- **Injection is main-side**: main's `download.create` handler injects the configured
  default into requests that **omit** `proxyProfileId` (exported pure helper
  `applyDefaultProxy`). An explicit `null` stays "direct"; an explicit profile id passes
  verbatim. The wire distinguishes omitted vs null *before* serialization (`Ulid.nullish()`,
  zod-parsed first), and the Rust core receives an already-valid `DownloadCreateParams`.
- **The core never learns settings** — zero Rust surface for this feature (only the
  dc-protocol version constant moved). A run whose profile is missing from the runtime map
  keeps the Phase 9 fail-closed semantics: paused with `proxy_profile_not_found`, never a
  silent direct fallback.
- **Creation-time semantics**: the profile is persisted on the job row (storage v5 field,
  unchanged); later settings changes never rewrite existing jobs; per-job
  `download.setProxy` remains the explicit override.
- **Downloads page create form is now honestly three-way**: *App default* (omitted field,
  label states it follows Settings) / *Direct* (explicit `null`) / *profile*. With no
  default configured, "App default" behaves exactly as Phase 5 did (direct).
- **Scheduler payloads stay verbatim (Phase 15 semantics)**: they bypass main's create
  handler by design, so instead of silently ignoring the default there, the Scheduler
  page's `download.create` form gained an explicit proxy picker — **Direct pre-selected**
  (privacy-safe: a scheduled download is never proxied silently), frozen into the payload
  at save time and re-shown on edit.

### 3. Settings coherence: removing a profile clears a dangling default
- `proxy.remove` now clears `settings.defaultProxyProfileId` when it pointed at the removed
  profile and broadcasts `settings.changed`, so settings never reference a nonexistent
  profile. A `proxy_in_use` / `core_unavailable` refusal never mutates settings. Jobs keep
  their persisted Phase 9 fail-closed semantics either way.

### 4. Settings liveness on core restart (defect fix)
- Previously only `proxy.setRuntime` and toolkit paths were re-pushed when the core
  restarted: **`download.setConcurrency` was never re-applied** (a restarted core ran on env
  defaults) and policy/clock healed only within the 10-minute drift timer. All of
  `applyCoreLimits` / `applyCorePolicy` / `applySchedulerClock` now run in the core "ready"
  state handler next to the runtime re-pushes (idempotent; safe with the Phase 15 set_clock
  catch-up guard). The `whenReady` one-shot apply block is gone — every ready transition
  (boot, crash-restart) re-applies the full settings.

### 5. Restore-defaults affordance
- Settings page gained a confirm-guarded **Restore defaults** action (Maintenance section):
  it writes the full `SETTINGS_DEFAULTS` through the existing `settings.setAll` — jobs,
  history, profiles and files are untouched, stated explicitly in the dialog.

## Contracts v1.11.0 (additive)
- `AppSettings.defaultProxyProfileId` (`Ulid.nullable().default(null)`); `SETTINGS_DEFAULTS`
  extended; `DownloadCreateParams.proxyProfileId` doc comment documents the injection
  semantics (schema unchanged); new `app.pickDirectory` main method; `appSettings` fixture
  carries a valid ULID reference.
- `CONTRACT_VERSION` 1.11.0 mirrored in dc-protocol; npm package 1.11.0. The Phase 15
  version-pin test was generalized to a numeric ≥1.10 compare (the Phase 15 fix pattern) so
  the next minor bump cannot break it again.

## Layer-by-layer changes
| Layer | Files |
|---|---|
| contracts | `src/domain/settings.ts`, `src/domain/download.ts` (comment), `src/protocol/methods.ts`, `src/version.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` |
| dc-protocol | `src/lib.rs` (version constant) |
| main | `domains/app-dialogs.ts` (new), `domains/download.ts` (applyDefaultProxy + settingsStore), `domains/proxy.ts` (remove clears default), `main.ts` (wiring + ready-state re-apply) |
| renderer | `stores/downloads.ts` (3-state create), `pages/SettingsPage.tsx` (Browse + DefaultProxyField + restore defaults), `pages/DownloadsPage.tsx` (3-way picker), `pages/SchedulerPage.tsx` (frozen proxy picker) |

## Tests
- contracts **90** (was 84): default-null, ULID accept/reject, fixture parse, create-params
  omitted-vs-null-vs-id semantics, `app.pickDirectory` registry routing, version 1.11.0.
- desktop main **+main-domain tests**: new `download-domain.test.ts` (injection over IPC,
  parsed-shape defaults riding along, passthrough of every other method, settings-schema
  guard), new `app-dialogs.test.ts` (picked/canceled/boundary-refused), `proxy-domain.test.ts`
  (+3: clear-on-remove + event, unrelated keep, refusal never mutates), `settings-domain.test.ts`
  (+2: null↔Ulid round-trip, non-ULID rejection).
- desktop renderer: `downloads-store.test.ts` (+3: omitted / null / id wire shapes).
- Gate: `scripts/verify-all.sh` end-to-end **all checks passed** — cargo fmt/clippy -D
  warnings clean, **cargo test 268** (unchanged — zero Rust surface by design), vitest
  contracts **90**, desktop **201 passed + 1 skipped** (was 182 + 1), typecheck ×2, vite
  build green.

## Fixed during Test/Fix
- Router zod defaults ride along before injection (`overwrite: false` appears on the
  forwarded create params) — the test asserts the parsed shape, which is exactly what the
  core receives.
- `app-dialogs` readonly properties tuple vs Electron's mutable `OpenDialogOptions` type.
- Test fixture job id used `U` (outside the Crockford base32 alphabet) — renderer result
  re-validation caught it; replaced with a valid ULID char.
- Two test-file type errors surfaced only by the gate's `tsc` pass (vitest does not
  typecheck): zod output type requires `overwrite`, and the emit-wrapper schema parameter.

## Non-goals (honest scope)
No settings export/import; no per-domain settings pages; no engine-side settings knowledge;
no scheduler-side app-default fallback (the scheduler proxy is explicit and frozen); no i18n
of the new strings (Phase 21); no launch-at-login / tray keys (Phase 17); no media/torrent
default dirs (they intentionally follow `downloadDir`; a per-domain dir is future work if
wanted).
