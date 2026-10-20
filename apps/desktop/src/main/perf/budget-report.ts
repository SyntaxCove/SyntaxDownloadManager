import { readFileSync, readdirSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  BudgetReport, BudgetReportSource, BudgetId, BudgetMeasurement, CONTRACT_VERSION,
  RendererMeasurements, SyntaxDmError,
} from "@syntaxdm/contracts";
import type { BootClock } from "./boot-clock.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { JsonlLogger } from "../logging/logger.js";

/**
 * Phase 29 — the real-device budget report harness.
 *
 * Assembles a contract-typed BudgetReport from independently-degrading producers
 * (diagnostics posture: a report that throws is worthless — every producer either
 * measures or reports `skipped` with a reason):
 *
 *   core.coldStartReadyMs   ← BootClock core-spawned → core-ready mark (last boot)
 *   core.rssAfterReadyKb    ← the supervisor's RSS sampler (/proc or PowerShell probe)
 *   core.echoAvgUs          ← average of 100 real core.ping round-trips (all must succeed)
 *   renderer.*Bytes         ← inventory of the shipped dist/renderer/assets
 *   ts.*                    ← optional renderer-side benches (absent ⇒ skipped)
 *
 * The budgets themselves are read at run time from apps/desktop/resources/perf-budgets.json
 * (packaged as perf-budgets.json — the toolchains.json precedent). The verdict arithmetic
 * is enforced twice: here, and by the BudgetReport schema's superRefine — a report that
 * parses is an internally consistent report. A missing or malformed budgets file is a
 * packaging bug and fails LOUD (internal_error), never a silently-green report.
 */

/** The shape of apps/desktop/resources/perf-budgets.json this harness consumes. */
export interface PerfBudgetsFile {
  core: Record<string, { budget: number; measured?: number | null; note?: string }>;
  renderer: Record<string, { budget: number; measured?: number | null; note?: string }>;
  ts: Record<string, { budget: number; measured?: number | null; note?: string }>;
}

/** Mapping budget id → (section, key, unit) in the budgets file. Closed over the 9 ids. */
const BUDGET_SOURCES: Readonly<
  Record<BudgetId, { section: "core" | "renderer" | "ts"; key: string; unit: "ms" | "us" | "bytes" | "kb" }>
> = {
  "core.coldStartReadyMs": { section: "core", key: "coldStartReadyMs", unit: "ms" },
  "core.rssAfterReadyKb": { section: "core", key: "rssAfterReadyKb", unit: "kb" },
  "core.echoAvgUs": { section: "core", key: "echoAvgUs", unit: "us" },
  "renderer.maxTotalJsBytes": { section: "renderer", key: "maxTotalJsBytes", unit: "bytes" },
  "renderer.maxLargestChunkBytes": { section: "renderer", key: "maxLargestChunkBytes", unit: "bytes" },
  "renderer.maxTotalCssBytes": { section: "renderer", key: "maxTotalCssBytes", unit: "bytes" },
  "ts.ipcDispatch2000Ms": { section: "ts", key: "ipcDispatch2000Ms", unit: "ms" },
  "ts.uiStoreHotPathMs": { section: "ts", key: "uiStoreHotPathMs", unit: "ms" },
  "ts.uiQueueSortMs": { section: "ts", key: "uiQueueSortMs", unit: "ms" },
};

/** Parse + shape-check the budgets file. Missing/malformed = packaging bug = loud failure. */
export function loadBudgetsFile(raw: string): PerfBudgetsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyntaxDmError("internal_error", "perf budgets file is not valid JSON");
  }
  const doc = parsed as Partial<PerfBudgetsFile> | null;
  if (!doc || typeof doc !== "object" || !doc.core || !doc.renderer || !doc.ts) {
    throw new SyntaxDmError("internal_error", "perf budgets file is missing required sections (core/renderer/ts)");
  }
  for (const id of BudgetId.options) {
    const src = BUDGET_SOURCES[id];
    const entry = doc[src.section]?.[src.key];
    if (!entry || typeof entry.budget !== "number" || !Number.isFinite(entry.budget) || entry.budget <= 0) {
      throw new SyntaxDmError("internal_error", `perf budgets file is missing a positive budget for ${id}`);
    }
  }
  return doc as PerfBudgetsFile;
}

/** Inventory the shipped renderer bundle; null = the directory is not there (skip, don't lie). */
export function inventoryRendererBundle(
  assetsDir: string,
): { totalJs: number; largestJs: number; totalCss: number } | null {
  let files: string[];
  try {
    files = readdirSync(assetsDir);
  } catch {
    return null;
  }
  const size = (name: string): number => statSync(`${assetsDir}/${name}`).size;
  const js = files.filter((f) => f.endsWith(".js"));
  const totalJs = js.reduce((sum, f) => sum + size(f), 0);
  const largestJs = js.reduce((max, f) => Math.max(max, size(f)), 0);
  const totalCss = files.filter((f) => f.endsWith(".css")).reduce((sum, f) => sum + size(f), 0);
  return { totalJs, largestJs, totalCss };
}

/**
 * Average of `samples` real core.ping round-trips in µs. ALL samples must succeed — a
 * partial timing is not a measurement (null ⇒ the report skips with a reason).
 */
export async function measureCoreEchoUs(
  supervisor: Pick<CoreSupervisor, "isReady" | "request">,
  samples: number = 100,
): Promise<number | null> {
  if (!supervisor.isReady) return null;
  let totalUs = 0;
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      const pong = (await supervisor.request("core.ping")) as { pong?: unknown } | null;
      if (!pong || pong.pong !== true) return null;
    } catch {
      return null; // core died / timed out mid-measurement: no honest average exists
    }
    totalUs += (performance.now() - t0) * 1_000;
  }
  return Math.round((totalUs / samples) * 10) / 10;
}

function verdictFor(actual: number, budget: number): "pass" | "breach" {
  return actual <= budget ? "pass" : "breach";
}

/** A producer's outcome: a measured number, or the reason it could not measure. */
interface ProducerOutcome {
  actual?: number;
  skip?: string;
}

export interface BudgetReportDeps {
  /** Absolute budgets file path (paths.ts perfBudgets — dev or packaged resolution). */
  budgetsFile: string;
  bootClock: Pick<BootClock, "report">;
  supervisor: Pick<CoreSupervisor, "isReady" | "request" | "sampleCoreRssBytes">;
  appVersion: string;
  platform: string;
  osRelease: string;
  source: BudgetReportSource;
  /** Absolute dist/renderer/assets dir under the app root (same relative path dev + packaged). */
  rendererAssetsDir: string;
  logger: Pick<JsonlLogger, "info">;
  now?: () => number;
}

/** Fixed provenance strings — the same measurement is described the same way every run. */
const DETAILS: Record<BudgetId, string> = {
  "core.coldStartReadyMs": "BootClock core-spawned → core-ready on this device's last boot",
  "core.rssAfterReadyKb": "core RSS sample after the first ready transition (rounded to KiB)",
  "core.echoAvgUs": "average of 100 core.ping round-trips through the running core",
  "renderer.maxTotalJsBytes": "sum of the shipped renderer's .js assets",
  "renderer.maxLargestChunkBytes": "largest shipped renderer .js asset",
  "renderer.maxTotalCssBytes": "sum of the shipped renderer's .css assets",
  "ts.ipcDispatch2000Ms": "2000 perf.probe round-trips through the real preload bridge",
  "ts.uiStoreHotPathMs": "2000 upserts + 2000 patches over a throwaway 200-job store",
  "ts.uiQueueSortMs": "100 sorts of a 500-job list with the shipped comparator",
};

/**
 * Assemble the report. Never throws for MEASUREMENT reasons (producers skip); throws
 * internal_error only when the budgets source itself is unusable (packaging bug).
 * The result is schema-parsed — an inconsistent assembly cannot reach the wire.
 */
export async function assembleBudgetReport(
  deps: BudgetReportDeps,
  renderer?: RendererMeasurements,
): Promise<BudgetReport> {
  const budgets = loadBudgetsFile(readFileSync(deps.budgetsFile, "utf8"));
  const now = deps.now ?? (() => Date.now());

  // ---- core producers ----
  const boot = deps.bootClock.report();
  const producers: Partial<Record<BudgetId, ProducerOutcome>> = {
    "core.coldStartReadyMs":
      boot.coreSpawnToReadyMs === null
        ? { skip: "boot not finished yet — no core-spawned→core-ready marks" }
        : { actual: boot.coreSpawnToReadyMs },
    "core.echoAvgUs": await measureCoreEchoUs(deps.supervisor).then(
      (us) => (us === null ? { skip: "core not ready or a ping round-trip failed — no honest average exists" } : { actual: us }),
    ),
  };
  const rssBytes = await deps.supervisor.sampleCoreRssBytes();
  producers["core.rssAfterReadyKb"] =
    rssBytes === null
      ? { skip: "core RSS sampling unavailable on this platform or the core is not running" }
      : { actual: Math.round(rssBytes / 1024) };

  // ---- renderer bundle producer (three ids share one inventory) ----
  const bundle = inventoryRendererBundle(deps.rendererAssetsDir);
  const bundleSkip = "renderer bundle assets not found in this install";
  producers["renderer.maxTotalJsBytes"] = bundle ? { actual: bundle.totalJs } : { skip: bundleSkip };
  producers["renderer.maxLargestChunkBytes"] = bundle ? { actual: bundle.largestJs } : { skip: bundleSkip };
  producers["renderer.maxTotalCssBytes"] = bundle ? { actual: bundle.totalCss } : { skip: bundleSkip };

  // ---- renderer-side bench producer (three ids share one params object) ----
  const rendererSkip = "renderer measurements were not provided for this run";
  producers["ts.ipcDispatch2000Ms"] = renderer ? { actual: renderer.ipcDispatch2000Ms } : { skip: rendererSkip };
  producers["ts.uiStoreHotPathMs"] = renderer ? { actual: renderer.uiStoreHotPathMs } : { skip: rendererSkip };
  producers["ts.uiQueueSortMs"] = renderer ? { actual: renderer.uiQueueSortMs } : { skip: rendererSkip };

  // ---- measurements ----
  const measurements: BudgetMeasurement[] = BudgetId.options.map((id) => {
    const src = BUDGET_SOURCES[id];
    const budget = budgets[src.section][src.key]!.budget;
    const outcome = producers[id];
    if (typeof outcome?.actual === "number") {
      return BudgetMeasurement.parse({
        id,
        budget,
        actual: outcome.actual,
        unit: src.unit,
        verdict: verdictFor(outcome.actual, budget),
        detail: DETAILS[id],
      });
    }
    return BudgetMeasurement.parse({
      id,
      budget,
      actual: null,
      unit: src.unit,
      verdict: "skipped",
      detail: outcome?.skip ?? "no measurement available",
    });
  });

  const report = BudgetReport.parse({
    reportVersion: 1,
    generatedAt: now(),
    appVersion: deps.appVersion,
    contractVersion: CONTRACT_VERSION,
    platform: deps.platform,
    osRelease: deps.osRelease,
    source: deps.source,
    measurements,
    summary: {
      total: measurements.length,
      passed: measurements.filter((m) => m.verdict === "pass").length,
      breached: measurements.filter((m) => m.verdict === "breach").length,
      skipped: measurements.filter((m) => m.verdict === "skipped").length,
    },
    verdict: measurements.some((m) => m.verdict === "breach") ? "breached" : "healthy",
  });

  deps.logger.info("perf", "budget report generated", {
    verdict: report.verdict,
    passed: report.summary.passed,
    breached: report.summary.breached,
    skipped: report.summary.skipped,
    breachedIds: report.measurements.filter((m) => m.verdict === "breach").map((m) => m.id),
  });
  return report;
}
