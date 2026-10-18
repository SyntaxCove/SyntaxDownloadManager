# Phase 23 Report — Security audit (IPC surface, CSP, permission policy review)

Status: DELIVERED (2026-10-18). Plan: `docs/phases/phase-23-plan.md`. Contract **stays
v1.15.0** (an audit must not move the wire). App → **0.10.0** (root + desktop + Rust
workspace, aligned; contracts manifest metadata realigned to 1.15.0).

## What the audit covered

Twelve trust boundaries were re-read line by line (full table in the plan): the IPC
transport and router validation, the RPC sender firewall, `webPreferences` on the shell
window and on every browser tab, interactive and synchronous permission policies, CSP
(meta tag + header), navigation and window-opening policy, webview attach surfaces,
renderer XSS sinks, URL admission (address bar + Rust core), argv hygiene of bundled
tools, secrets handling (proxy credentials, keychain), and the fail-closed update feed.

Verdicts: eight boundaries passed unchanged — the design decisions from phases 2, 4, 9
and 18 held up (single two-channel IPC namespace; zod-validated envelopes, params and
results on every method; browser tabs with no preload; proxy credentials only ever seen
by the `login` handler; http(s)-only + leading-dash rejection in the core; fail-closed
https feed resolution; zero XSS sinks in the renderer).

## Findings and fixes (all shipped in this phase)

1. **F-A — unvalidated OS handoff.** The shell `setWindowOpenHandler` called
   `shell.openExternal(url)` for *any* URL. A `file:` or custom-scheme handoff
   (`ms-msdt:`, `search-ms:`, …) is a known Windows code-execution class. Fix: pure
   `isWebUrl()` gate — http/https only; everything else is dropped without echoing.
   Locked by a 9-case scheme ladder test.
2. **F-B — sender firewall upgraded.** Trust was a frame-URL substring test. Now ALL of
   the following must hold: (1) *session identity* — the sender must run on the default
   session; browser tabs live on `persist:browser` / `persist:proxy.*` and never receive
   the preload bridge, and this makes that a hard fact; (2) *packaged-origin exactness* —
   in prod the frame URL must equal `pathToFileURL(rendererIndex)` (hash tolerated,
   stripped on both sides), so look-alike containment paths are refused; the legacy
   substring check survives only as a fallback when the packaged index is unknown
   (legacy callers/tests). The pure decision function `isTrustedRpcSender()` carries the
   whole matrix in unit tests: session identity × own/decoy/foreign URLs, deep-link
   hashes, wrong-port dev servers.
3. **F-C — synchronous permission checks.** The shell session had a deny-by-default
   *request* handler but no `setPermissionCheckHandler`, leaving the synchronous check
   path (clipboard probes, notification availability) on Electron defaults. Fix:
   `denyByDefaultChecks()` registered on the shell session. Browser sessions deliberately
   keep only their allowlist request handler — denying checks there would break
   allowlisted features.
4. **F-D — explicit `webSecurity: true`** on both browser-tab `webPreferences` creation
   sites. Same value the platform defaults to; defaults are not reviewable facts.
5. **F-E — global webview attach ban.** `app.on("web-contents-created")` now prevents
   `will-attach-webview` on every webContents the app ever creates. The product has no
   `<webview>` usage and must never grow one silently.
6. **F-note — `mediaKeySystem` stays allowlisted for browser tabs** (documented): it
   governs EME availability queries; no Widevine CDM ships with the app; granting it is
   not a DRM bypass and keeps site player detection behaving like a normal browser. The
   no-circumvention policy is untouched.

## Verification

- `scripts/verify-all.sh` end-to-end: **all checks passed** — typecheck clean;
  vitest **118 contracts + 335 desktop** (+7 new security tests) green; renderer build
  ok with the Phase 22 budget gate respected (bundle 1,079,543 B, unchanged); cargo
  fmt/clippy clean and **273 tests** green (Rust surface intentionally untouched).
- No behavioral change for the trusted shell renderer: same two IPC channels, same
  envelope semantics; the stricter firewall only rejects senders that were never part of
  the design.

## Honest scope note

This sandbox has no Electron binary, so the three Electron-runtime hardenings (F-C
handler registration, F-E global ban, and the session-identity leg of F-B at the
`ipcMain.handle` call site) are wired in the exact code paths that already carry their
phase-2 counterparts and are locked by unit tests at the pure-decision layer; on-device
confirmation happens with the next Windows run (`npm run dist` / `build-windows.ps1`),
consistent with the Phase 0 headless-testing policy.
