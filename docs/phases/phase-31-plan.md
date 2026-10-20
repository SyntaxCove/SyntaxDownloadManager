# Phase 31 Plan — 1.0.0: final QA, version, release

Scope source: `docs/PHASES.md` row 31 — "1.0.0 — final QA, version, release" (the last
row of the phase map). Contract **stays 1.16.0** (a version/QA/release phase must not
move the wire). App → **1.0.0**.

## Goal

Close out the 31-phase build: a codified final-QA gate that proves the release is
internally consistent, the 1.0.0 version bump everywhere the app version lives, the
final documentation state (all 31 phases delivered), and the **1.0.0 release** shipped
through the same artifact pipeline as every release since v0.13.0 — with byte-level
acceptance of the published assets.

## Work items

| # | Item | Detail |
|---|------|--------|
| Q-1 | Codified final-QA gate | `scripts/final-qa.mjs` (zero-dependency): version alignment across every manifest/lockfile the version lives in + phase-map completeness. Wired into `verify-all.sh` and `ci.yml` so the gate cannot rot. |
| Q-2 | Version alignment audit | root `package.json`, `apps/desktop/package.json`, `package-lock.json` (3 spots), `core/Cargo.toml` `[workspace.package]`, `core/Cargo.lock` (`download-core`), contracts `package.json` ↔ `src/version.ts` (1.16.0 wire version, unchanged). |
| Q-3 | Phase-map completeness | every `PHASES.md` row 0–31 delivered (zero `pending`), a report file for each delivered phase (rows 6–19 are the documented reconstruction gap — the report bodies were lost with the previous sandbox; the authoritative note in `PHASES.md` says so, and `worklog.md` carries their entries). |
| Q-4 | Version bump | 0.17.0 → **1.0.0** in root + desktop `package.json`, `package-lock.json` (root, workspace root, `apps/desktop` entries), `core/Cargo.toml` workspace version, `core/Cargo.lock` via `cargo metadata`. |
| Q-5 | Full QA gate on the 1.0.0 sources | `scripts/verify-all.sh` end-to-end on the exact bits that will be tagged: contracts build, cargo core build, typecheck, **126 contracts + 400 desktop** vitest (incl. the E2E suites over the real core binary), renderer build + budget gate, checksums + SBOM selftests, npm runtime-audit gate, final-QA gate, fmt/clippy/**300 cargo tests**. |
| Q-6 | Documentation final state | `PHASES.md` row 31 → delivered; README status → all 31 phases delivered / 1.0.0; roadmap section rewritten as shipped; `docs/phases/phase-31.md`; `worklog.md` Task ID: 31. |
| Q-7 | Release v1.0.0 | push → CI (verify + core-windows) green → tag `v1.0.0` (version guard: tag == root version) → release pipeline builds installer + portable zip + SBOM + checksums → published. |
| Q-8 | Byte-level acceptance | published portable zip + SBOM `sha256sum -c` OK with their sidecars; `latest.yml` auto-update feed carries appVersion 1.0.0; release notes carry the checksum table. |

## Acceptance criteria

- `scripts/final-qa.mjs` exits 0 locally and in CI; every version location agrees on
  **1.0.0** (contracts on **1.16.0**).
- `verify-all.sh` green end-to-end on the 1.0.0 sources (log kept in
  `tool-results/verify-all-p31.log`).
- CI run on the phase commit: both jobs green.
- Tag `v1.0.0` passes the release version guard; release run succeeds; assets:
  Setup exe + portable zip + blockmap + latest.yml + SBOM, each binary with a
  `.sha256` sidecar; checksum table in the notes.
- `PHASES.md` shows all 32 rows (0–31) delivered; README claims match reality.
- No TODOs, no placeholders, no test skips added by this phase.

## Non-goals

- No wire change: `packages/contracts` stays 1.16.0; `dc-protocol` untouched.
- No new product features — this phase only hardens the release story (Q-1) and ships.
- No code-signing (documented since phase 19; unchanged).
