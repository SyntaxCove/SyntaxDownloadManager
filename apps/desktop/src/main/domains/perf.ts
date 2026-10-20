import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { BootClock } from "../perf/boot-clock.js";
import type { JsonlLogger } from "../logging/logger.js";
import {
  PerfGetSnapshotParams, PerfGetSnapshotResult,
  PerfProbeParams, PerfProbeResult, PerfRunReportParams, PerfRunReportResult,
  type RendererMeasurements,
} from "@syntaxdm/contracts";
import { assembleBudgetReport, type BudgetReportDeps } from "../perf/budget-report.js";

/**
 * Performance domain (Phases 22 + 29) — main-served only.
 *
 * `perf.getSnapshot` (Phase 22) assembles the live snapshot from independently-degrading
 * ingredients: boot timings from the BootClock, monotonic counters from the IpcRouter,
 * main RSS from process.memoryUsage(), core RSS from the supervisor's sampler. Like
 * diagnostics (Phase 20), a perf surface that fails is worthless: no ingredient can throw
 * the method — each is either present or null/zeroed by its own producer.
 *
 * `perf.probe` (Phase 29) is a fixed tiny validated round-trip the renderer's dispatch
 * bench hammers — its whole body IS the boundary the budget describes.
 *
 * `perf.runReport` (Phase 29) assembles the budget report (see budget-report.ts).
 * Concurrent requests single-flight onto one assembly — two Diagnostics windows (or an
 * impatient double-click) share a report instead of stampeding the core with pings.
 */

export interface PerfDomainOptions {
  supervisor: CoreSupervisor;
  bootClock: BootClock;
  /** Structural: the domain only logs (info/debug) — tests inject a two-method fake. */
  logger: Pick<JsonlLogger, "info" | "debug">;
  /** Phase 29: everything the budget report needs; required — the E2E harness wires it too. */
  report: BudgetReportDeps;
}

export function registerPerfDomain(router: IpcRouter, options: PerfDomainOptions): void {
  const { supervisor, bootClock, logger } = options;
  router.handle("perf.getSnapshot", {
    paramsSchema: PerfGetSnapshotParams,
    resultSchema: PerfGetSnapshotResult,
    handler: async () => {
      const boot = bootClock.report();
      const ipc = router.counters();
      const coreRssBytes = await supervisor.sampleCoreRssBytes();
      const snapshot = {
        boot,
        ipc,
        mainRssBytes: process.memoryUsage().rss,
        coreRssBytes,
        sampledAt: Date.now(),
      };
      logger.debug("perf", "performance snapshot assembled", {
        totalToCoreReadyMs: boot.totalToCoreReadyMs,
        coreSpawnToReadyMs: boot.coreSpawnToReadyMs,
        mainRssBytes: snapshot.mainRssBytes,
        coreRssBytes,
      });
      return { snapshot };
    },
  });

  router.handle("perf.probe", {
    paramsSchema: PerfProbeParams,
    resultSchema: PerfProbeResult,
    handler: async () => ({ pong: true }),
  });

  let inFlight: Promise<{ report: Awaited<ReturnType<typeof assembleBudgetReport>> }> | null = null;
  router.handle("perf.runReport", {
    paramsSchema: PerfRunReportParams,
    resultSchema: PerfRunReportResult,
    handler: async (params) => {
      const { renderer } = params as { renderer?: RendererMeasurements };
      if (inFlight) return inFlight;
      inFlight = assembleBudgetReport(options.report, renderer)
        .then((report) => ({ report }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  });
}
