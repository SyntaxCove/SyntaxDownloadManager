#!/usr/bin/env node
/**
 * Phase 30 — SBOM generator (Software Bill of Materials, CycloneDX 1.5 JSON).
 *
 * Zero dependencies, deterministic (no timestamps, no serial, sorted output), and
 * honest about what actually SHIPS in the released product. Sources read from the
 * repo checkout:
 *
 *   - package-lock.json            npm closure of the desktop runtime deps that are
 *                                  packed into app.asar (electron-updater, archive
 *                                  readers, @syntaxdm/contracts → zod, …);
 *   - apps/desktop/package.json    the runtime dependency list + Electron version;
 *   - core/Cargo.lock              every crate linked into download-core(.exe)
 *                                  (registry crates carry their sha256 checksum);
 *   - apps/desktop/resources/toolchains.json  the bundled third-party binaries
 *                                  (yt-dlp, Deno, FFmpeg) with their pinned sha256s.
 *
 * Components carry a `syntaxdm:delivery` property stating where the code physically
 * ships: `app-asar` | `renderer-bundle` | `electron-runtime` | `rust-core-binary` |
 * `bundled-tool`. Dev-only packages (vitest, electron-builder, typescript, …) are
 * deliberately excluded — they never ship — and the selftest proves that exclusion.
 *
 * CLI:
 *   node scripts/sbom.mjs --out <path>   write the SBOM JSON to <path>
 *   node scripts/sbom.mjs --selftest    run the built-in invariant checks
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_VERSION = "1.5";

/** Renderer packages are devDependencies (bundled by Vite) but ship inside app.bundle.js. */
const RENDERER_BUNDLED = [
  "react",
  "react-dom",
  "zustand",
  "@fluentui/react-components",
  "@fluentui/react-icons",
];

/** Bundled toolchains are not npm/cargo packages; their licenses live here (and in THIRD-PARTY-NOTICES.md). */
const TOOLCHAIN_LICENSES = {
  "yt-dlp": "Unlicense",
  deno: "MIT",
  ffmpeg: "GPL-3.0-or-later",
};

// ---------------------------------------------------------------------------
// npm dependency resolution over package-lock v3 (faithful node_modules walk)
// ---------------------------------------------------------------------------

function buildNpmIndex(lock) {
  const exact = new Map();
  const byName = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue; // root workspace manifest, not a component
    exact.set(path, entry);
    const m = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)$/);
    if (!m) continue;
    const name = m[1];
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(path);
  }
  return { exact, byName };
}

/**
 * Resolve `name` for a dependent package whose lockfile path is `parentPath`,
 * walking node_modules levels outward exactly like Node's own resolution.
 * Returns { path, entry } or null.
 */
function resolveDep(parentPath, name, index) {
  let dir = parentPath;
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    const hit = index.exact.get(candidate);
    if (hit) return { path: candidate, entry: hit };
    if (!dir) return null;
    // step up one node_modules boundary
    const idx = dir.lastIndexOf("/node_modules/");
    if (idx === -1) {
      if (dir.startsWith("node_modules/")) {
        dir = "";
        continue;
      }
      // workspace paths (e.g. "packages/contracts") sit outside every node_modules;
      // their dependencies resolve from the install root.
      return resolveDep("", name, index);
    }
    dir = dir.slice(0, idx);
  }
}

/** Follow lockfile link entries (workspace symlinks) to their real manifest. */
function dereference(resolved, index) {
  let { path, entry } = resolved;
  for (let hops = 0; entry?.link && entry.resolved && hops < 8; hops++) {
    const target = index.exact.get(entry.resolved);
    if (!target) return null;
    path = entry.resolved;
    entry = target;
  }
  return { path, entry };
}

function dependencyNames(entry) {
  return Object.keys(entry?.dependencies ?? {});
}

/**
 * Breadth-first closure over the lockfile starting from `roots`, resolving each
 * dependency with Node's walk. Returns a Map purl → component (deduped).
 */
function npmClosure(lock, roots, delivery, firstPartyNames) {
  const index = buildNpmIndex(lock);
  const components = new Map();
  const queue = [];

  for (const name of roots) {
    const hit = resolveDep("", name, index);
    if (!hit) {
      throw new Error(`sbom: root dependency ${name} not resolvable in package-lock.json`);
    }
    queue.push(hit);
  }

  const seenPaths = new Set();
  while (queue.length > 0) {
    const resolved = queue.shift();
    const deref = dereference(resolved, index);
    if (!deref) continue;
    const { path, entry } = deref;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const name = entry.name ?? resolved.path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)$/)[1];
    const version = entry.version;
    if (!version) {
      throw new Error(`sbom: lockfile entry ${path} has no version`);
    }
    const firstParty = firstPartyNames.has(name);
    const purl = npmPurl(name, version);
    if (!components.has(purl)) {
      components.set(purl, {
        type: "library",
        "bom-ref": purl,
        name,
        version,
        purl,
        scope: "required",
        ...(licensesOf(entry) ? { licenses: licensesOf(entry) } : {}),
        properties: [
          { name: "syntaxdm:delivery", value: delivery },
          { name: "syntaxdm:first-party", value: firstParty ? "true" : "false" },
        ],
      });
    }
    for (const dep of dependencyNames(entry)) {
      const child = resolveDep(path, dep, index);
      if (child) queue.push(child);
    }
  }
  return components;
}

/** purl of an npm package: scope @a/b encodes the leading @ as %40 (purl spec). */
function npmPurl(name, version) {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/** package-lock v3 carries an SPDX license string or expression per package. */
function licensesOf(entry) {
  const lic = entry?.license;
  if (typeof lic !== "string" || lic.length === 0) return null;
  if (/[( OR | AND |WITH )]/.test(lic)) return [{ expression: lic }];
  return [{ license: { id: lic } }];
}

// ---------------------------------------------------------------------------
// Cargo.lock parsing (version 4 format; zero-dep section scanner)
// ---------------------------------------------------------------------------

export function parseCargoLock(text) {
  const crates = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      if (current) crates.push(current);
      current = {};
      continue;
    }
    if (line.startsWith("[") && current) {
      if (current) crates.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === "name" || key === "version" || key === "source" || key === "checksum") {
      current[key] = value;
    }
  }
  if (current) crates.push(current);
  return crates;
}

function cargoComponents(crates) {
  const components = new Map();
  for (const c of crates) {
    if (!c.name || !c.version) {
      throw new Error("sbom: Cargo.lock [[package]] section missing name/version");
    }
    const registry = typeof c.source === "string" && c.source.length > 0;
    const purl = `pkg:cargo/${c.name}@${c.version}`;
    if (components.has(purl)) continue; // same name+version can repeat with different targets
    components.set(purl, {
      type: "library",
      "bom-ref": purl,
      name: c.name,
      version: c.version,
      purl,
      scope: "required",
      ...(registry && c.checksum ? { hashes: [{ alg: "SHA-256", content: c.checksum }] } : {}),
      properties: [
        { name: "syntaxdm:delivery", value: "rust-core-binary" },
        { name: "syntaxdm:first-party", value: registry ? "false" : "true" },
      ],
    });
  }
  return components;
}

// ---------------------------------------------------------------------------
// Bundled toolchains (yt-dlp / Deno / FFmpeg)
// ---------------------------------------------------------------------------

function toolchainComponents(toolchains) {
  const components = new Map();
  if (toolchains?.manifestVersion !== 1 || !Array.isArray(toolchains.tools)) {
    throw new Error("sbom: toolchains.json must be {manifestVersion:1, tools:[...]}");
  }
  for (const tool of toolchains.tools) {
    if (!tool.id || !tool.version || !tool.platforms) {
      throw new Error("sbom: toolchains.json tool missing id/version/platforms");
    }
    const purl = `pkg:generic/${tool.id}@${tool.version}`;
    const props = [
      { name: "syntaxdm:delivery", value: "bundled-tool" },
      { name: "syntaxdm:first-party", value: "false" },
    ];
    for (const [platform, spec] of Object.entries(tool.platforms).sort()) {
      if (!/^[0-9a-f]{64}$/.test(spec.sha256 ?? "")) {
        throw new Error(`sbom: toolchain ${tool.id} (${platform}) sha256 is not 64 hex chars`);
      }
      props.push({ name: `syntaxdm:toolchain:sha256:${platform}`, value: spec.sha256 });
      props.push({ name: `syntaxdm:toolchain:url:${platform}`, value: spec.url });
      props.push({
        name: `syntaxdm:toolchain:sizeBytes:${platform}`,
        value: String(spec.sizeBytes),
      });
    }
    components.set(purl, {
      type: "application",
      "bom-ref": purl,
      name: tool.id,
      version: tool.version,
      purl,
      scope: "required",
      licenses: [{ license: { id: TOOLCHAIN_LICENSES[tool.id] ?? "NOASSERTION" } }],
      properties: props,
    });
  }
  return components;
}

// ---------------------------------------------------------------------------
// SBOM assembly
// ---------------------------------------------------------------------------

export function buildSbom(inputs) {
  const { rootPkg, desktopPkg, lock, cargoLockText, toolchains } = inputs;

  const version = rootPkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`sbom: root package.json version invalid: ${version}`);
  }
  if (desktopPkg.version !== version) {
    throw new Error(`sbom: desktop version ${desktopPkg.version} != root version ${version}`);
  }

  const runtimeRoots = Object.keys(desktopPkg.dependencies ?? {}).filter(
    (d) => d !== "@syntaxdm/contracts",
  );
  const firstParty = new Set(["@syntaxdm/contracts", "syntax-download-manager"]);

  const merged = new Map();
  const addAll = (map) => {
    for (const [purl, comp] of map) {
      if (merged.has(purl)) continue;
      merged.set(purl, comp);
    }
  };

  // app.asar runtime closure (contracts first so zod et al. are covered)
  addAll(npmClosure(lock, ["@syntaxdm/contracts"], "app-asar", firstParty));
  addAll(npmClosure(lock, runtimeRoots, "app-asar", firstParty));
  // renderer bundle (dev deps that ship inside app.bundle.js)
  addAll(npmClosure(lock, RENDERER_BUNDLED, "renderer-bundle", firstParty));
  // Electron itself — the shipping runtime binary
  const electronVersion = desktopPkg.devDependencies?.electron;
  if (!electronVersion) throw new Error("sbom: electron version missing from desktop manifest");
  const electronPurl = npmPurl("electron", electronVersion);
  merged.set(electronPurl, {
    type: "application",
    "bom-ref": electronPurl,
    name: "electron",
    version: electronVersion,
    purl: electronPurl,
    scope: "required",
    properties: [
      { name: "syntaxdm:delivery", value: "electron-runtime" },
      { name: "syntaxdm:first-party", value: "false" },
    ],
  });
  // Rust crates + bundled tools
  addAll(cargoComponents(parseCargoLock(cargoLockText)));
  addAll(toolchainComponents(toolchains));

  const components = [...merged.values()].sort((a, b) =>
    a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0,
  );

  const appPurl = `pkg:generic/syntax-download-manager@${version}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": appPurl,
        name: "syntax-download-manager",
        version,
        purl: appPurl,
        description:
          "Syntax Download Manager — unified browser + advanced download manager (Electron shell + supervised Rust core). See THIRD-PARTY-NOTICES.md for bundled third-party software.",
        licenses: [{ license: { id: "MIT" } }],
        properties: [
          {
            name: "syntaxdm:license-note",
            value:
              "MIT with attribution and name-retention terms — the LICENSE file is authoritative",
          },
          {
            name: "syntaxdm:scoping",
            value:
              "shipped components only: app.asar runtime closure, renderer bundle, Electron runtime, Rust core crates, bundled toolchain binaries; build/test tooling is excluded by design",
          },
        ],
      },
    },
    components,
  };
}

// ---------------------------------------------------------------------------
// I/O + selftest
// ---------------------------------------------------------------------------

function readRepoInputs() {
  return {
    rootPkg: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")),
    desktopPkg: JSON.parse(readFileSync(join(ROOT, "apps/desktop/package.json"), "utf8")),
    lock: JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")),
    cargoLockText: readFileSync(join(ROOT, "core/Cargo.lock"), "utf8"),
    toolchains: JSON.parse(
      readFileSync(join(ROOT, "apps/desktop/resources/toolchains.json"), "utf8"),
    ),
  };
}

function assert(cond, message) {
  if (!cond) throw new Error(`sbom selftest: FAILED — ${message}`);
}

export function selftest() {
  const inputs = readRepoInputs();
  const sbom = buildSbom(inputs);

  assert(sbom.bomFormat === "CycloneDX", "bomFormat must be CycloneDX");
  assert(sbom.specVersion === "1.5", `specVersion must be 1.5, got ${sbom.specVersion}`);
  assert(sbom.version === 1, "document version must be 1");
  assert(
    sbom.serialNumber === undefined && sbom.metadata.timestamp === undefined,
    "SBOM must be deterministic (no serialNumber/timestamp)",
  );

  const app = sbom.metadata.component;
  assert(app.name === "syntax-download-manager", "app component name");
  assert(app.version === inputs.rootPkg.version, "app component version must match root pkg");

  const refs = sbom.components.map((c) => c["bom-ref"]);
  assert(new Set(refs).size === refs.length, "bom-refs must be unique");
  const sorted = [...refs].sort();
  assert(
    JSON.stringify(refs) === JSON.stringify(sorted),
    "components must be sorted by bom-ref",
  );
  const byPurl = new Map(sbom.components.map((c) => [c.purl, c]));
  const has = (purl) => byPurl.has(purl);

  // toolchains: exactly the three bundled tools, each with per-platform sha256
  const tools = sbom.components.filter((c) => c.purl.startsWith("pkg:generic/"));
  assert(tools.length === 3, `expected 3 toolchain components, got ${tools.length}`);
  for (const t of tools) {
    for (const platform of ["win32-x64", "linux-x64"]) {
      const sha = t.properties.find((p) => p.name === `syntaxdm:toolchain:sha256:${platform}`);
      assert(sha && /^[0-9a-f]{64}$/.test(sha.value), `${t.name} needs a ${platform} sha256`);
    }
    assert(
      Array.isArray(t.licenses) && t.licenses.length === 1,
      `${t.name} must carry its license`,
    );
  }

  // shipped npm surface
  assert(has("pkg:npm/electron@44.5.1"), "electron runtime component");
  assert(has(npmPurl("react", inputs.lock.packages["node_modules/react"].version)), "react bundled");
  assert(
    has(npmPurl("@fluentui/react-components", inputs.lock.packages["node_modules/@fluentui/react-components"].version)),
    "fluent UI bundled",
  );
  assert(has("pkg:npm/electron-updater@6.8.10"), "asar runtime closure: electron-updater");
  assert(has("pkg:npm/zod@" + (inputs.lock.packages["node_modules/zod"]?.version ?? "x")), "zod ships via contracts");
  assert(
    sbom.components.some(
      (c) => c.name === "@syntaxdm/contracts" &&
        c.properties.some((p) => p.name === "syntaxdm:first-party" && p.value === "true"),
    ),
    "contracts is first-party",
  );

  // dev-only exclusion proof: build/test tooling never ships
  for (const banned of ["typescript", "vitest", "esbuild", "electron-builder", "@types/react"]) {
    const leaked = sbom.components.some((c) => c.name === banned);
    assert(!leaked, `dev-only package ${banned} must NOT be in the SBOM`);
  }

  // cargo surface
  const cargo = sbom.components.filter((c) => c.purl.startsWith("pkg:cargo/"));
  assert(cargo.length >= 150, `expected >=150 crates, got ${cargo.length}`);
  const withHash = cargo.filter((c) => Array.isArray(c.hashes) && c.hashes[0]?.alg === "SHA-256");
  assert(withHash.length >= 150, "registry crates must carry sha256 hashes");
  const firstPartyCargo = cargo.filter((c) =>
    c.properties.some((p) => p.name === "syntaxdm:first-party" && p.value === "true"),
  );
  assert(firstPartyCargo.length === 4, "exactly 4 first-party crates (core + dc-*)");
  for (const name of ["download-core", "dc-protocol", "dc-storage", "dc-bt"]) {
    assert(cargo.some((c) => c.name === name), `first-party crate ${name} present`);
  }

  // determinism: two full builds must be byte-identical
  const again = buildSbom(readRepoInputs());
  assert(
    JSON.stringify(sbom) === JSON.stringify(again),
    "SBOM builds must be deterministic",
  );

  const deliveryCounts = {};
  for (const c of sbom.components) {
    const d = c.properties.find((p) => p.name === "syntaxdm:delivery").value;
    deliveryCounts[d] = (deliveryCounts[d] ?? 0) + 1;
  }
  console.log(`sbom selftest: OK — ${sbom.components.length} components`);
  for (const [delivery, count] of Object.entries(deliveryCounts).sort()) {
    console.log(`  ${delivery}: ${count}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
    return;
  }
  const outFlag = argv.indexOf("--out");
  if (outFlag === -1 || !argv[outFlag + 1]) {
    console.error("usage: node scripts/sbom.mjs --out <path> | --selftest");
    process.exit(2);
  }
  const outPath = argv[outFlag + 1];
  const sbom = buildSbom(readRepoInputs());
  const json = JSON.stringify(sbom, null, 2) + "\n";
  writeFileSync(outPath, json, "utf8");
  const digest = createHash("sha256").update(json, "utf8").digest("hex");
  console.log(`sbom: wrote ${outPath} (${sbom.components.length} components, sha256 ${digest})`);
}

main();
