import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetReport, makeRequest, newUlid } from "@syntaxdm/contracts";
import {
  assembleBudgetReport,
  inventoryRendererBundle,
  loadBudgetsFile,
  measureCoreEchoUs,
  type BudgetReportDeps,
} from "../perf/budget-report.js";
import { budgetReportSourceLabel, rendererAssetsDirUnder } from "../perf/report-env.js";
import { buildWindowsRssProbeCommand, parseWindowsRssOutput } from "../core/core-supervisor.js";
import { IpcRouter } from "../ipc/router.js";
import { registerPerfDomain } from "../domains/perf.js";
import type { JsonlLogger } from "../logging/logger.js";

/**
 * Phase 29 — the budget report harness. The verdict arithmetic is enforced twice
 * (here and by the contract schema's superRefine); these tests pin the assembly:
 * producers measure or skip with reasons, breaches flip the overall verdict, the
 * budgets file is shape-checked (loud packaging failure), concurrent runs single-flight,
 * and the Windows probe's pure pieces behave.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "syntaxdm-budget-"));
  tmpDirs.push(dir);
  return dir;
}

/** The REAL budgets file — the same bytes the packaged app ships. */
function realBudgetsRaw(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    try {
      return readFileSync(join(dir, "resources", "perf-budgets.json"), "utf8");
    } catch {
      dir = join(dir, "..");
    }
  }
  throw new Error("resources/perf-budgets.json not found upward from cwd");
}

function writeBudgets(raw: string): string {
  const file = join(tmpDir(), "perf-budgets.json");
  writeFileSync(file, raw);
  return file;
}

function fakeSupervisor(overrides: Partial<Pick<BudgetReportDeps["supervisor"], "isReady" | "request" | "sampleCoreRssBytes">> = {}): BudgetReportDeps["supervisor"] {
  return {
    isReady: true,
    request: (async () => ({ pong: true })) as BudgetReportDeps["supervisor"]["request"],
    sampleCoreRssBytes: async () => 17_584_128,
    ...overrides,
  };
}

function fakeLogger() {
  const infos: Array<{ component: string; msg: string; fields?: Record<string, unknown> }> = [];
  return {
    infos,
    // Typed as the WIDEST structural shape any consumer needs (info|debug); a
    // Pick<...,"info"|"debug"> is assignable everywhere a Pick<...,"info"> is required.
    logger: {
      info: (component: string, msg: string, fields?: Record<string, unknown>) => infos.push({ component, msg, fields }),
      debug: () => undefined,
    } as Pick<JsonlLogger, "info" | "debug">,
  };
}

function baseDeps(overrides: Partial<BudgetReportDeps> = {}): BudgetReportDeps {
  const { logger } = fakeLogger();
  return {
    budgetsFile: writeBudgets(realBudgetsRaw()),
    bootClock: {
      report: () => ({
        phases: [],
        totalToCoreReadyMs: 150,
        coreSpawnToReadyMs: 42,
        recordedAt: 1_791_000_000_000,
      }),
    },
    supervisor: fakeSupervisor(),
    appVersion: "0.16.0",
    platform: "linux",
    osRelease: "6.8.0-test",
    source: "dev",
    rendererAssetsDir: join(tmpDir(), "assets-that-do-not-exist"),
    logger,
    now: () => 1_791_000_002_000,
    ...overrides,
  };
}

describe("loadBudgetsFile (Phase 29)", () => {
  it("accepts the real shipped budgets file and exposes all nine positive budgets", () => {
    const budgets = loadBudgetsFile(realBudgetsRaw());
    expect(budgets.core.coldStartReadyMs!.budget).toBe(2000);
    expect(budgets.core.rssAfterReadyKb!.budget).toBe(65536);
    expect(budgets.core.echoAvgUs!.budget).toBe(2000);
    expect(budgets.renderer.maxTotalJsBytes!.budget).toBe(1_200_000);
    expect(budgets.ts.uiQueueSortMs!.budget).toBe(500);
  });

  it("fails loud on malformed JSON, missing sections, and missing/non-positive budgets", () => {
    expect(() => loadBudgetsFile("{not json")).toThrow(/not valid JSON/);
    expect(() => loadBudgetsFile("{}")).toThrow(/missing required sections/);
    const missingId = JSON.parse(realBudgetsRaw());
    delete missingId.core.echoAvgUs;
    expect(() => loadBudgetsFile(JSON.stringify(missingId))).toThrow(/echoAvgUs/);
    const zeroBudget = JSON.parse(realBudgetsRaw());
    zeroBudget.ts.uiQueueSortMs.budget = 0;
    expect(() => loadBudgetsFile(JSON.stringify(zeroBudget))).toThrow(/positive budget/);
  });
});

describe("inventoryRendererBundle (Phase 29)", () => {
  it("totals .js/.css assets and reports the largest .js; missing dir is null, not a throw", () => {
    const dir = join(tmpDir(), "assets");
    mkdirSync(dir);
    writeFileSync(join(dir, "index-a.js"), "x".repeat(100));
    writeFileSync(join(dir, "chunk-b.js"), "x".repeat(250));
    writeFileSync(join(dir, "style.css"), "x".repeat(30));
    writeFileSync(join(dir, "logo.svg"), "x".repeat(500)); // not inventoried
    expect(inventoryRendererBundle(dir)).toEqual({ totalJs: 350, largestJs: 250, totalCss: 30 });
    expect(inventoryRendererBundle(join(tmpDir(), "nope"))).toBeNull();
  });
});

describe("measureCoreEchoUs (Phase 29)", () => {
  it("averages real round-trip times when every ping answers, else skips", async () => {
    const ok = await measureCoreEchoUs({ isReady: true, request: (async () => ({ pong: true })) as BudgetReportDeps["supervisor"]["request"] }, 20);
    expect(ok).toBeGreaterThan(0);
    // Core not ready → null (skip), not a made-up number.
    expect(await measureCoreEchoUs({ isReady: false, request: (async () => ({ pong: true })) as BudgetReportDeps["supervisor"]["request"] }, 5)).toBeNull();
    // Any failed round-trip poisons the average — no partial measurements.
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 3) throw new Error("core died mid-measurement");
      return { pong: true };
    }) as BudgetReportDeps["supervisor"]["request"];
    expect(await measureCoreEchoUs({ isReady: true, request: flaky }, 10)).toBeNull();
    // A wrong-shaped reply is a failure too.
    const liar = (async () => ({ pong: false })) as BudgetReportDeps["supervisor"]["request"];
    expect(await measureCoreEchoUs({ isReady: true, request: liar }, 10)).toBeNull();
  });
});

describe("assembleBudgetReport (Phase 29)", () => {
  it("assembles a healthy report when every producer measures under budget", async () => {
    const { logger, infos } = fakeLogger();
    const report = await assembleBudgetReport(baseDeps({ logger }));
    expect(report.verdict).toBe("healthy");
    expect(report.summary.total).toBe(9);
    expect(report.summary.skipped).toBe(6); // 3 bundle ids (dir absent) + 3 ts ids (no renderer input)
    expect(report.summary.passed).toBe(3); // cold start 42/2000, rss 17172/65536, echo >0
    // Producers produced REAL numbers, converted into the budget's unit:
    const rss = report.measurements.find((m) => m.id === "core.rssAfterReadyKb")!;
    expect(rss.actual).toBe(Math.round(17_584_128 / 1024)); // bytes → KiB
    expect(rss.verdict).toBe("pass");
    const cold = report.measurements.find((m) => m.id === "core.coldStartReadyMs")!;
    expect(cold.actual).toBe(42);
    // ts.* rows are skipped with a reason when the renderer contributed nothing.
    const dispatch = report.measurements.find((m) => m.id === "ts.ipcDispatch2000Ms")!;
    expect(dispatch.verdict).toBe("skipped");
    expect(dispatch.actual).toBeNull();
    expect(dispatch.detail).toMatch(/renderer measurements were not provided/);
    // The schema re-validated the whole assembly — it IS a BudgetReport.
    expect(() => BudgetReport.parse(report)).not.toThrow();
    // Exactly one log record per finished report.
    expect(infos).toHaveLength(1);
    expect(infos[0]!.msg).toBe("budget report generated");
  });

  it("renderer measurements turn the ts.* rows into pass/breach verdicts", async () => {
    const report = await assembleBudgetReport(baseDeps(), {
      ipcDispatch2000Ms: 310.5,
      uiStoreHotPathMs: 2000, // budget 1000 → breach
      uiQueueSortMs: 6.2,
    });
    const dispatch = report.measurements.find((m) => m.id === "ts.ipcDispatch2000Ms")!;
    expect(dispatch.verdict).toBe("pass");
    expect(dispatch.actual).toBeCloseTo(310.5);
    const hot = report.measurements.find((m) => m.id === "ts.uiStoreHotPathMs")!;
    expect(hot.verdict).toBe("breach");
    expect(report.summary.breached).toBe(1);
    expect(report.verdict).toBe("breached");
  });

  it("skips exactly what could not measure and never invents numbers", async () => {
    const report = await assembleBudgetReport(
      baseDeps({
        supervisor: fakeSupervisor({ isReady: false, sampleCoreRssBytes: async () => null }),
        bootClock: { report: () => ({ phases: [], totalToCoreReadyMs: null, coreSpawnToReadyMs: null, recordedAt: 1 }) },
      }),
    );
    expect(report.summary.passed).toBe(0);
    // 3 bundle ids (dir missing) + 3 ts ids (no renderer input) + 3 core ids (not ready) = 9
    expect(report.summary.skipped).toBe(9);
    for (const m of report.measurements) expect(m.actual).toBeNull();
    expect(report.verdict).toBe("healthy"); // skips never fail a report — they are listed
    const echo = report.measurements.find((m) => m.id === "core.echoAvgUs")!;
    expect(echo.detail).toMatch(/core not ready/);
  });

  it("a breach in a core producer flips the overall verdict and is named in the log", async () => {
    const { logger, infos } = fakeLogger();
    const report = await assembleBudgetReport(
      baseDeps({
        supervisor: fakeSupervisor({ request: (async () => ({ pong: true })) as BudgetReportDeps["supervisor"]["request"] }),
        bootClock: { report: () => ({ phases: [], totalToCoreReadyMs: 9_999, coreSpawnToReadyMs: 9_999, recordedAt: 1 }) },
        logger,
      }),
    );
    const cold = report.measurements.find((m) => m.id === "core.coldStartReadyMs")!;
    expect(cold.verdict).toBe("breach"); // 9999 > 2000
    expect(report.verdict).toBe("breached");
    expect(infos[0]!.fields).toMatchObject({ breachedIds: ["core.coldStartReadyMs"] });
  });

  it("carries the environment facts (source label, platform, versions)", async () => {
    const report = await assembleBudgetReport(baseDeps({ source: "packaged-app", platform: "win32", osRelease: "10.0.26100" }));
    expect(report.source).toBe("packaged-app");
    expect(report.platform).toBe("win32");
    expect(report.osRelease).toBe("10.0.26100");
    expect(report.appVersion).toBe("0.16.0");
    expect(report.reportVersion).toBe(1);
    expect(typeof report.contractVersion).toBe("string");
  });
});

describe("perf.runReport single-flight (Phase 29)", () => {
  it("concurrent callers share one assembly; sequential callers get fresh reports", async () => {
    const router = new IpcRouter();
    let ticks = 0;
    const deps = baseDeps();
    deps.now = () => 1_791_000_002_000 + ticks++;
    registerPerfDomain(router, {
      supervisor: fakeSupervisor() as never,
      bootClock: deps.bootClock as never,
      logger: fakeLogger().logger,
      report: deps,
    });
    const call = (): Promise<{ result: { report: { generatedAt: number } } }> =>
      router.handleRequest(makeRequest(newUlid(), "perf.runReport", {}), {}) as Promise<{ result: { report: { generatedAt: number } } }>;
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.result.report.generatedAt).toBe(b.result.report.generatedAt); // one assembly, shared
    const c = await call();
    expect(c.result.report.generatedAt).toBeGreaterThan(a.result.report.generatedAt); // fresh run after
  });

  it("rejects invalid renderer params at the boundary (schema-enforced)", async () => {
    const router = new IpcRouter();
    registerPerfDomain(router, {
      supervisor: fakeSupervisor() as never,
      bootClock: baseDeps().bootClock as never,
      logger: fakeLogger().logger,
      report: baseDeps(),
    });
    // handleRequest resolves with the error ENVELOPE (renderer rpc is what throws).
    const response = (await router.handleRequest(
      makeRequest(newUlid(), "perf.runReport", { renderer: { ipcDispatch2000Ms: -5, uiStoreHotPathMs: 1, uiQueueSortMs: 1 } }),
      {},
    )) as { ok: boolean; error?: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("invalid_params");
    // perf.probe is the fixed tiny round-trip.
    const probe = (await router.handleRequest(makeRequest(newUlid(), "perf.probe", {}), {})) as { result: { pong: boolean } };
    expect(probe.result.pong).toBe(true);
  });
});

describe("report-env + Windows probe helpers (Phase 29)", () => {
  it("maps the process facts onto the report's environment fields", () => {
    expect(budgetReportSourceLabel(true)).toBe("packaged-app");
    expect(budgetReportSourceLabel(false)).toBe("dev");
    expect(rendererAssetsDirUnder("/root")).toMatch(/[\\/]dist[\\/]renderer[\\/]assets$/);
  });

  it("builds a sandboxed PowerShell probe and parses only honest byte counts", () => {
    const argv = buildWindowsRssProbeCommand(4242);
    expect(argv.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(argv[3]).toContain("(Get-Process -Id 4242 -ErrorAction SilentlyContinue)");
    expect(parseWindowsRssOutput("17584128\n")).toBe(17_584_128);
    expect(parseWindowsRssOutput("  17584128  \n")).toBe(17_584_128);
    expect(parseWindowsRssOutput("")).toBeNull(); // process gone → empty output
    expect(parseWindowsRssOutput("Get-Process : No process found")).toBeNull();
    expect(parseWindowsRssOutput("-17")).toBeNull();
    expect(parseWindowsRssOutput("NaN")).toBeNull();
  });
});

describe("perf domain probe registration (Phase 29)", () => {
  it("perf.probe and perf.runReport are main-served with schemas", () => {
    const router = new IpcRouter();
    const { logger } = fakeLogger();
    registerPerfDomain(router, {
      supervisor: fakeSupervisor() as never,
      bootClock: baseDeps().bootClock as never,
      logger,
      report: baseDeps(),
    });
    // Registration succeeded and the router answers both methods (covered above);
    // this pins that registering twice with the same router would collide loudly.
    expect(() =>
      registerPerfDomain(router, {
        supervisor: fakeSupervisor() as never,
        bootClock: baseDeps().bootClock as never,
        logger,
        report: baseDeps(),
      }),
    ).toThrow();
  });
});
