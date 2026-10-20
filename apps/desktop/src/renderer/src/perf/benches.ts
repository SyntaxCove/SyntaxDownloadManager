import { createStore, type StoreApi } from "zustand/vanilla";
import type { z } from "zod";
import type { DownloadJob } from "@syntaxdm/contracts";
import { PerfProbeParams, PerfProbeResult } from "@syntaxdm/contracts";
import { createDownloadsState, compareQueueDisplay, type DownloadsState } from "../stores/downloads.js";

/**
 * Phase 29 — the renderer side of the real-device budget report.
 *
 * Three benches, one rule: measure EXACTLY the code the vitest perf gates measure, but in
 * the real running renderer — real bridge, real process boundary, real Chromium — and
 * never mutate live user state:
 *  - benchIpcDispatch hammers `perf.probe` through the REAL preload bridge 2,000 times
 *    (the vitest gate measures the router in-process; this adds the serialization and
 *    context-switch cost only a device can see);
 *  - benchStoreHotPath builds a THROWAWAY vanilla store from the same exported state
 *    creator the app singleton uses, then runs the identical 2,000 upserts + 2,000
 *    patches — the user's visible job list is untouched;
 *  - benchQueueSort sorts copies of a synthetic 500-job list with the pure comparator.
 *
 * Everything returns wall-clock ms from `performance.now()`; the caller hands the numbers
 * to `perf.runReport` where the budgets file turns them into verdicts.
 */

const PROBE_ITERATIONS = 2_000;
const STORE_JOB_COUNT = 200;
const STORE_OPS = 2_000;
const SORT_ROUNDS = 100;
const SORT_JOB_COUNT = 500;

/** A minimal DownloadJob row factory — the bench only needs shape fidelity, and importing
 *  the test fixtures into the renderer bundle would be self-defeating for a perf harness. */
function benchJob(i: number): DownloadJob {
  const statusCycle = i % 3;
  return {
    id: `01BENCH0000000000000000${String(i).padStart(4, "0")}`,
    url: `https://example.com/bench-${i}.bin`,
    destinationDir: "C:\\Users\\bench\\Downloads",
    destinationPath: null,
    status: statusCycle === 0 ? "downloading" : statusCycle === 1 ? "queued" : "completed",
    totalBytes: 100_000_000,
    receivedBytes: i * 1_000,
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
    queuePosition: statusCycle === 1 ? i : null,
    proxyProfileId: null,
    createdAt: 1_700_000_000_000 + i,
    updatedAt: 1_700_000_000_000 + i,
  } as DownloadJob;
}

/**
 * 2,000 sequential validated `perf.probe` round-trips through the real bridge. Sequential
 * on purpose: the vitest gate is sequential too, and pipelining would measure the bridge's
 * queueing behavior instead of the boundary cost the budget describes.
 */
export async function benchIpcDispatch(
  rpc: (method: "perf.probe", params: z.infer<typeof PerfProbeParams>) => Promise<unknown>,
  iterations: number = PROBE_ITERATIONS,
): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const result = PerfProbeResult.parse(await rpc("perf.probe", {}));
    if (result.pong !== true) throw new Error("perf.probe returned an unexpected shape");
  }
  return performance.now() - t0;
}

/** 2,000 upserts + 2,000 progress patches over a 200-job THROWAWAY store. */
export function benchStoreHotPath(iterations: number = STORE_OPS): number {
  const benchStore: StoreApi<DownloadsState> = createStore<DownloadsState>()(createDownloadsState);
  const jobs = Array.from({ length: STORE_JOB_COUNT }, (_, i) => benchJob(i));
  const jobIds = jobs.map((j) => j.id);
  benchStore.setState({ jobs, loaded: true });
  const store = benchStore.getState();

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    store.upsertJob(benchJob(i % STORE_JOB_COUNT));
  }
  for (let i = 0; i < iterations; i++) {
    store.patchProgress({
      jobId: jobIds[i % STORE_JOB_COUNT]!,
      receivedBytes: i,
      totalBytes: 100_000_000,
      speedBps: 2_000_000,
      etaSeconds: 10,
    });
  }
  const elapsed = performance.now() - t0;
  // The throwaway store must behave exactly like the real one at the end of the same ops.
  if (benchStore.getState().jobs.length !== STORE_JOB_COUNT) {
    throw new Error("bench store diverged from the expected job count");
  }
  return elapsed;
}

/** 100 sorts of a 500-job list with the shipped comparator (pure — no store involved). */
export function benchQueueSort(rounds: number = SORT_ROUNDS): number {
  const jobs = Array.from({ length: SORT_JOB_COUNT }, (_, i) => benchJob(i));
  const t0 = performance.now();
  let checksum = 0;
  for (let i = 0; i < rounds; i++) {
    checksum += [...jobs].sort(compareQueueDisplay).length;
  }
  const elapsed = performance.now() - t0;
  if (checksum !== rounds * SORT_JOB_COUNT) {
    throw new Error("bench sort checksum mismatch — comparator diverged");
  }
  return elapsed;
}
