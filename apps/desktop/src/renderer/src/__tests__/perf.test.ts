import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IpcRouter } from "../../../main/ipc/router.js";
import { makeRequest, newUlid, type DownloadJob } from "@syntaxdm/contracts";
import { compareQueueDisplay, useDownloadsStore } from "../stores/downloads.js";

/**
 * Phase 22 perf gate — the TS-side latency budgets from scripts/perf-budgets.json:
 *  - validated IPC dispatch throughput (the boundary every renderer↔main call crosses);
 *  - the downloads-store hot path (upsertJob / patchProgress over a realistic job list —
 *    the code that runs on every progress tick while a download is active);
 *  - the queue display ordering (compareQueueDisplay over a full library view).
 *
 * Every budget is a ceiling with headroom for CI noise (see the JSON notes); the tests
 * print observed values so the numbers in the phase report are real, not invented.
 * GUI wall-clock budgets cannot be enforced in this sandbox — they are documented
 * targets measured by the BootClock instrumentation on real Windows runs.
 */

const here = join(fileURLToPath(import.meta.url), "..");
// apps/desktop/src/renderer/src/__tests__ → repo root is six levels up.
const budgetsPath = resolve(here, "..", "..", "..", "..", "..", "..", "scripts", "perf-budgets.json");
const budgets = JSON.parse(readFileSync(budgetsPath, "utf8")) as {
  ts: { ipcDispatch2000Ms: { budget: number }; uiStoreHotPathMs: { budget: number }; uiQueueSortMs: { budget: number } };
};

function jobFixture(i: number): DownloadJob {
  return {
    id: `01PERFTEST000000000000000${String(i % 10).padStart(2, "0")}${String(i).padStart(3, "0")}`,
    url: `https://example.com/file-${i}.zip`,
    destinationDir: "/tmp",
    destinationPath: null,
    status: i % 3 === 0 ? "downloading" : i % 3 === 1 ? "queued" : "completed",
    totalBytes: 100_000_000,
    receivedBytes: i * 1000,
    etag: null,
    lastModified: null,
    contentType: null,
    speedBps: 1_048_576,
    etaSeconds: 42,
    errorCode: null,
    segmentCount: null,
    checksumActual: null,
    checksumVerified: null,
    recoveryCount: null,
    reboundAt: null,
    queuePosition: null,
    proxyProfileId: null,
    createdAt: 1700000000000 + i,
    updatedAt: 1700000000000 + i,
  } as DownloadJob;
}

describe("Phase 22 perf gate — IPC dispatch throughput", () => {
  it(
    `2000 fully validated dispatch round-trips complete under ${budgets.ts.ipcDispatch2000Ms.budget} ms`,
    async () => {
      const router = new IpcRouter();
      router.handle("perf.echo", {
        paramsSchema: z.object({ n: z.number(), pad: z.string() }),
        resultSchema: z.object({ n: z.number(), pad: z.string() }),
        handler: async (p) => p,
      });
      const requests = Array.from({ length: 2000 }, (_, i) =>
        makeRequest(newUlid(), "perf.echo", { n: i, pad: "x".repeat(64) }),
      );
      const sink = { send: () => undefined };
      const t0 = performance.now();
      for (const req of requests) {
        await router.dispatch(req, {}, sink);
      }
      const elapsed = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[perf] ipc dispatch: 2000 validated round-trips in ${elapsed.toFixed(1)} ms ` +
          `(${(elapsed / 2).toFixed(3)} µs/op budget ceiling ${budgets.ts.ipcDispatch2000Ms.budget / 2} ms/op)`,
      );
      expect(elapsed).toBeLessThan(budgets.ts.ipcDispatch2000Ms.budget);
      expect(router.counters().requestsServed).toBe(2000);
    },
  );
});

describe("Phase 22 perf gate — downloads store hot path", () => {
  it(
    `2000 upserts + 2000 progress patches over a 200-job list complete under ${budgets.ts.uiStoreHotPathMs.budget} ms`,
    () => {
      const jobs = Array.from({ length: 200 }, (_, i) => jobFixture(i));
      const jobIds = jobs.map((j) => j.id);
      useDownloadsStore.setState({ jobs, loaded: true });
      const store = useDownloadsStore.getState();

      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) {
        store.upsertJob(jobFixture(i % 200));
      }
      for (let i = 0; i < 2000; i++) {
        store.patchProgress({
          jobId: jobIds[i % 200]!,
          receivedBytes: i,
          totalBytes: 100_000_000,
          speedBps: 2_000_000,
          etaSeconds: 10,
        });
      }
      const elapsed = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[perf] store hot path: 2000 upserts + 2000 patches (200 jobs) in ${elapsed.toFixed(1)} ms ` +
          `(budget ${budgets.ts.uiStoreHotPathMs.budget} ms)`,
      );
      expect(elapsed).toBeLessThan(budgets.ts.uiStoreHotPathMs.budget);
      const finalJobs = useDownloadsStore.getState().jobs;
      expect(finalJobs).toHaveLength(200);
      expect(finalJobs[0]?.receivedBytes).toBeTypeOf("number");
      useDownloadsStore.setState({ jobs: [] });
    },
  );
});

describe("Phase 22 perf gate — queue display ordering", () => {
  it(
    `100 sorts of a 500-job list complete under ${budgets.ts.uiQueueSortMs.budget} ms`,
    () => {
      const jobs = Array.from({ length: 500 }, (_, i) => jobFixture(i));
      const t0 = performance.now();
      let checksum = 0;
      for (let i = 0; i < 100; i++) {
        checksum += [...jobs].sort(compareQueueDisplay).length;
      }
      const elapsed = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[perf] queue sort: 100 × 500-job sorts in ${elapsed.toFixed(1)} ms ` +
          `(budget ${budgets.ts.uiQueueSortMs.budget} ms)`,
      );
      expect(checksum).toBe(50_000);
      expect(elapsed).toBeLessThan(budgets.ts.uiQueueSortMs.budget);
    },
  );
});
