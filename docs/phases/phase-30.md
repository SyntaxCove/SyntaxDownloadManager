# Phase 30 Report — Security & privacy final review (supply chain, SBOM)

Status: DELIVERED (2026-10-20). Plan: `docs/phases/phase-30-plan.md`. Durable review:
`docs/security-privacy-review.md`. Contract **stays 1.16.0** (a review must not move
the wire). App → **0.17.0** (root + desktop + lockfile entries + Rust workspace, all
aligned).

## What the review covered

Three lenses, all recorded in detail in `docs/security-privacy-review.md`:

1. **Re-verification of the twelve Phase 23 trust boundaries** against current sources:
   IPC router validation, sender firewall, shell/tab `webPreferences`, both permission
   policies, CSP (meta + header), navigation/window-opening, the global webview ban,
   renderer XSS sinks (0 hits), URL admission (address bar + all five core admission
   sites), secrets handling, and the fail-closed https update feed. **None regressed**
   between 0.10.0 and 0.16.0 — phases 24–29 shipped without touching the hardening.
2. **Privacy data-flow inventory**: the complete egress list (auto-update feed to this
   repo's releases, sha256-pinned toolchain fetches, user-driven browsing/downloads,
   BitTorrent swarm) — and nothing else; plus the local-storage inventory with the
   secrets audit (proxy passwords exist only as `enc:v1:` safeStorage ciphertext,
   decrypt only inside the `login` handler, renderer always sees `password: null`;
   the logger redacts URL credentials and secret-shaped query values; the diagnostics
   zip was re-proven secret-free against the settings contract).
3. **Supply chain**: lockfile-authoritative installs, exact pinning (25/25 external
   deps), sha256-pinned bundled binaries, single-publisher release path — then the
   audit sweep that produced the findings below.

## Findings (S-1…S-8) — all resolved except one accepted with justification

- **S-1 (FIXED)** — GitHub Actions were referenced by mutable tags (`@v4`, `@v2`,
  `@stable`); every `uses:` is now pinned to a full commit SHA with the version in a
  trailing comment (checkout v4.4.0, setup-node v4.4.0, rust-cache v2.9.2, dtolnay
  stable snapshot).
- **S-2 (FIXED)** — checkouts no longer persist the ephemeral `github.token`
  (`persist-credentials: false` everywhere; `gh` uses `GH_TOKEN` env).
- **S-3 (FIXED)** — `npm audit --omit=dev` is now a hard gate in verify-all.sh + CI
  (the shipped tree must stay at zero vulnerabilities), and a new weekly
  `security-audit.yml` runs the deep sweep (npm prod audit + `cargo-audit` against the
  RustSec advisory DB) every Monday and on demand.
- **S-4 (FIXED)** — removed the stray `"apps/desktop"` key from root `package.json`
  (bump-script pollution found by this review; lockfile verified unchanged).
- **S-5 (ACCEPTED, documented)** — full npm audit (dev included): 8 moderate findings,
  all inside the electron-builder *build-time* chain (`app-builder-lib` →
  `@electron/get` → `global-agent` → `roarr` → `sprintf-js`). Never shipped, never runs
  at app runtime; the offered "fix" downgrades electron-builder to 26.5.0 — real
  packaging risk, zero runtime gain. The runtime tree is at 0 and gated.
- **S-6 (FIXED)** — `cargo audit` found 4 RustSec advisories in rustls 0.23.45
  (RUSTSEC-2026-0346/47/48/49, via `reqwest`'s rustls feature); `cargo update -p
  rustls` → 0.23.46; re-audit exits clean; the full 300-test cargo suite passed after
  the upgrade.
- **S-7 (FIXED)** — `SECURITY.md` (reporting policy + security architecture) and
  `THIRD-PARTY-NOTICES.md` (bundled FFmpeg GPL build / yt-dlp / Deno / Electron / npm /
  crates with license mapping) added.
- **S-8 (FIXED)** — SBOM: see below.

## SBOM (CycloneDX 1.5)

`scripts/sbom.mjs` — zero-dependency, deterministic (no serial/timestamp; two builds
byte-identical), faithful node_modules resolution (workspace links, nested copies,
node-style upward walk) — inventories exactly what ships:

- the `app.asar` npm runtime closure (**42** components, incl. electron-updater and
  the first-party contracts package → zod),
- the Vite-bundled renderer closure (**93** components: react, react-dom, zustand,
  Fluent UI + transitives),
- **Electron** itself as the runtime binary,
- all **217** crates linked into `download-core(.exe)` — registry crates carry their
  Cargo.lock sha256 as component hashes, the four first-party `dc-*`/core crates are
  flagged,
- the **3** bundled toolchain binaries with per-platform pinned sha256 + source URL +
  license.

Every component carries a `syntaxdm:delivery` property (`app-asar` |
`renderer-bundle` | `electron-runtime` | `rust-core-binary` | `bundled-tool`); dev-only
tooling is excluded by design and the selftest *proves* the exclusion (asserts
typescript/vitest/esbuild/electron-builder/@types are absent). `--selftest` is wired
into verify-all.sh + CI next to the checksums selftest. `release.yml` now generates
`SyntaxDownloadManager-<version>-sbom.cdx.json` on the Windows runner from the exact
sources being released and attaches it with a `.sha256` sidecar and a checksum-table
row.

## Verification

- `scripts/verify-all.sh` end-to-end: **all checks passed** — typecheck clean; vitest
  **126 contracts + 400 desktop** green; renderer build ok with the Phase 22 budget
  gate respected; checksums selftest ok; **SBOM selftest ok (356 components)**;
  **npm audit --omit=dev: 0 vulnerabilities**; cargo fmt/clippy clean and **300
  tests** green after the rustls upgrade.
- Desktop suite re-run green after the 0.17.0 bump (no test pins the app version —
  budget-report fixtures are self-contained).
- Operational note: a linker `Bus error` mid-phase was diagnosed as sandbox disk
  exhaustion (99% full); stale build artifacts were purged and everything re-verified —
  a tooling hiccup, not a code defect.

## Honest scope note

The SBOM describes the *shipped* surface; on the Windows runner the packaged asar and
bundle are produced by the same lockfile versions the SBOM resolves, and the version
guard pins tag ↔ sources. CI enforces the SBOM's structural invariants on every push;
the Windows artifact generation step runs the same generator over the same lockfiles,
so a release SBOM can only diverge from CI's if the lockfiles differ — which the
version guard and single-commit tag discipline make impossible.
