# Phase 30 Plan — Security & privacy final review (supply chain, SBOM)

Authoritative scope (PHASES.md row 30): "Security & privacy final review — supply chain,
SBOM". This is the final security deliverable before 1.0.0: re-verify the Phase 23 trust
boundaries still hold after phases 24–29, review the software supply chain end to end,
produce a machine-readable SBOM shipped with every release, and document the complete
privacy data-flow inventory. Contract stays at **1.16.0** (a review must not move the
wire). App → **0.17.0**.

## Deliverables

| # | Deliverable | What it is |
|---|-------------|------------|
| D-1 | Supply-chain review + hardening | Actions pinned to commit SHAs, least-privilege checkout, npm runtime audit gate, weekly scheduled audit workflow, manifest hygiene fix, documented audit results |
| D-2 | `scripts/sbom.mjs` | Zero-dependency deterministic CycloneDX 1.5 generator covering npm runtime closure, renderer-bundled packages, Electron, Rust crates, bundled toolchains (with pinned sha256s); `--selftest` wired into verify-all + CI |
| D-3 | SBOM release asset | release.yml generates `SyntaxDownloadManager-<version>-sbom.cdx.json` (+ `.sha256` sidecar, checksum table row) on the Windows runner and attaches it to every release |
| D-4 | `SECURITY.md` | Vulnerability reporting policy, supported versions, shipped security features, verification instructions |
| D-5 | `THIRD-PARTY-NOTICES.md` | Bundled third-party components with licenses + source URLs (FFmpeg GPL build, yt-dlp, Deno, Electron) |
| D-6 | `docs/security-privacy-review.md` | The review itself: 12 Phase-23 boundaries re-verified with current code evidence; complete network-egress and local-storage inventory; secrets-handling audit |
| D-7 | Docs + release | phase-30.md, README updates, worklog, PHASES.md row; bump → v0.17.0 tag → release pipeline |

## Findings register (to be completed by the phase)

| ID | Finding | Disposition |
|----|---------|-------------|
| S-1 | GitHub Actions referenced by mutable tags/branches (`@v4`, `@stable`, `@v2`) | **Fix**: pin every `uses:` to a full commit SHA (checkout v4.4.0, setup-node v4.4.0, rust-cache v2.9.2, dtolnay stable branch snapshot), version named in a comment |
| S-2 | Checkouts persist the ephemeral `github.token` in `.git/config` for the whole job | **Fix**: `persist-credentials: false` on every checkout (no job in this repo pushes; `gh` uses `GH_TOKEN` env, not stored creds) |
| S-3 | No automated dependency-vulnerability gate | **Fix**: `npm audit --omit=dev` hard gate in verify-all + CI (runtime deps must stay at zero); weekly `security-audit.yml` runs the full audit (npm prod + cargo-audit) on a schedule |
| S-4 | Root `package.json` carries a stray `"apps/desktop": {"version": …}` key (bump-script pollution, discovered this phase) | **Fix**: remove the key; lockfile unaffected (verified) |
| S-5 | `npm audit` (full tree incl. dev): 8 moderate findings, all inside the electron-builder build-time chain (`app-builder-lib` → `@electron/get` → `global-agent` → `roarr` → `sprintf-js`, GHSA-hp3w-g68c-fv3c) | **Accept + document**: build-tool-only (never shipped, never runs on untrusted input at runtime; packaging happens on CI/developer machines); the offered "fix" downgrades electron-builder to 26.5.0 — a real regression risk for zero runtime gain. Runtime tree is at **0 vulnerabilities** and is gated from now on |
| S-6 | No SBOM | **Fix**: D-2/D-3 |
| S-7 | No SECURITY.md / third-party notices | **Fix**: D-4/D-5 |

## Re-verification of the Phase 23 boundaries

All twelve boundaries from `docs/phases/phase-23-plan.md` re-checked against current
sources (evidence recorded in `docs/security-privacy-review.md`): IPC router validation,
sender firewall, shell/tab webPreferences, both permission policies, CSP (meta + header),
navigation/window-opening, webview ban, renderer XSS sinks, URL admission, secrets and
update feed. None regressed between 0.10.0 and 0.16.0; the phase also adds the privacy
review (log redaction, diagnostics zip contents, safeStorage ciphertext-at-rest, no
telemetry anywhere).

## Test & acceptance plan

- `node scripts/sbom.mjs --selftest` — structure invariants, uniqueness, toolchain
  sha256 presence, dev-only exclusion proof, determinism (two builds byte-identical);
  wired into verify-all.sh + CI alongside the checksums selftest.
- `npm audit --omit=dev` exits 0 (0 vulnerabilities) as a hard gate.
- `cargo audit` over `core/Cargo.lock` — results recorded in the phase report.
- Full `scripts/verify-all.sh` green (typecheck, vitest, fmt/clippy/cargo test, renderer
  build, budget gate, checksums selftest, sbom selftest, npm prod audit).
- Release: v0.17.0 via the pipeline; SBOM asset attached with `.sha256` sidecar and a
  checksum-table row.
