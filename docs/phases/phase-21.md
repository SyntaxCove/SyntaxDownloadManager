# Phase 21 — Accessibility + i18n (fa / en)

Status: **delivered (2026-10-17)** · Contract **unchanged at v1.14.0** (`AppLanguage` has been a settings key since v1.0) · App 0.7.0 → **0.8.0**
Plan: [`phase-21-plan.md`](phase-21-plan.md)

## What shipped

### 1. Zero-dependency, compile-checked i18n

- **Engine** (`apps/desktop/src/renderer/src/i18n/translate.ts`): flat literal-key
  dictionaries, `{name}` interpolation (missing placeholders stay visibly `{name}` — a
  UI bug is loud, never silently swallowed), explicit `.one`/`.other` plural pairs via
  `pluralKey`, and a `Translator` object carrying `lang` / `dir` / `locale`.
- **Dictionaries** (`i18n/dict/`): one section file per surface (common, browse,
  downloads, media, torrents, scheduler, proxy, library, settings, diagnostics) with the
  English and Persian fragments co-located for review. `en.ts` composes them `as const`
  and **its keys are the type**; `fa.ts` is `Record<TKey, string>` — a missing or extra
  Persian key cannot compile. 474 keys total per language.
- **Provider** (`i18n/context.tsx`): reads `settings.language`, exposes `useI18n()`, and
  mirrors the live translator into module scope (`currentT()`) because toasts localize
  outside React. Switching language in Settings applies **live** — no restart: context
  re-render + `FluentProvider dir` flip + `documentElement.lang/dir` sync.
- **Formatting** (`i18n/format.ts`): Intl-based, language-explicit, deterministic under
  test. `fa-IR` renders Persian digits (۱٬۰۲۴), the Persian calendar for dates (Jalali
  via ICU default — the expected presentation for Persian users), and `٪`/`٫`/`٬`
  symbols. The shared `formatBytes`/`formatEta` moved here from DownloadsPage (units
  stay the Latin technical standard — KiB/Mbps — in both languages by design).

### 2. Every user-visible string localized

All nine pages, the shell, navigation, dialogs, toasts, health cards, filters, empty
states, recovery hints, and the update-status line. Deliberately **not** localized
(honest boundaries): engine/protocol error codes (`source_gone`, `proxy_profile_not_found`…),
log records (diagnostic data, log-searchable), file/URL user data, technical literals
(`magnet:?xt=…`, `MKV/MP4`), and the pre-React boot splash (one brand line).

- Renderer toasts: titles resolve through `currentT()` at publish time; the core-state
  toast **decision stays in contracts** (`coreStateToast`), only the copy is mapped by
  the already-known state — zero classifier duplication.
- Main-side OS notifications localize too: `describeTransition(domain, kind, job,
  lang = "en")` resolves titles from `main/i18n.ts`; the notify engine passes the live
  `settings.language`. Bodies remain the job display name + protocol error code (user
  data, verbatim).

### 3. RTL correctness

- `FluentProvider` now receives `dir` — every Fluent component (menus, dialogs, tooltips,
  sliders) mirrors natively in Persian.
- Shell chrome physical offsets became logical (`paddingInlineStart`,
  `marginInlineStart: auto`); flex layouts flip under `dir` for free.
- Directional icons that carry meaning flip: Browse Back/Forward swap arrows in RTL,
  Diagnostics export uses `ArrowExportRtl` in RTL. Browse tab-strip arrow navigation
  follows the visual direction (ArrowLeft/Right semantics swap with `dir`).

### 4. Accessibility fixes (survey-driven)

- **Shell**: skip-to-content link (focus-visible only) targeting a focusable `main`
  landmark; localized primary-nav label; `aria-current` kept.
- **Browse tab strip** (real bug): `role="tab"` divs were mouse-only — now focusable
  (`tabIndex`), Enter/Space activatable, roving arrow-key navigation, focus ring.
- **Media format tables** (real bug): rows were mouse-only — now focusable with
  Enter/Space selection; `role="table"` made valid with `columnheader`/`cell` roles.
- Accessible names for every icon-only control (Library actions had `title` only);
  field labels wired via `aria-labelledby` (scheduler/proxy editors); localized labels
  on progress bars; decorative icons `aria-hidden`; intent icons in toasts
  `aria-hidden` (the text carries the meaning).
- Heading semantics: page titles are real `h1`s, cards/sections `h2`s (Diagnostics,
  Settings sections keep their `aria-labelledby` wiring).
- Log tail keeps its deliberate `aria-live="off"` (a chatty tail would flood screen
  readers); Fluent Toaster handles toast announcement via its own live region.
- Error-code text remains screen-reader-accessible as plain text (translated around,
  not hidden).

## Verification (all green)

- `npm run typecheck` (contracts + desktop main/renderer) ✅
- vitest: **112 contracts** + **314 desktop passed, 1 skipped (pre-existing)** ✅
- `vite build` + full desktop build ✅
- `cargo fmt --check`, `clippy -D warnings`, **270 cargo tests** ✅ (no Rust changes — gate only)

New tests (18 desktop): dictionary parity (fa key set == en key set), no empty values,
placeholder parity for every key, plural-pair completeness, interpolation semantics
(missing var stays visible, extra var ignored, zero stringifies), `pluralKey`,
`resolveDir`/`resolveLocale`, translator lang/dir/locale + unknown-key throw, en-US
formatting ladder (bytes/eta/percent/bitrate/duration/number/date) and fa-IR
formatting (Persian digits, `۱٫۵ KiB`, `۴۲٪`, Jalali `۱۴۰۵`), plus fa notification
titles in the main-side notify tests. Date tests use local-noon epochs to hold in any
timezone; fa calendar assertions rely on full-icu (Node/Electron default).

## Honest limitations

- Persian copy is authored in-repo and reviewed at phase review; it is product copy,
  not legal text. Terminology follows Windows Persian conventions (دریافت، زبانه،
  نشانک، پروکسی…).
- The pre-React boot splash stays English (documented scope boundary).
- `Intl` behavior (Persian digits, Jalali calendar) is provided by Electron/Node's
  full-icu — verified by tests in this sandbox and expected identical on Windows.
- Deep per-style mirroring of every arbitrary inline offset inside pages is out of
  scope; the audit covered all structural chrome and every known user-visible surface.
- This phase ships no binaries → no binary release; source release only (established
  user-side Windows packaging split from Phase 19).
