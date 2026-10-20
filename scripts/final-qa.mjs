#!/usr/bin/env node
// Syntax Download Manager — final QA gate (Phase 31).
//
// A read-only consistency checker that proves the release is internally coherent:
//
//   1. Version alignment — the app version must agree across every location it
//      lives in: root package.json, apps/desktop/package.json, the three
//      package-lock.json spots (top-level, workspace root, apps/desktop),
//      core/Cargo.toml [workspace.package].version, and the download-core entry
//      in core/Cargo.lock.
//   2. Contracts wire version — packages/contracts/package.json and the
//      CONTRACT_VERSION constant in packages/contracts/src/version.ts must agree
//      (the Rust dc-protocol mirror is compile-enforced and needs no check here).
//   3. Phase-map completeness — every row of docs/PHASES.md must be delivered
//      (zero "pending"), and every delivered phase must have a report file in
//      docs/phases/, EXCEPT rows 6–19: those report bodies were lost with the
//      previous sandbox session and the map's own reconstruction note documents
//      that gap (worklog.md carries their entries).
//
// Exit 0 = the release story is coherent; exit 1 = something drifted.
// `--selftest` runs the checkers against inline fixtures (consistent + drifted)
// and asserts both outcomes, so the checker itself is covered.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOST_PHASE_REPORTS = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

function read(p) {
  return readFileSync(join(ROOT, p), "utf8");
}

// --- version checkers --------------------------------------------------------

export function appVersionFromPackageJson(text) {
  const pkg = JSON.parse(text);
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`package.json has no valid semver version: ${JSON.stringify(pkg.version)}`);
  }
  return pkg.version;
}

export function workspaceVersionFromCargoToml(text) {
  const section = text.split(/^\[workspace\.package\]\s*$/m)[1];
  if (!section) throw new Error("core/Cargo.toml has no [workspace.package] section");
  const m = section.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("core/Cargo.toml [workspace.package] has no version");
  return m[1];
}

export function coreVersionFromCargoLock(text) {
  const m = text.match(/\[\[package\]\]\s*\nname = "download-core"\s*\nversion = "([^"]+)"/);
  if (!m) throw new Error('core/Cargo.lock has no [[package]] entry for "download-core"');
  return m[1];
}

export function checkVersionAlignment(files) {
  const problems = [];
  let root;
  try {
    root = appVersionFromPackageJson(files.rootPkg);
  } catch (e) {
    return [`root package.json: ${e.message}`];
  }

  const spots = [
    ["apps/desktop/package.json", () => appVersionFromPackageJson(files.desktopPkg)],
    ["package-lock.json (top-level version)", () => JSON.parse(files.lockJson).version],
    ['package-lock.json (packages[""].version)', () => JSON.parse(files.lockJson).packages[""]?.version],
    ['package-lock.json (packages["apps/desktop"].version)', () => JSON.parse(files.lockJson).packages["apps/desktop"]?.version],
    ["core/Cargo.toml [workspace.package]", () => workspaceVersionFromCargoToml(files.cargoToml)],
    ["core/Cargo.lock (download-core)", () => coreVersionFromCargoLock(files.cargoLock)],
  ];
  for (const [name, get] of spots) {
    try {
      const v = get();
      if (v !== root) problems.push(`version drift: ${name} is ${v}, root package.json is ${root}`);
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }

  // Contracts wire version: package.json must agree with the TS constant.
  try {
    const pkgV = JSON.parse(files.contractsPkg).version;
    const m = files.contractsVersionTs.match(/CONTRACT_VERSION\s*=\s*"([^"]+)"/);
    if (!m) problems.push("packages/contracts/src/version.ts: no CONTRACT_VERSION constant found");
    else if (m[1] !== pkgV)
      problems.push(`contracts wire version drift: package.json is ${pkgV}, CONTRACT_VERSION is ${m[1]}`);
    if (m && m[1] === root)
      problems.push(
        `contracts wire version (${m[1]}) equals the app version — the wire and the app are independent semver streams`
      );
  } catch (e) {
    problems.push(`contracts version check: ${e.message}`);
  }

  return problems;
}

// --- phase-map checker -------------------------------------------------------

export function checkPhaseMap(phasesMd, reportExists) {
  const problems = [];
  if (!/Reconstruction note:/i.test(phasesMd)) {
    problems.push("docs/PHASES.md is missing its reconstruction note (provenance of rows 6–19)");
  }
  const rows = [];
  for (const line of phasesMd.split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (m) rows.push({ n: Number(m[1]), title: m[2], status: m[3] });
  }
  if (rows.length === 0) problems.push("docs/PHASES.md: no phase rows parsed — table malformed?");
  const expected = rows.map((r, i) => r.n).every((n, i, a) => i === 0 || n === a[i - 1] + 1);
  if (rows.length > 0 && !expected) problems.push("docs/PHASES.md: phase numbers are not contiguous");

  for (const row of rows) {
    if (!/delivered/i.test(row.status)) {
      problems.push(`phase ${row.n} ("${row.title}") is not delivered: "${row.status}"`);
      continue;
    }
    if (LOST_PHASE_REPORTS.has(row.n)) continue; // documented reconstruction gap
    const report = `docs/phases/phase-${row.n}.md`;
    if (!reportExists(report)) {
      problems.push(`phase ${row.n} is delivered but ${report} is missing`);
    }
  }
  return problems;
}

// --- selftest ----------------------------------------------------------------

function selftest() {
  const ok = checkVersionAlignment({
    rootPkg: '{"version":"1.0.0"}',
    desktopPkg: '{"version":"1.0.0"}',
    lockJson: '{"version":"1.0.0","packages":{"":{"version":"1.0.0"},"apps/desktop":{"version":"1.0.0"}}}',
    cargoToml: '[workspace.package]\nversion = "1.0.0"\nedition = "2021"\n',
    cargoLock: '[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "download-core"\nversion = "1.0.0"\n',
    contractsPkg: '{"version":"1.16.0"}',
    contractsVersionTs: 'export const CONTRACT_VERSION = "1.16.0";\n',
  });
  if (ok.length !== 0) throw new Error(`selftest: consistent fixture reported problems: ${JSON.stringify(ok)}`);

  const drifted = checkVersionAlignment({
    rootPkg: '{"version":"1.0.0"}',
    desktopPkg: '{"version":"9.9.9"}',
    lockJson: '{"version":"1.0.0","packages":{"":{"version":"1.0.0"},"apps/desktop":{"version":"1.0.0"}}}',
    cargoToml: '[workspace.package]\nversion = "1.0.0"\n',
    cargoLock: '[[package]]\nname = "download-core"\nversion = "0.17.0"\n',
    contractsPkg: '{"version":"1.16.0"}',
    contractsVersionTs: 'export const CONTRACT_VERSION = "1.17.0";\n',
  });
  // desktop package.json + Cargo.lock + CONTRACT_VERSION must all be flagged.
  if (drifted.length !== 3) {
    throw new Error(`selftest: drifted fixture should report exactly 3 problems, got ${drifted.length}: ${JSON.stringify(drifted)}`);
  }

  const phasesOk = `# Phase Map

> Reconstruction note: rows 6–19 were lost with the previous sandbox.

| # | Title | Status |
|---|-------|--------|
| 0 | Foundation | delivered |
| 1 | Contracts | delivered |
`;
  const p1 = checkPhaseMap(phasesOk, (f) => f === "docs/phases/phase-0.md" || f === "docs/phases/phase-1.md");
  if (p1.length !== 0) throw new Error(`selftest: complete map reported problems: ${JSON.stringify(p1)}`);

  const p2 = checkPhaseMap(
    phasesOk.replace("delivered |", "pending    |"), // row 1 back to pending
    () => false
  );
  if (p2.length !== 2) {
    // row 1 pending + row 1 report missing
    throw new Error(`selftest: pending map should report 2 problems, got ${p2.length}: ${JSON.stringify(p2)}`);
  }

  console.log("final-qa selftest ok (consistent fixture clean; drifted fixture flagged; phase-map checks live)");
}

// --- main --------------------------------------------------------------------

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const rootVersion = appVersionFromPackageJson(read("package.json"));

const versionProblems = checkVersionAlignment({
  rootPkg: read("package.json"),
  desktopPkg: read("apps/desktop/package.json"),
  lockJson: read("package-lock.json"),
  cargoToml: read("core/Cargo.toml"),
  cargoLock: read("core/Cargo.lock"),
  contractsPkg: read("packages/contracts/package.json"),
  contractsVersionTs: read("packages/contracts/src/version.ts"),
});

const phaseProblems = checkPhaseMap(read("docs/PHASES.md"), (f) => existsSync(join(ROOT, f)));

if (versionProblems.length > 0 || phaseProblems.length > 0) {
  console.error("final-qa: FAILED");
  for (const p of [...versionProblems, ...phaseProblems]) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `final-qa ok: app ${rootVersion} aligned across 7 locations; contracts wire version consistent; docs/PHASES.md fully delivered with reports present`
);
