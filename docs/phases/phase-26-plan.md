# Phase 26 Plan — Release engineering (CI, checksums, artifact pipeline)

Status: draft → delivered 2026-10-19 · Contract **stays v1.15.0** (no wire change) ·
App 0.12.0 → 0.13.0

## Scope (from docs/PHASES.md)

"Release engineering — CI, checksums, artifact pipeline". Until now every gate ran in the
development sandbox and every release was published by a local helper script. This phase
moves the guarantees out of the developer's machine and into the repository itself:

1. **CI** — GitHub Actions runs the full headless verification (the same gate as
   `scripts/verify-all.sh`) on every push and pull request, plus a Windows job that keeps
   the Rust core honest on the actual shipping platform.
2. **Checksums** — every shipped binary artifact gets a SHA-256 sidecar (sha256sum -c
   compatible) and the release notes carry a checksum table, so end users can verify what
   they downloaded.
3. **Artifact pipeline** — pushing a `v*` tag triggers a Windows build through the exact
   same packaging script a human runs (`scripts/build-windows.ps1` — no pipeline drift),
   computes checksums, and publishes the GitHub release with all assets attached.

Engineering priority: data integrity > security > reliability. Therefore: the pipeline
reuses `build-windows.ps1` instead of duplicating build steps; the tag/version pair is
verified before anything is built; checksums are generated from the bytes that are
actually uploaded; the release is created by the pipeline itself (not by hand).

## Design

### 1. `scripts/checksums.mjs` (new, zero dependencies)

- `node scripts/checksums.mjs <file>... [--markdown <path>]` — for each file computes
  SHA-256, writes a `<file>.sha256` sidecar in `sha256sum -c` format
  (`<digest>␣␣<basename>`), prints a Markdown table. `--markdown` also writes the table
  to a file (the release job appends it to the notes).
- `--selftest` — temp-dir drill: known digests, sidecar format, table ordering, failure
  on a missing file. Runs in CI and in `verify-all.sh` (the sandbox gate) so the
  checksum math itself is a tested artifact, not an act of faith.

### 2. `.github/workflows/ci.yml` (new — push to main + pull requests)

- **Job `verify` (ubuntu-latest, timeout 30 min)**: Node 24 + Rust stable (fmt, clippy,
  tests cached via Swatinem/rust-cache); `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (no test
  launches Electron; the E2E suites exercise the real debug `download-core` binary).
  Steps: `build:contracts` → `typecheck` → cargo build of the core → `test` (contracts +
  desktop unit + E2E over the real core) → `fmt --check` → `clippy -D warnings` →
  `cargo test` → `build:desktop` → `check-budgets.mjs` (Phase 22 gate) →
  `checksums.mjs --selftest`.
- **Job `core-windows` (windows-latest, timeout 20 min)**: `cargo test` on MSVC — the
  core is shipped as a Windows binary; CI must prove it compiles and passes on Windows,
  not only on the Linux sandbox.
- Concurrency group cancels superseded runs on the same ref.

### 3. `.github/workflows/release.yml` (new — on pushing a `v*` tag)

- **Job `release` (windows-latest, timeout 60 min, `contents: write`)**:
  1. Guard: tag name must equal `v` + root `package.json` version (fail fast on drift).
  2. Node 24 (full Electron download — electron-builder needs it) + Rust stable (cached).
  3. Run `powershell -File scripts/build-windows.ps1` — the one packaging script, the
     same steps a human runs (npm install → contracts+desktop build → release core →
     stage → `electron-builder --win nsis zip`).
  4. `checksums.mjs` over the installer `.exe`, the portable `.zip`, the
     `.blockmap` files and `latest.yml` (the Phase 18 auto-update feed must be published
     with the assets it indexes); `.exe`/`.zip` get sidecars.
  5. `gh release create <tag> --verify-tag --generate-notes` with notes = fixed intro
     (verify instructions, unsigned-build note) + checksum table; upload all assets.
- The release for a tag is created **by the pipeline**, with checksums computed from the
  uploaded bytes — hand-made releases are no longer the primary path.

### 4. Supporting changes

- `scripts/verify-all.sh` — add the checksums selftest after the budget gate.
- `README.md` — CI badge, "Releases & checksums" section (how to verify a download on
  Windows `Get-FileHash` and Linux/macOS `sha256sum -c`), release pipeline description.
- Version 0.12.0 → **0.13.0**: root + desktop `package.json` (+ root pin + lockfile),
  `core/Cargo.toml` workspace version (Cargo.lock follows on build).
- `tool-results/make-release.py` (gitignored sandbox helper) — recreated with optional
  asset upload as the manual fallback; the CI pipeline is now the primary path.

## Verification plan

- Local: `verify-all.sh` green (contracts + desktop incl. E2E + cargo + budgets +
  checksums selftest), workflow YAML parse-checked.
- **Real CI**: push and watch the `ci.yml` run to green via the API — the gate must pass
  outside the sandbox, on GitHub's runners.
- **Real pipeline**: push tag `v0.13.0`, watch `release.yml` build on a real Windows
  runner, confirm the published release carries installer + portable zip + blockmaps +
  `latest.yml` + `.sha256` sidecars and that the notes contain the checksum table.
- Contract untouched at v1.15.0; no IPC/wire change.

## Out of scope (honest notes)

- Code signing (no certificate available): releases stay unsigned with the documented
  SmartScreen note and the Phase 19 signing upgrade path.
- SBOM / supply-chain attestation belongs to Phase 30; CI here is verification +
  artifact publishing, not attestation.
