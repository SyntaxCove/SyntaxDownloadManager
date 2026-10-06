# Phase 2 — Electron Main Shell + Typed IPC (delivered)
**Plan**: single-instance lock → `app.enableSandbox()` before ready → shell window
(titleBarOverlay on Win32) → transport-agnostic `IpcRouter` bound to `ipcMain.handle` with a
sender firewall (only our own renderer/dev origin may call RPC). Preload is a sandboxed CJS
esbuild bundle exposing exactly `window.unidm.rpc/onEvent`. Strict CSP both as meta tag and as a
header hook. Feature domains register on the router in their own phases (3/4/5) — the shell never
grows feature-specific code.
**Electron 44 API verification**: `BrowserWindow.getAllWindows()` (not app.*), session-level
`setPermissionRequestHandler`, new `will-navigate` (details, url) signature — checked against
electron.d.ts, not memory.
**Test**: 17 vitest cases — router param/result validation, parse_error/invalid_params/
method_not_found mapping, typed error conversion, protocol-version enforcement, event payload
validation drop policy, duplicate registration rejection, dev/prod path resolution, sender
firewall allow/deny matrix, sandbox-hardened webPreferences, deny-by-default permissions.
**Fix**: Electron 44 typings drift (three API call sites corrected); tests excluded from tsc emit
via tsconfig.build-main.json; vite config renamed .mts for CJS package.
**Result**: commit `phase(2)`; build emits dist/main + dist/preload.cjs + dist/renderer.
GUI smoke test (window opens, dev server URL) runs on the user's Windows device.
