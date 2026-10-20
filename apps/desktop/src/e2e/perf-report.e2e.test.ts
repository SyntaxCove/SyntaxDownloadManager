import { afterAll, beforeAll, expect, it } from "vitest";
import { CONTRACT_VERSION } from "@syntaxdm/contracts";
import { bootApp, describeWithCore, desktopVersion, type AppHandle } from "./harness.js";

/**
 * E2E suite 21 — the real-device budget report harness over the REAL Rust core through
 * the REAL main-process composition. Proves: the harness measures what a device measures
 * (real cold start from the BootClock, real core RSS from /proc, real 100-ping echo
 * average), skips honestly what it cannot measure in this environment, produces a
 * schema-consistent report whose verdicts match the shipped budgets, single-flights
 * concurrent assemblies, and hammers the real perf.probe boundary.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await bootApp();
}, 60_000);

afterAll(async () => {
  await app?.dispose();
}, 60_000);

describeWithCore("E2E budget report — the harness over the real core", () => {
  it(
    "assembles a healthy, schema-consistent report with real core measurements",
    async () => {
      await app.supervisor.whenReady(30_000);
      const { report } = (await app.rpc("perf.runReport", {})) as {
        report: {
          reportVersion: number;
          generatedAt: number;
          appVersion: string;
          contractVersion: string;
          platform: string;
          source: string;
          measurements: {
            id: string;
            budget: number;
            actual: number | null;
            unit: string;
            verdict: string;
            detail: string;
          }[];
          summary: { total: number; passed: number; breached: number; skipped: number };
          verdict: string;
        };
      };

      expect(report.reportVersion).toBe(1);
      expect(report.appVersion).toBe(desktopVersion());
      expect(report.contractVersion).toBe(CONTRACT_VERSION);
      expect(report.source).toBe("headless-test");
      expect(report.platform).toBe(process.platform);
      expect(report.measurements).toHaveLength(9);

      // Core budgets are MEASURED over the real core — not skipped, not invented.
      const cold = report.measurements.find((m) => m.id === "core.coldStartReadyMs")!;
      expect(cold.verdict).toBe("pass");
      expect(cold.actual).toBeGreaterThan(0);
      expect(cold.actual!).toBeLessThanOrEqual(cold.budget);
      const rss = report.measurements.find((m) => m.id === "core.rssAfterReadyKb")!;
      expect(rss.verdict).toBe("pass"); // Linux sandbox: /proc sampling is the real mechanism
      expect(rss.actual!).toBeGreaterThan(0);
      const echo = report.measurements.find((m) => m.id === "core.echoAvgUs")!;
      expect(echo.verdict).toBe("pass");
      expect(echo.actual!).toBeGreaterThan(0);

      // Renderer bundle assets may or may not exist pre-build (verify-all builds AFTER
      // tests) — both outcomes are honest: measured or skipped with a reason.
      for (const id of ["renderer.maxTotalJsBytes", "renderer.maxLargestChunkBytes", "renderer.maxTotalCssBytes"]) {
        const m = report.measurements.find((x) => x.id === id)!;
        expect(["pass", "breach", "skipped"]).toContain(m.verdict);
        if (m.verdict === "skipped") expect(m.detail).toMatch(/assets/);
      }

      // Without renderer input the three ts.* rows skip with a reason.
      for (const id of ["ts.ipcDispatch2000Ms", "ts.uiStoreHotPathMs", "ts.uiQueueSortMs"]) {
        const m = report.measurements.find((x) => x.id === id)!;
        expect(m.verdict).toBe("skipped");
        expect(m.actual).toBeNull();
      }

      // Headroom holds on the real core: zero breaches → healthy.
      expect(report.summary.breached).toBe(0);
      expect(report.verdict).toBe("healthy");
      expect(report.summary.passed + report.summary.breached + report.summary.skipped).toBe(report.summary.total);
    },
    60_000,
  );

  it(
    "turns renderer measurements into verdicts (breach math over the real main)",
    async () => {
      // uiQueueSortMs over budget (500) must flip that row to breach and the report
      // overall to breached; the other two rows stay honest passes.
      const { report } = (await app.rpc("perf.runReport", {
        renderer: { ipcDispatch2000Ms: 400, uiStoreHotPathMs: 500, uiQueueSortMs: 9999 },
      })) as {
        report: {
          measurements: { id: string; verdict: string; actual: number | null }[];
          summary: { breached: number };
          verdict: string;
        };
      };
      expect(report.measurements.find((m) => m.id === "ts.ipcDispatch2000Ms")!.verdict).toBe("pass");
      expect(report.measurements.find((m) => m.id === "ts.uiStoreHotPathMs")!.verdict).toBe("pass");
      const sort = report.measurements.find((m) => m.id === "ts.uiQueueSortMs")!;
      expect(sort.verdict).toBe("breach");
      expect(sort.actual).toBe(9999);
      expect(report.summary.breached).toBe(1);
      expect(report.verdict).toBe("breached");
    },
    60_000,
  );

  it(
    "single-flights concurrent assemblies and starts fresh afterwards",
    async () => {
      const call = (): Promise<{ report: { generatedAt: number } }> => app.rpc("perf.runReport", {}) as never;
      const [a, b] = await Promise.all([call(), call()]);
      expect(a.report.generatedAt).toBe(b.report.generatedAt); // shared in-flight assembly
      const c = await call();
      expect(c.report.generatedAt).toBeGreaterThan(a.report.generatedAt); // fresh assembly
    },
    60_000,
  );

  it(
    "serves perf.probe as the fixed tiny validated round-trip",
    async () => {
      const pong = (await app.rpc("perf.probe", {})) as { pong: boolean };
      expect(pong).toEqual({ pong: true });
      // The harness's canonical bench shape: 2,000 sequential real round-trips.
      const t0 = Date.now();
      for (let i = 0; i < 2_000; i++) {
        const p = (await app.rpc("perf.probe", {})) as { pong: boolean };
        if (p.pong !== true) throw new Error("probe returned an unexpected shape");
      }
      const elapsed = Date.now() - t0;
      // Loose wall-clock bound for the E2E environment (the budget gate owns the strict
      // number): a pathological per-request cost would still blow past this.
      expect(elapsed).toBeLessThan(10_000);
    },
    60_000,
  );

  it(
    "reports skipped measurements with reasons, never invented numbers",
    async () => {
      const { report } = (await app.rpc("perf.runReport", {})) as {
        report: { measurements: { id: string; verdict: string; actual: number | null; detail: string }[] };
      };
      for (const m of report.measurements) {
        if (m.verdict === "skipped") {
          expect(m.actual).toBeNull();
          expect(m.detail.length).toBeGreaterThan(5);
        } else {
          expect(m.actual).not.toBeNull();
          expect(m.detail.length).toBeGreaterThan(5);
        }
      }
    },
    60_000,
  );
});
