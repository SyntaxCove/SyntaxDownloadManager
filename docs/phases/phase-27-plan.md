# Phase 27 Plan — Docs (in-app help, FAQ, troubleshooting)

Status: draft → delivered 2026-10-19 · Contract **stays v1.15.0** (no wire change) ·
App 0.13.0 → 0.14.0

## Scope (from docs/PHASES.md)

"Docs — in-app help, FAQ, troubleshooting". The app already documents itself in code and
in `docs/` for developers; its users get explanations only from scattered empty states
and hints. This phase adds a first-class **Help surface inside the app** — topic guides,
a FAQ, and step-by-step troubleshooting that speaks the same typed error vocabulary the
engine actually emits — fully localized in **English and Persian (RTL)** per the Phase
21 i18n system, and cross-linked with the Phase 20 diagnostics page.

## Design

### Content (structured data, not prose blobs)

- `pages/help/content.ts` — three typed arrays as the single content registry:
  `HELP_TOPICS` (10 guides: getting started, downloads, browser, proxies, media
  toolkit, torrents, scheduler, library, updates, privacy & security), `HELP_FAQ`
  (10 questions), `HELP_TROUBLE` (9 troubleshooting entries). Each entry holds i18n
  **keys** (never text), so every string renders through the Phase 21 translator and
  every key is compile-locked to exist in both languages.
- Troubleshooting entries speak the engine's own vocabulary: `source_gone`,
  `source_forbidden`, `source_changed`, `network_error`, `http_error`,
  `proxy_profile_not_found`, supervision states (`restarting`/`unavailable`), toolkit
  tool states, and the fail-closed proxy rule — the same facts the diagnostics health
  report exposes. Entries that are diagnosed in Diagnostics carry an
  `openDiagnostics` flag.
- Content sourcing: ARCHITECTURE.md semantics (fail-closed proxies, supervision/backoff,
  durable cursors, WAL+FULL), the Phase 21/22/26 user-facing facts (language switch,
  checksums, SmartScreen/unsigned note), and the policy stance (no AI, no DRM
  circumvention, local-first).

### i18n (`i18n/dict/help.ts`)

- `helpEn` + `helpFa: Record<keyof typeof helpEn, string>` spread into the composed
  dictionaries — key parity, non-empty values and `{placeholder}` parity are then
  enforced by the existing `__tests__/i18n.test.ts` for free.
- Persian copy follows the established style: ZWNJ (U+200C) orthography, `nav.help` =
  «راهنما» (Diagnostics stays «عیب‌یابی» — no collision).

### Page (`pages/HelpPage.tsx`)

- Three in-page tabs (Fluent `TabList`): Topics / FAQ / Troubleshooting; a `SearchBox`
  filters the visible tab client-side (pure `filterHelp()` in content.ts, tested).
- Topics and FAQ render as `Accordion` sections (one per entry); troubleshooting
  renders as symptom cards: causes, then ordered steps, plus an **Open diagnostics**
  button for flagged entries (AppShell passes `onOpenDiagnostics` — view state stays a
  local `useState`, no store change).
- An **About** card reuses the pull-only diagnostics store (`report.app.version`,
  `versions.contract`) like DiagnosticsPage.
- Griffel `makeStyles` + logical properties (RTL-correct); directional icons mirror on
  `dir`; section `aria-labelledby` ids per the Settings/Diagnostics idiom.

### Nav

- `AppShell`: `View` gains `"help"`, `NAV` gains
  `{ id: "help", key: "nav.help", icon: <QuestionCircleRegular /> }` between
  Diagnostics and Settings; content switch renders the page.

### Small i18n defect fixed en route (F-1)

- `stores/diagnostics.ts` published two hardcoded-English toast titles ("Diagnostics
  exported" / "Export failed") — the only unlocalized user-visible strings left from
  Phase 21. Fixed via `currentT()` with new `diag.toast.*` keys in both dictionaries
  (the toasts bus itself already consumes `currentT()` elsewhere, so this is the
  established seam, not a new one).

### Tests (`__tests__/help.test.ts`, pure TS per repo convention)

- Structure invariants: unique ids; every topic/faq/trouble key resolves via
  `translatorFor("en")` **and** `translatorFor("fa")` without throwing and yields
  non-empty text; step/cause arrays non-empty; `openDiagnostics` entries render-ready.
- Cross-vocabulary lock: every error code named in troubleshooting copy exists in the
  `downloads.hint.*` key set (so docs can never drift from the engine's codes).
- `filterHelp()`: matching by English and Persian queries, empty-query passthrough,
  no-match behavior.

## Verification plan

- Local: `verify-all.sh` green (contracts + desktop + cargo unchanged + new help tests;
  budget gate — help page must not breach the renderer bundle budget).
- Real CI: push → GitHub Actions run green (both jobs).
- Release v0.14.0: tag push → the Phase 26 pipeline builds and publishes the release
  end-to-end (the pipeline's second real run — repeatability proof), notes intro +
  checksum table intact (F-2 fix verified in production), assets checksum-verified.

## Out of scope (honest notes)

- No PDF/website manual; the in-app surface is the deliverable, README remains the
  repo-level doc.
- No contextual "press F1" help-overlay wiring; deep links stay page-level.
- Persian copy is authored by the project (not professionally translated); the Phase 21
  translation-review note still applies.
