# Phase 32 Report — post-1.0: editable browser user-agent + browser pane fill fix

Status: DELIVERED (2026-10-20). Plan: `docs/phases/phase-32-plan.md`. Contract
**1.16.0 → 1.17.0 (additive)** — a new optional settings field and one new read-only
main method; the wire stays backward-compatible and the `dc-protocol` mirror const
matches. App **1.0.0 → 1.1.0** (all manifests, final-qa-enforced).

## Feature: editable browser user agent (U-1…U-4)

- **Contracts 1.17.0 (additive):** `AppSettings.browserUserAgent` — string, max 512,
  default `""` (= the Electron/Chromium default, unchanged). New main-served method
  `browser.getUserAgent` → `{ userAgent, isCustom }`. Settings never cross to the core,
  so the only core-side change is the version-handshake constant.
- **TabManager:** captures the pristine Electron UA from the `persist:browser` session
  *before* any override is applied (otherwise a later reset would have nothing to reset
  to); `setUserAgent(custom | null)` applies live to the browser session AND every
  already-created per-proxy session; null/empty/whitespace (trimmed) resets to the
  captured default; sessions created later are born with the override already applied.
- **Wiring:** main.ts applies the persisted value right after the browser domain
  registers (before the first tab can exist) and re-applies on every `settings.changed`.
- **Settings UI (en + fa):** a localized section showing the effective UA (monospace,
  selectable) with a default/custom badge, an editable field (max 512 enforced in both
  the UI and the contract), Save (dirty-gated) and Reset-to-default (persists `""`).
  The hint states the honest semantics: `session.setUserAgent` affects loads from the
  moment it is applied, so already-open pages pick the new UA up on their next
  navigation/reload.

## Fix: browser pane fill (L-1)

Root cause, proven in a real Chromium by measuring the exact production DOM/CSS chain
(`scripts/layout-repro.cjs`): `FluentProvider` carries `display: flex` with **no
flex-direction** — a row container. The AppShell, its flex item, therefore shrank to
*content* width: in a 1280×800 window the shell measured **248 px** wide, the content
pane **32 px**, and the browser hole **0 px** wide (658 px tall) — everything crammed
into the left edge, the rest of the window empty. Heights were never the problem; the
width chain was.

Fix (two lines, mutually reinforcing): `flexDirection: "column"` on the FluentProvider
wrapper (the sole child then stretches across the cross axis) and `width: "100%"` on
the shell root (explicit fill regardless of the wrapper). Post-fix measurements in the
same harness: shell 1280 px, content 1064 px, browser hole **1032×658** — the full
window minus the sidebar and content padding. The repro script stays in the repo as
the regression harness for shell geometry (run: `NODE_PATH=<global node modules>
node scripts/layout-repro.cjs`).

## Tests

- **Contracts (+2):** `browserUserAgent` defaults/bounds (empty default, >512 rejected,
  non-string rejected) and the `browser.getUserAgent` method shape (main-served, typed
  result, `isCustom` required).
- **TabManager UA (+6, new suite):** with Electron stubbed at its exact port boundary
  (`session.fromPartition`, `WebContentsView`) the real manager code is exercised:
  default capture, override applied pre- and post-session creation, live re-application,
  reset semantics (null/empty/whitespace), trimming, and proxy sessions receiving both
  the initial override and later live changes.
- **i18n parity** is enforced automatically by the existing suite (fa keys are a
  `Record<keyof settingsEn, string>` and placeholder parity is re-checked).

## Verification

- `scripts/verify-all.sh` end-to-end on the 1.1.0 sources: **all checks passed** —
  typecheck clean; vitest **128 contracts + 406 desktop** green (incl. the E2E suites
  over the real debug core binary); renderer build ok with the Phase 22 budget gate
  respected; checksums + SBOM + final-qa selftests ok; **npm audit --omit=dev: 0
  vulnerabilities**; fmt/clippy clean; **300 cargo tests** green.
  (Log: `tool-results/verify-all-p32.log`.)
- Post-push, real runs: CI run **39416500781** (commit d09c377) — both jobs green.
  Release pipeline run **39417048782** (tag v1.1.0) — **success**; published
  "Syntax Download Manager v1.1.0" with 10 assets.
- Byte-level acceptance: `latest.yml` carries `version: 1.1.0`; published SBOM
  `sha256sum -c` OK (356 components, app `syntax-download-manager 1.1.0`); published
  portable zip (167,843,398 B) `sha256sum -c` OK — 131 entries, all CRCs OK.
