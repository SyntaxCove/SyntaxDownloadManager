# Phase 16 Plan — Settings domain completion

Status: PLANNED (2026-10-13). Prior state: Phases 0–15 delivered (git `e209412`).
Contracts 1.10.0 → **1.11.0** (additive). Storage stays v9 (no new persistence layer).

## Scope — where this phase comes from

Two behaviors were **explicitly deferred to this phase by earlier phases**:

1. "Directory picker arrives with the settings-completion phase (Phase 16); free-text absolute
   path is the Phase 3 surface." (SettingsPage comment since Phase 3.)
2. "Settings-level 'default proxy for all new downloads' (Phase 16 domain completion)."
   (phase-9-plan.md non-goal.)

Around those two deferrals, "settings domain completion" means closing the remaining
coherence gaps of the settings domain as it exists today:

3. **Settings liveness on core restart** — today only `proxy.setRuntime` and toolkit paths are
   re-pushed when the core restarts. `download.setConcurrency` is *never* re-applied (a
   restarted core runs on env defaults) and `download.setPolicy` / `scheduler.setClock` heal
   only within the 10-minute drift timer. All three moves into the core "ready" handler
   (idempotent pushes, already safe with the Phase 15 set_clock catch-up guard).
4. **Settings never reference a nonexistent profile** — removing a proxy profile that is the
   configured default leaves a dangling `defaultProxyProfileId`. `proxy.remove` clears it and
   emits `settings.changed` so every window updates.
5. **Restore-defaults affordance** on the Settings page (uses the existing
   `settings.setAll` + `SETTINGS_DEFAULTS`; confirmation dialog required — it overwrites every
   preference).

## Design decisions

### Default proxy: main-side injection (the core never learns settings)

The setting is `defaultProxyProfileId: Ulid | null` (null = direct). The injection point is
**main's `download.create` handler**, not the Rust core:

- A renderer-issued `download.create` that **omits** `proxyProfileId` gets the configured
  default injected by main before proxying to the core (a `null` default keeps the field
  omitted — exactly today's wire shape).
- An **explicit `null`** is "direct" and passes through untouched; an explicit profile id
  passes through untouched. The wire already distinguishes omitted vs null
  (`Ulid.nullish()`), and zod validation runs *before* injection, so the core receives an
  already-valid `DownloadCreateParams`.
- The core stays settings-free (no `QueuePolicy` / `SetPolicyParams` / wire changes; zero Rust
  surface for this feature). A run whose profile is missing from the runtime map keeps the
  Phase 9 fail-closed semantics: pause with `proxy_profile_not_found`, never a silent direct
  fallback.
- **Creation-time semantics**: the profile is persisted on the job row at creation
  (storage v5 field, unchanged). Later settings changes never rewrite existing jobs; per-job
  `download.setProxy` stays the explicit override.
- **Scheduler jobs keep Phase 15 semantics** (payload frozen and validated at
  `scheduler.create`): they bypass main's create handler by design. Instead of silently
  ignoring the default there, the Scheduler page's `download.create` form gains an explicit
  proxy picker (Direct pre-selected — the privacy-safe choice; a scheduled download never
  silently routes through a proxy the user did not see).

### `app.pickDirectory` (main method)

Params `{}`, result `{ path: string | null }` (null = user canceled). Served by main via
`dialog.showOpenDialog` with `openDirectory` (+ `createDirectory` where the platform supports
it), parented to the focused window when one exists. The renderer uses it for the download-dir
"Browse…" button; the free-text input stays (absolute path, same contract).

### Downloads page create form honesty

Today `proxyChoice: null` is labeled "Direct" *and* is the omitted wire shape — after this
phase omitted means "app default", so the form becomes explicitly three-way:
**App default** (omit; label states it follows Settings) / **Direct** (`null`) / **profile**.
With no default configured, "App default" behaves exactly as today (direct).

## Contracts v1.11.0 (additive)

- `AppSettings.defaultProxyProfileId`: `Ulid.nullable().default(null)`; `SETTINGS_DEFAULTS`
  gains the key. `DownloadCreateParams.proxyProfileId` doc comment updated (schema unchanged).
- New main method `app.pickDirectory` (`{}` → `{ path: string | null }`).
- `fixtures/domain.json`: `appSettings` gains the key (valid ULID); contracts tests: version
  pin → 1.11.0, default/validation/fixture coverage, registry routing for the new method.
- dc-protocol: version constant bump only (settings and `app.pickDirectory` never cross the
  core boundary; `download.create` wire is unchanged).

## Layer-by-layer changes

| Layer | Files |
|---|---|
| contracts | `src/domain/settings.ts`, `src/domain/download.ts` (comment), `src/protocol/methods.ts`, `src/version.ts`, `fixtures/domain.json`, `test/contracts.test.ts`, `package.json` |
| dc-protocol | `src/lib.rs` (version constant) |
| main | `domains/app-dialogs.ts` (new), `domains/download.ts` (injection + settingsStore), `domains/proxy.ts` (remove clears default), `main.ts` (wiring + ready-state re-apply) |
| renderer | `stores/downloads.ts` (create signature), `pages/SettingsPage.tsx` (Browse + default proxy + restore defaults), `pages/DownloadsPage.tsx` (3-way picker), `pages/SchedulerPage.tsx` (proxy picker for `download.create`) |

## Tests

- **contracts**: defaultProxyProfileId default-null / accepts ULID / rejects non-ULID;
  `app.pickDirectory` registry entry (server "main"); fixture parse; version 1.11.0.
- **main (vitest)**: new `download-domain.test.ts` — injection (omitted+default → injected;
  omitted+no default → omitted; explicit null/id pass through) and passthrough of every other
  method; new `app-dialogs.test.ts` — picked path / canceled → null; `proxy-domain.test.ts` —
  removing the default profile clears the setting and emits `settings.changed`, removing an
  unrelated profile leaves it; `settings-domain.test.ts` — new default round-trips
  (existing `toEqual(SETTINGS_DEFAULTS)` tests keep guarding defaults coherence).
- **renderer (vitest)**: `downloads-store.test.ts` — create wire shapes (undefined → omitted,
  null → explicit null, id → id).

## Non-goals (honest scope)

No settings export/import, no per-domain settings pages beyond the existing single page, no
new engine keys (the core keeps zero settings knowledge), no scheduler-side default-proxy
fallback (the scheduler form's proxy is explicit and frozen with the payload), no i18n of the
new strings (Phase 21), no startup-behavior keys (launch-at-login etc. — tray/startup UX is
Phase 17 territory), no media/torrent-specific default dirs (they intentionally follow
`downloadDir` today; a per-domain dir is future work if wanted).
