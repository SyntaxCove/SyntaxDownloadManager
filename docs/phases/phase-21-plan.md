# Phase 21 Plan — Accessibility + i18n (fa / en)

Status: planned (2026-10-17) · Predecessor: phase 20 (diagnostics) · Contract: **no change** (v1.14.0 stays — `AppLanguage` "fa"|"en" has been in settings since v1.0)

## Authoritative scope

`docs/PHASES.md` row 21: "Accessibility + i18n (fa / en)".

## Ground facts discovered (code survey)

- The settings contract already carries `language: AppLanguage ("fa" | "en"), default "en"`;
  the Settings page already renders the selector, and `ThemeProvider` already applies
  `documentElement.dir/lang` from it. What is missing is every user-visible string (all
  pages are hardcoded English), component-level RTL (`FluentProvider` never receives
  `dir`), and a systematic accessibility pass.
- Toast titles are built outside React in two places: renderer `app/toasts.ts` (module
  constants) and main `domains/notify.ts` (`describeTransition`, exported for tests).
  Both need a non-React, locale-aware path.
- Real a11y gaps found by survey: Browse tab-strip divs have `role="tab"` but are not
  keyboard operable (no `tabIndex`, no Enter/Space); Media format tables select rows by
  mouse only; Library action buttons carry `title` but no accessible name; several
  progress bars and inputs lack labels; page titles are `Text` with no heading role.

## Design decisions

1. **Zero-dependency, typed, flat-key i18n** (no i18next — the dependency budget stays
   lean and the wire/product stays auditable):
   - `i18n/translate.ts` (pure): `interpolate` (`{name}` placeholders, unknown vars
     ignored, missing vars left visible), `pluralKey(base, n)` (`.one` / `.other`),
     `createT(dict, lang)`.
   - `i18n/dict/*.ts` — one section per surface, each file co-locating the English and
     Persian fragments for review; `i18n/dict/en.ts` composes the sections `as const`
     (its keys are the type `TKey`); `i18n/dict/fa.ts` composes the Persian fragments as
     `Record<TKey, string>` — a missing or extra Persian key is a **compile error**, and
     a runtime test re-checks the key sets anyway.
   - `i18n/context.tsx` — `I18nProvider` reads `settings.language` via the settings
     store, provides `{ t, lang, dir }`, and also maintains a module-level ref
     (`currentT()`), because toasts and store-level modules live outside React.
     Language switches apply **live** (no restart): context value changes re-render,
     `dir` flips structural layout, `documentElement.lang/dir` update.
2. **Locale-aware formatting** in `i18n/format.ts` (pure, Intl-based, injectable locale
   for deterministic tests): localized digits via `Intl.NumberFormat` (`fa-IR` renders
   Persian digits), bytes/speed/ETA/percent units through dictionary keys, dates via
   `Intl.DateTimeFormat` (fa resolves to the Persian calendar by ICU default — the
   expected behavior for Persian users), media duration mm:ss with localized digits.
   The shared `formatBytes` moves out of `DownloadsPage` into `format.ts`.
3. **Main-side notifications localize too** (Phase 17 surface): `describeTransition`
   gains an optional `lang: AppLanguage = "en"` (pure, test-seamed as before); the
   notify engine passes the live `settings.language`. `coreStateToast` decision logic
   stays in contracts (shared classifier, zero contract change); the renderer maps its
   outcome to localized keys by the already-known state.
4. **RTL correctness at the structural level**: `FluentProvider dir=` flips all Fluent
   components; flex layouts flip natively under `dir`; every **shell-chrome** physical
   offset (`paddingLeft`, `marginLeft: auto`…) becomes a logical property
   (`paddingInlineStart`, `marginInlineStart: auto`); directional icons that carry
   meaning (Browse back/forward, Diagnostics export arrow) swap to their RTL variants
   when `dir === "rtl"`. Inner page paddings are audited for the visible ones. Honest
   limit: deep per-style mirroring of every arbitrary inline offset is out of scope;
   nothing user-visible is known-broken after this audit.
5. **Accessibility fixes** (survey-driven, each verifiable in code):
   - Shell: skip-to-content link (focus-visible only) targeting a focusable `main`;
     localized nav labels; `aria-current` kept.
   - Browse tab strip: `tabIndex` + Enter/Space activation + focus ring + localized
     `aria-label`s; Back/Forward mirror in RTL.
   - Media tables: selectable rows become keyboard-operable (`tabIndex`, Enter/Space,
     visible focus), headers get `role="columnheader"`/cells `role="cell"` so the
     existing `role="table"` is actually valid.
   - Library/others: every icon-only button gets an explicit localized `aria-label`;
     progress bars get localized labels + value text; page titles become real headings
     (`as="h1"`, sections `aria-labelledby` kept).
   - Toasts: Fluent Toaster announces via its own live region (kept); intent icons are
     decorative (`aria-hidden`).
   - Screen-reader noise control: log tail keeps `aria-live="off"` (deliberate).
6. **Error strings**: engine/protocol error codes and `describeError` output remain
   English diagnostic data (they are protocol-level identifiers and log-searchable);
   every *label around them* is localized. Documented as a deliberate boundary.
7. **Versions**: app 0.7.0 → **0.8.0**; contracts untouched at 1.14.0; Rust untouched.

## Implementation order

1. Plan doc (this file).
2. i18n core: `translate.ts`, `format.ts`, `context.tsx`, dict scaffolding
   (`common` + per-page sections filled as each page lands).
3. Page rewrites in survey order (Browse → Downloads → Media → Torrents → Scheduler →
   Proxy → Library → Settings → Diagnostics) + AppShell/ToastHost/ThemeProvider wiring;
   each rewrite carries its dict section and its a11y fixes.
4. Main-side `i18n.ts` + `describeTransition`/notify wiring + test updates.
5. Tests: dictionary completeness/placeholder parity/interpolation/plural, formatting
   determinism (en + fa digits), direction resolution; notify fa strings.
6. Gates: typecheck, vitest (contracts + desktop), vite build, cargo fmt/clippy/test
   (unchanged, gate only), verify-all.
7. Docs (phase-21.md, PHASES.md, README), worklog, commit/push, tag v0.8.0, source
   release with honest notes (no binaries ship in this phase).

## Risks / honest limits

- Persian copy is authored by the engineer (fluent), reviewed once at phase review;
  it is product copy, not legal text.
- `Intl` ICU data ships with Electron/Node full-icu — Persian digits/calendar verified
  via tests on the sandbox runtime and expected identical on Windows (documented).
- The boot splash (`index.html`) stays English (pre-React, one brand line + a11y label);
  the app shell localizes immediately after mount.
