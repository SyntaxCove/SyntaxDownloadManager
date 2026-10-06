# Phase 3 — Renderer Foundation + Settings Domain (delivered)
**Plan**: React 19 + Fluent UI v9 renderer (Vite build, strict CSP). Theme engine resolves
system/light/dark against live OS preference; document dir/lang follows language (fa=RTL is
structural from day one; string localization is Phase 21). Zustand settings store with optimistic
update + rollback; settings domain in main persists to userData/settings.json atomically
(tmp+rename), merges contract defaults for forward compatibility, quarantines corrupt/invalid
files and reinstates defaults. `settings.get` / `settings.setAll` + `settings.changed` event on
the validated router. Contracts gained SETTINGS_DEFAULTS and the UnidmBridge type.
**Test**: 24 cases (11 settings-domain): defaults/first-run, atomic persist without tmp leftovers,
reload round-trip, default-merge, corrupt-JSON quarantine, schema-invalid quarantine, invalid
patch rejection, RPC get/setAll/invalid_params, settings.changed emission.
**Fix**: quarantine now re-persists defaults (stable state on next run); event assertion matched
actual payload shape; Griffel vendor-prop handling moved to inline styles.
**Result**: commit `e35fbd6`. GUI walkthrough on the user's Windows device.
