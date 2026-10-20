# Security & Privacy Review — final pre-1.0 sweep (Phase 30)

Status: DELIVERED 2026-10-20 (app 0.17.0). This is the durable record of the Phase 30
review: it re-verifies every Phase 23 trust boundary against the current sources
(phases 24–29 shipped after that audit), reviews the software supply chain, and
inventories every byte that leaves the device and every byte that stays. Evidence
cites real files and line-level anchors; the phase report (`docs/phases/phase-30.md`)
records what changed as a result.

## 1. Verdict

**PASS.** Twelve of twelve trust boundaries hold in their Phase 23 (or better) state;
no regression was introduced by phases 24–29. The supply-chain sweep produced six
findings (S-1…S-6): five fixed in this phase, one accepted with justification
(documented in §5). The privacy inventory confirms the product has **no telemetry, no
analytics, no crash reporting, no third-party network calls outside the flows the user
explicitly drives** — consistent with the no-AI ground rule.

## 2. Trust-boundary re-verification (Phase 23 → today)

| # | Boundary | Evidence (current) | Verdict |
|---|----------|--------------------|---------|
| 1 | IPC transport & router validation | `src/main/ipc/router.ts` — zod envelope/params/results on every method; unknown → `method_not_found`; double-register throws; invalid events dropped | OK, unchanged |
| 2 | Sender firewall | `isTrustedRpcSender()` in `ipc/electron-rpc.ts` — session identity + packaged-origin exactness (Phase 23 F-B), unit-locked in `__tests__/security.test.ts` | OK, unchanged |
| 3 | webPreferences, shell window | `security.ts` `secureWebPreferences()`: sandbox, contextIsolation, no node; `webSecurity: true` explicit (`security.ts:23`) | OK, unchanged |
| 4 | webPreferences, browser tabs | both creation sites carry explicit `webSecurity: true` (`tab-manager.ts:128,289` — Phase 23 F-D) | OK, unchanged |
| 5 | Permission policy, shell session | request handler deny-by-default + sync `denyByDefaultChecks()` (`security.ts:79`, Phase 23 F-C) | OK, unchanged |
| 6 | Permission policy, browser sessions | allowlist `fullscreen, pointerLock, clipboard-sanitized-write, media, mediaKeySystem`; `mediaKeySystem` stays documented (EME availability; no CDM ships) | OK, unchanged |
| 7 | CSP | meta covers dev+prod (`renderer/index.html:6-7`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`) + file://-scoped `onHeadersReceived` header (`window.ts:105`) | OK, unchanged |
| 8 | Navigation & window opening | `isWebUrl()` http/https-only gate (`security.ts:66`, Phase 23 F-A) still guards every `shell.openExternal` handoff | OK, unchanged |
| 9 | webview ban | global `will-attach-webview` deny on every webContents (`main.ts:52`, Phase 23 F-E) | OK, unchanged |
| 10 | Renderer XSS sinks | grep over renderer sources: **0** hits for `dangerouslySetInnerHTML` / `innerHTML =` / `document.write` / `eval(` (tests excluded) | OK, unchanged |
| 11 | URL admission (bar + core) | bar: `javascript:`/`data:` rejected, schemeless input coerced to http(s) (`domains/url-input.ts:32,39-40`); core: http(s)-only admission on every engine/media path (`manager.rs:889,1214`, `engine.rs:373,468`, `media.rs:231`) | OK, unchanged |
| 12 | Secrets & update feed | proxy passwords only ever decrypted inside the `login` handler (`domains/proxy.ts:179-202`); renderer results always `password: null`; feed resolution https fail-closed (`domains/updates.ts:55-64`) | OK, unchanged |

## 3. Privacy — data-flow inventory

### 3.1 What leaves the device (complete list)

| Flow | Destination | Trigger | Content | Evidence |
|------|-------------|---------|---------|----------|
| Auto-update check | `github.com/SyntaxCove/SyntaxDownloadManager` releases feed | app startup cadence (Phase 18 controller) + manual check | standard HTTP request, no identifiers beyond IP/User-Agent | `domains/updates.ts` — feed resolution is https fail-closed; env override must parse as https or startup refuses the feed |
| Bundled-tool fetch | pinned GitHub release URLs from `apps/desktop/resources/toolchains.json` | first run (if `mediaToolsAutoFetch`) or explicit repair | binary download only | `toolkit/verify.ts:41-53` — every staged artifact must match the manifest sha256, else loud failure and the tool is not adopted |
| Browsing / media inspection / downloads | whatever sites the user visits or downloads from | explicit user action | the user's own traffic; optionally routed through the user's proxy profile | Phase 4 browser engine, Phase 11 inspector, Phase 5+ engine |
| Torrent traffic | BitTorrent swarm of the user's chosen torrent | explicit user action | the user's torrent | Phase 13 engine |

There is **no other egress**. The renderer CSP forbids all non-self origins. The core
only opens sockets for job URLs (http/https) and BitTorrent peers. No error-reporting
service, no metrics SDK, no AI endpoint — the no-AI rule is structural, not a promise.

### 3.2 What stays on the device

| Data | Location | Notes |
|------|----------|-------|
| App settings | `userData/settings.json` (atomic writes; corrupt file renamed + defaults reinstated) | schema (`packages/contracts/src/domain/settings.ts:20-86`) carries no secrets — only a proxy *profile id* reference |
| Proxy profiles | `userData/proxy-profiles.json` | passwords stored **only** as `enc:v1:` + safeStorage (DPAPI on Windows) ciphertext (`proxy.ts:63,215`); plaintext never touches disk — storing without the OS keychain is refused (fail-closed, `proxy.ts:208-219`) |
| Download jobs, segments, journals | core SQLite database (supervised by main, never touched by the renderer) | Phase 5/6 |
| Browser history, bookmarks, library | core SQLite | Phase 14 |
| Logs | `userData/logs/*.jsonl` (Phase 20) | the logger **redacts** `scheme://user:password@host` URLs and secret-shaped query values (`token/key/secret/password/…`) before any write (`logging/logger.ts:46-56`) — this was re-read line by line this phase |
| Diagnostics export | user-picked directory, user-initiated zip | contains log files + a fresh `health-report.json`; the report embeds the settings object — **verified secret-free** (§3.1 of the settings schema: no credential field exists to leak); proxy passwords additionally never enter logs (redaction above) |
| Clipboard | OS clipboard | only explicit user actions (copy report, copy links) |

### 3.3 Secrets-handling audit (this phase)

- `grep` for password/secret material across `apps/desktop/src/main`: all hits are the
  safeStorage paths above or the logger redactor. No secret is passed to the renderer,
  logged, or embedded in exports.
- `safeStorage.isEncryptionAvailable()` false ⇒ profile save with password is refused —
  the store has no plaintext fallback by design (Phase 9, re-verified).
- Diagnostics zip content re-verified against the settings contract: the largest object
  it can contain (`settings`) has no credential fields.

## 4. Supply-chain review

Verified facts (unchanged, documented here as the baseline):

- **Lockfiles committed and authoritative**: `package-lock.json` (v3) and `core/Cargo.lock`;
  CI installs with `npm ci` — the lockfile is the build, not a suggestion.
- **Exact pinning**: all 25 external npm dependencies across the workspace are exact
  versions (no `^`/`~`/tags); the only range is the internal workspace link
  `@syntaxdm/contracts: "*"`.
- **Bundled binaries are hash-pinned**: every toolchain platform entry carries a sha256
  enforced at fetch time (§3.1); the release pipeline emits per-artifact sha256 sidecars
  and a checksum table (Phase 26).
- **Single publisher**: electron-builder runs `--publish never`; only `release.yml`
  publishes, and only for tags equal to the package version (version guard).

## 5. Findings and dispositions

| ID | Finding | Disposition |
|----|---------|-------------|
| S-1 | All GitHub Actions were referenced by mutable tags/branches (`@v4`, `@v2`, `@stable`) — a hijacked or pushed-over tag would execute in this repo's context | **FIXED** — every `uses:` in ci.yml / release.yml / security-audit.yml pinned to a full commit SHA (checkout v4.4.0 `11d5960a…`, setup-node v4.4.0 `49933ea5…`, rust-cache v2.9.2 `63fed3e2…`, dtolnay/rust-toolchain stable snapshot `b725eda5…`); version named in a trailing comment; a repo doc (`docs/phases/phase-30.md`) records the upgrade procedure |
| S-2 | Checkouts persisted the ephemeral `github.token` in `.git/config` for the whole job | **FIXED** — `persist-credentials: false` everywhere (no job pushes; `gh release create` uses the `GH_TOKEN` env var) |
| S-3 | No automated dependency-vulnerability gate | **FIXED** — `npm audit --omit=dev` is now a hard gate in verify-all.sh + CI (runtime tree must stay at zero vulnerabilities); new weekly `security-audit.yml` runs the deep sweep (npm prod + cargo-audit + RustSec DB) every Monday and on demand |
| S-4 | Root `package.json` carried a stray `"apps/desktop": {"version": …}` manifest key (bump-script pollution from an earlier phase) | **FIXED** — key removed; verified zero diff in `package-lock.json` |
| S-5 | Full `npm audit` (dev included): 8 moderate findings, all inside the electron-builder build chain (`app-builder-lib` → `@electron/get` → `global-agent` → `roarr` → `sprintf-js`, GHSA-hp3w-g68c-fv3c) | **ACCEPTED with justification** — build-tool only: never shipped, never runs at app runtime, never touches untrusted input; the offered `npm audit fix --force` downgrades electron-builder to 26.5.0 (real packaging regression risk, zero runtime gain). The shipping tree is at 0 vulnerabilities and now gated (S-3). Re-evaluate on the next electron-builder release |
| S-6 | `cargo audit` over `core/Cargo.lock`: 4 RustSec advisories (RUSTSEC-2026-0346/47/48/49) in rustls 0.23.45, pulled by `reqwest`'s rustls feature | **FIXED** — `cargo update -p rustls` → 0.23.46 (semver-compatible, advisory-listed solution); re-audit exits clean; full cargo test suite green after the upgrade |
| S-7 | No SECURITY.md, no third-party notices | **FIXED** — `SECURITY.md` and `THIRD-PARTY-NOTICES.md` added at repo root |
| S-8 | No SBOM | **FIXED** — `scripts/sbom.mjs` (CycloneDX 1.5, deterministic, zero-dep, selftest-gated) generates the shipped-component inventory; every release from 0.17.0 on attaches `SyntaxDownloadManager-<version>-sbom.cdx.json` + `.sha256` sidecar + checksum-table row |

## 6. SBOM scope statement

The SBOM inventories exactly what ships: the `app.asar` npm runtime closure (42
components incl. electron-updater and the workspace contracts package), the
Vite-bundled renderer closure (93 components), Electron itself, all 217 crates linked
into `download-core(.exe)` (registry crates carry their Cargo.lock sha256), and the 3
bundled toolchain binaries (per-platform pinned sha256 + source URL). Build/test
tooling (typescript, vitest, esbuild, electron-builder, types packages) is excluded by
design — it never ships — and the selftest proves the exclusion (`--selftest` asserts
absence of five known dev-only packages). Licenses for npm components come from the
lockfile; bundled-tool licenses are mapped in the generator and in
`THIRD-PARTY-NOTICES.md`.

## 7. Verification artifacts for this review

- `node scripts/sbom.mjs --selftest` — green (356 components, determinism byte-identical).
- `npm audit --omit=dev` — 0 vulnerabilities (now a permanent gate).
- `cargo audit --file core/Cargo.lock` — exit 0 after the rustls 0.23.46 upgrade.
- Full `scripts/verify-all.sh` — green end to end (see phase-30.md for the recorded run).
