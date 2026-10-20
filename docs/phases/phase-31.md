# Phase 31 Report — 1.0.0: final QA, version, release

Status: DELIVERED (2026-10-20). Plan: `docs/phases/phase-31-plan.md`. Contract **stays
1.16.0** (a version/QA/release phase must not move the wire). App → **1.0.0** (root +
desktop + lockfile entries + Rust workspace + Cargo.lock, all aligned). This closes the
phase map: rows 0–31 of `docs/PHASES.md` are delivered.

## What the phase added

### Q-1 — the codified final-QA gate (`scripts/final-qa.mjs`)

Until now the version story lived in six different files and nothing proved they agreed.
The gate is a zero-dependency, read-only consistency checker with three lenses:

1. **Version alignment** — the app version must agree across root `package.json`,
   `apps/desktop/package.json`, the three `package-lock.json` spots (top-level,
   workspace root, `apps/desktop`), `core/Cargo.toml` `[workspace.package]`, and the
   `download-core` entry in `core/Cargo.lock`.
2. **Contracts wire version** — `packages/contracts/package.json` must equal the
   `CONTRACT_VERSION` constant in `packages/contracts/src/version.ts` (the Rust
   `dc-protocol` mirror is compile-enforced), and it must *not* equal the app version —
   the wire and the app are independent semver streams.
3. **Phase-map completeness** — every row of `docs/PHASES.md` delivered (zero
   `pending`), a report file for each delivered phase, with the documented exception of
   rows 6–19 (the reconstruction note in the map explains that those report bodies were
   lost with the previous sandbox; `worklog.md` carries their entries). The map must
   also still carry its reconstruction note.

It ships with a `--selftest` (consistent fixture stays clean; a deliberately drifted
fixture is flagged at exactly the right spots; phase-map checks live) and is wired into
`scripts/verify-all.sh` **and** `.github/workflows/ci.yml` next to the checksum and SBOM
selftests — the sandbox gate and the CI gate remain one and the same, so the alignment
this phase proves cannot rot.

### Q-4 — the 1.0.0 version bump

0.17.0 → **1.0.0** in root `package.json`, `apps/desktop/package.json`,
`package-lock.json` (all three spots), `core/Cargo.toml`, and `core/Cargo.lock`
(refreshed via `cargo metadata`, no full rebuild needed for the lockfile update).
Contracts stay at 1.16.0. The release version guard (tag == root version) accepts
`v1.0.0` only against these sources.

### Q-6 — the documentation final state

`PHASES.md` row 31 → delivered; README status line now reads "**1.0.0** — all 31
development phases are delivered", the verification-gate and CI sections document the
new gate, and the roadmap section is rewritten as a completed map (no "Next:" — there
is no next phase).

## Final QA checklist (all evidenced)

| Check | Evidence |
|-------|----------|
| Version alignment | `node scripts/final-qa.mjs` → ok (app 1.0.0 across 7 locations; contracts 1.16.0 consistent; map complete) |
| Full headless gate | `scripts/verify-all.sh` end-to-end on the 1.0.0 sources — see Verification |
| Phase-map completeness | 32/32 rows delivered, reports present (6–19 documented gap) |
| Release readiness | release.yml version guard matches `v1.0.0` ↔ package.json 1.0.0; SBOM + checksum steps in place |
| No regressions en route | no production code touched by this phase — only manifests, the new gate script, and docs |

## Verification

- `scripts/verify-all.sh` end-to-end on the exact 1.0.0 sources: **all checks passed**
  — typecheck clean; vitest **126 contracts + 400 desktop** green (including the E2E
  suites supervising the real debug core binary); renderer build ok with the Phase 22
  budget gate respected; checksums selftest ok; SBOM selftest ok; final-QA selftest +
  gate ok; **npm audit --omit=dev: 0 vulnerabilities**; fmt/clippy clean and **300
  cargo tests** green. (Full log: `tool-results/verify-all-p31.log`.)
- Post-push: CI run and the v1.0.0 release pipeline run are recorded at the bottom of
  this report (updated after the real runs completed).
