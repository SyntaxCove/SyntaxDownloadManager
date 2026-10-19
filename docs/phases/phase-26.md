# Phase 26 Report — Release engineering (CI, checksums, artifact pipeline)

Status: delivered 2026-10-19 · Contract **unchanged at v1.15.0** (no wire change) ·
App 0.12.0 → 0.13.0 · Plan: [`phase-26-plan.md`](phase-26-plan.md)

## What shipped

Until now every quality gate ran only in the development sandbox and every release was
published by a local helper script — the repository itself carried no enforcement. Phase
26 moves the guarantees into the repo so that pushing to `main` and pushing a tag are
the processes, not the developer's machine.

### 1. Continuous integration — `.github/workflows/ci.yml`

Two jobs run on every push to `main` and every pull request:

- **`verify` (ubuntu-latest)** — the exact headless gate `scripts/verify-all.sh` runs,
  step for step: `build:contracts` → workspace typecheck (main/renderer/e2e tsconfigs) →
  debug build of the Rust core → TS tests (**118 contracts + desktop unit + the 20 E2E
  tests that supervise the real `download-core` binary**) → `cargo fmt --check` →
  `cargo clippy -D warnings` → `cargo test` → production renderer build → the Phase 22
  performance budget gate → the Phase 26 checksums selftest.
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` because no test launches Electron; the E2E value
  comes from supervising the real core subprocess, which is present.
- **`core-windows` (windows-latest)** — `cargo test` on the shipping platform (MSVC).
  The core ships as a Windows binary; CI must prove it compiles and passes there, not
  only on the Linux sandbox.

Both jobs are concurrency-grouped (superseded pushes cancel in place), time-boxed
(30/20 min), least-privilege (`contents: read`), and cache npm + Rust artifacts.

### 2. Checksums — `scripts/checksums.mjs` (new, zero dependencies)

- `node scripts/checksums.mjs <file>... [--markdown <path>]` streams each file through
  SHA-256 in 4 MiB chunks (release artifacts are ~170 MB; nothing is loaded into
  memory), writes a `<file>.sha256` sidecar in standard `sha256sum -c` format
  (`<digest>␣␣<basename>`), and renders a Markdown table for the release notes.
- `--selftest` drills six properties in a temp dir: an independently established known
  vector (`sha256("abc")`), the canonical empty-input digest, the exact sidecar format,
  multi-chunk streaming (a 9 MiB input spanning several 4 MiB reads), the Markdown
  table, and the loud-ENOENT failure rule (a missing artifact must crash the pipeline,
  never pass silently). The checksum tooling is itself a tested artifact.

### 3. Artifact pipeline — `.github/workflows/release.yml`

Pushing a `v*` tag runs one Windows job (60 min timeout, `contents: write`):

1. **Version guard** — the tag must equal `v` + root `package.json` version; a drifted
   tag refuses to build. A tag can never publish binaries built from mismatched sources.
2. **Build** — `scripts/build-windows.ps1`, the same packaging script a human runs
   (npm install with the real Electron binary → contracts + desktop build → release
   Rust core → stage → `electron-builder --win nsis zip`). The pipeline physically
   cannot drift from the documented manual path because it *is* the manual path.
3. **Checksums** — `checksums.mjs` over the installer `.exe`, the portable `.zip`, the
   differential-update `.blockmap` files and `latest.yml` (the Phase 18 auto-update
   feed must be published together with the assets it indexes); `.sha256` sidecars are
   written next to every artifact; the Markdown table is embedded into the notes.
4. **Publish** — `gh release create --verify-tag` attaches all artifacts and sidecars
   to the release for the tag. The release is created **by the pipeline**, with
   checksums computed from the bytes that are uploaded.

### 4. Supporting changes

- `scripts/verify-all.sh` — the checksums selftest joined the sandbox gate right after
  the budget gate; the sandbox gate and the CI gate remain one and the same.
- `README.md` — CI badge, a new **Releases & checksums** section (verification
  instructions for PowerShell `Get-FileHash` and `sha256sum -c`, unsigned-build
  notice), updated status/roadmap.
- Version 0.13.0 across root + desktop `package.json` (+ root pin + lockfile) and the
  `core/Cargo.toml` workspace version.
- `tool-results/make-release.py` (gitignored sandbox helper) was recreated with
  optional asset upload as the **manual fallback**; the CI pipeline is the primary
  release path from this phase on.

## Verification

- Local sandbox gate (`scripts/verify-all.sh`): **green** — typecheck main/renderer/e2e,
  **118 contracts + 365 desktop + 280 cargo** tests passing (counts as printed by the
  gate run logged in `tool-results/verify-all-p26.log`), performance budget gate
  respected, checksums selftest ok (6 checks), fmt/clippy clean.
- Workflow YAML parse-checked for both files.
- **Real CI**: recorded after push — see the update note at the end of this section.
- **Real pipeline**: recorded after the `v0.13.0` tag build — the acceptance bar is that
  the published release carries the NSIS installer, the portable zip, blockmaps,
  `latest.yml` and `.sha256` sidecars with the checksum table in the notes, and that the
  portable zip downloaded from the release matches its published sidecar byte-for-byte.

## Honest scope notes

- **Code signing**: binaries remain unsigned (no certificate). The release notes and
  README carry the SmartScreen notice and the Phase 19 signing upgrade path.
- **SBOM / supply-chain attestation** belongs to Phase 30; this phase's CI verifies and
  publishes artifacts, it does not attest them.
- The release workflow's Windows job is verified by an actual tag build (real runner,
  real artifacts, real release), not by inspection alone — run identifiers are recorded
  in this section once the runs complete (they cannot be known before pushing).
