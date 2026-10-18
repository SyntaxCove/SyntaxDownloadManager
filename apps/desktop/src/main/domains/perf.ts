import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { BootClock } from "../perf/boot-clock.js";
import type { JsonlLogger } from "../logging/logger.js";
import { PerfGetSnapshotParams, PerfGetSnapshotResult } from "@syntaxdm/contracts";

/**
 * Phase 22: performance snapshot domain (main-served only).
 *
 * Assembles the PerformanceSnapshot from independently-degrading ingredients:
 *  - boot timings from the BootClock (always available once main.ts marks phases);
 *  - monotonic counters from the IpcRouter;
 *  - main RSS from process.memoryUsage();
 *  - core RSS from the supervisor's /proc sample (null off-Linux or while not running).
 *
 * Like diagnostics (Phase 20), a perf surface that fails is worthless: no ingredient can
 * throw the method — each is either present or null/zeroed by its own producer.
 */

export interface PerfDomainOptions {
  supervisor: CoreSupervisor;
  bootClock: BootClock;
  logger: JsonlLogger;
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
}
