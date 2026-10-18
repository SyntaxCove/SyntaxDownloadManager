# Phase 23 Plan — Security audit (IPC surface, CSP, permission policy review)

Status: draft → delivered 2026-10-18 · Contract **stays v1.15.0** (no IPC surface change) ·
App 0.9.0 → 0.10.0

## Scope (from docs/PHASES.md)

"Security audit — IPC surface, CSP, permission policy review." This is an **audit phase**:
systematically re-verify every trust boundary the product owns, fix what the audit finds,
and lock each fact with a test so it cannot regress silently. Engineering priority
(data integrity > security > …) makes this the highest-ranked non-integrity work in the
phase map.

## Audit surface (12 boundaries, all re-read line by line)

| # | Boundary | Where | Verdict |
|---|----------|-------|---------|
| 1 | IPC transport & router validation | `src/main/ipc/router.ts` | OK — envelope + per-method zod params/results, unknown → `method_not_found`, double-register throws, invalid events dropped (never propagated) |
| 2 | Sender firewall (who may call RPC) | `src/main/ipc/electron-rpc.ts` | **Hardened (F-B)** — was frame-URL substring only |
| 3 | webPreferences, shell window | `src/main/security.ts`, `window.ts` | OK — sandbox on, contextIsolation on, no node anywhere |
| 4 | webPreferences, browser tabs | `src/main/domains/tab-manager.ts` | **Tightened (F-D)** — `webSecurity: true` now explicit at both creation sites |
| 5 | Permission policy, shell session | `window.ts` | **Tightened (F-C)** — sync permission *checks* were unhandled (Electron default) → now deny-by-default |
| 6 | Permission policy, browser sessions | `tab-manager.ts` | OK — allowlist `fullscreen, pointerLock, clipboard-sanitized-write, media, mediaKeySystem`; see finding note on `mediaKeySystem` |
| 7 | CSP | `index.html` meta + `window.ts` header | OK — meta covers dev **and** prod; header injection is file://-scoped belt-and-braces |
| 8 | Navigation & window opening | `window.ts`, `tab-manager.ts` | **Fixed (F-A)** — `shell.openExternal` was called with an unvalidated URL |
| 9 | webview / attach surfaces | global | **Fixed (F-E)** — webview is never used; global `will-attach-webview` deny added as a safety net |
| 10 | Renderer XSS sinks | renderer sources | OK — zero `dangerouslySetInnerHTML` / `innerHTML =` / `eval` |
| 11 | URL admission (bar + download core) | `url-input.ts`, Rust `media.rs`/`engine.rs` | OK — `javascript:`/`data:`/control chars rejected at the bar; core accepts http(s) only, rejects leading-dash argv tricks, format ids `arg_safe` |
| 12 | Secrets & update channel | proxy store, Phase 18 controller | OK — proxy credentials never appear in rules (login handler only); feed resolution fail-closed https |

## Findings → actions

- **F-A (fix)** `shell.openExternal(url)` in the shell `setWindowOpenHandler` forwarded
  *any* scheme to the OS (a `file:`/custom-scheme handoff is a known code-execution class
  on Windows). Fix: pure `isWebUrl()` gate — http/https only; anything else is dropped.
- **F-B (fix)** Sender firewall upgrades: (1) *session identity* — RPC is answered only
  when the sender runs on the default session (browser tabs live on `persist:browser` /
  `persist:proxy.*` and never get the preload bridge; this check makes that a hard fact,
  not an accident of preload plumbing); (2) *exact packaged-origin match* — the prod
  frame URL must equal `pathToFileURL(rendererIndex)` (hash tolerated, stripped on both
  sides) instead of a substring test; the legacy substring check remains only as a
  fallback when the packaged index path is unknown. Pure decision function
  `isTrustedRpcSender()` is fully unit-tested; the Electron wiring stays 4 lines.
- **F-C (fix)** Shell session gets `setPermissionCheckHandler` → deny-by-default for the
  synchronous check path (`navigator.clipboard` queries etc.). Browser sessions keep
  their allowlist handler only — denying checks there would break allowlisted features.
- **F-D (fix)** Browser tab `webPreferences` gain explicit `webSecurity: true`
  (both creation sites) — same value the platform defaults to, but defaults are not
  reviewable facts.
- **F-E (fix)** Global `app.on("web-contents-created")` → `will-attach-webview` is
  prevented everywhere, forever: the product has no `<webview>` usage and must never
  grow one silently.
- **F-note (document)** `mediaKeySystem` stays in the browser allowlist: it governs EME
  availability queries, no Widevine CDM is bundled, and granting it is *not* a DRM
  bypass (the product's no-circumvention rule is untouched — sites' player detection
  simply behaves like a normal browser).

## Verification

- New/extended unit tests (`security.test.ts`): `isWebUrl` ladder, deny-by-default
  checks handler, `isTrustedRpcSender` matrix (session identity × file/dev/foreign URLs,
  hash tolerance, legacy fallback), existing firewall tests stay green.
- Full gate `scripts/verify-all.sh` (typecheck, contracts+desktop vitest, vite build,
  budget gate, cargo fmt/clippy/test) must be green with the new tests.
- Contract version pinned unchanged (v1.15.0) — an audit must not move the wire.
