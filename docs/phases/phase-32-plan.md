# Phase 32 Plan — post-1.0: editable browser user-agent + browser pane fill fix

Source: user request (Persian, 2026-10-20): (1) show the current user agent in Settings
and make it editable; (2) fix the browser pane, which rendered small and left most of
the window empty in browse mode — everything except the sidebar must be filled by the
browser. This is the first post-1.0 iteration; it re-uses the phase discipline
(plan → implement → test → fix → document → review → commit → release). Contract
**1.16.0 → 1.17.0 (additive)**; app **1.0.0 → 1.1.0**.

## Work items

| # | Item | Detail |
|---|------|--------|
| U-1 | Contracts 1.17.0 (additive) | `AppSettings.browserUserAgent` (string, max 512, default `""` = Electron default); new main-served method `browser.getUserAgent` → `{ userAgent, isCustom }` (the effective UA + whether an override is active). Settings never cross to the core, so only the version handshake moves; the `dc-protocol` mirror const is bumped to match. |
| U-2 | TabManager UA support | Capture the pristine Electron UA from the browser session before any override; `setUserAgent(custom \| null)` applies live to the `persist:browser` session AND every per-proxy session (null/empty/whitespace = reset to the captured default; values trimmed); `getUserAgent()` reports the effective string. New sessions are created with the override already applied. |
| U-3 | Wiring | main.ts applies the persisted `browserUserAgent` right after the browser domain registers (before the first tab can exist) and re-applies on every `settings.changed` (live). New `browser.getUserAgent` handler in the browser domain. |
| U-4 | Settings UI | New localized section "Browser user agent": the current effective UA (monospace, selectable) with a default/custom badge, an editable field (max 512), Save (dirty-gated) and Reset-to-default (persists `""`). En + fa dictionaries; applied-on-next-load semantics documented in the hint. |
| L-1 | Browser pane fill fix | Root cause (proven in real Chromium via `scripts/layout-repro.cjs`): `FluentProvider` renders as a **row** flex container, so the AppShell — a flex item — shrank to content width (~250 px of 1280) and the browser hole collapsed with it; the rest of the window stayed empty. Fix: `FlexDirection: column` on the FluentProvider wrapper + explicit `width: 100%` on the shell root. Repro measures the viewport at 1032×658 in a 1280×800 window after the fix (was effectively 0×658). |
| L-2 | Repro tool kept | `scripts/layout-repro.cjs` (Playwright/Chromium) stays as the durable regression harness for the shell geometry; run: `NODE_PATH=<global modules> node scripts/layout-repro.cjs`. |

## Acceptance criteria

- The Settings page shows the actual current UA string and badges default/custom; edits
  persist, apply live (new loads in every tab, proxied tabs included), and reset cleanly.
- The browser pane fills the window minus sidebar in browse mode at any window size.
- Contracts 1.17.0 additive-only (no wire break; core handshake passes); dc-protocol matches.
- Full `verify-all.sh` green incl. the final-QA gate; new tests: contracts (+2),
  TabManager UA (+6 with a stubbed Electron port boundary), i18n parity automatic.
- App 1.1.0 across all manifests (final-qa enforced); release v1.1.0 through the pipeline.
