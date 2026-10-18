#!/usr/bin/env node
// Phase 22 build gate: enforce the renderer bundle budgets from scripts/perf-budgets.json.
// Runs in verify-all.sh AFTER `build:desktop` produces dist/renderer. Fails (exit 1) with a
// clear report when any budget is breached. Sourcemaps are excluded (they are dev artifacts,
// never shipped to the renderer's runtime).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const budgetsPath = join(repoRoot, "scripts", "perf-budgets.json");
const assetsDir = join(repoRoot, "apps", "desktop", "dist", "renderer", "assets");

const budgets = JSON.parse(readFileSync(budgetsPath, "utf8"));
let files;
try {
  files = readdirSync(assetsDir);
} catch {
  console.error(`[perf-budgets] renderer assets directory not found: ${assetsDir}`);
  console.error("[perf-budgets] run `npm run build:desktop` before the budget check");
  process.exit(1);
}

const jsFiles = files.filter((f) => f.endsWith(".js"));
const cssFiles = files.filter((f) => f.endsWith(".css"));
const sum = (names) =>
  names.reduce((total, name) => total + statSync(join(assetsDir, name)).size, 0);

const totalJs = sum(jsFiles);
const largestJs = jsFiles.reduce((max, name) => {
  const size = statSync(join(assetsDir, name)).size;
  return size > max ? size : max;
}, 0);
const totalCss = sum(cssFiles);

const checks = [
  {
    name: "renderer.maxTotalJsBytes",
    budget: budgets.renderer.maxTotalJsBytes.budget,
    actual: totalJs,
  },
  {
    name: "renderer.maxLargestChunkBytes",
    budget: budgets.renderer.maxLargestChunkBytes.budget,
    actual: largestJs,
  },
  {
    name: "renderer.maxTotalCssBytes",
    budget: budgets.renderer.maxTotalCssBytes.budget,
    actual: totalCss,
  },
];

let failed = false;
console.log("[perf-budgets] renderer bundle inventory:");
for (const check of checks) {
  const status = check.actual <= check.budget ? "ok" : "BREACH";
  console.log(
    `  ${check.name}: ${check.actual} / ${check.budget} bytes — ${status}` +
      (check.actual > check.budget ? ` (measured baseline: ${check.actual})` : ""),
  );
  if (check.actual > check.budget) failed = true;
}

if (failed) {
  console.error(
    "[perf-budgets] BUDGET BREACH — see scripts/perf-budgets.json. " +
      "A budget breach is a real regression signal: either shrink the bundle (deps, duplicates) " +
      "or consciously raise the budget in perf-budgets.json with justification in the phase report.",
  );
  process.exit(1);
}
console.log("[perf-budgets] all renderer budgets respected");
