import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeRequest, newUlid } from "@syntaxdm/contracts";
import { IpcRouter } from "../../../main/ipc/router.js";
import { registerPerfDomain } from "../../../main/domains/perf.js";
import { benchIpcDispatch, benchQueueSort, benchStoreHotPath } from "../perf/benches.js";
import { budgetReportToMarkdown } from "../perf/report-markdown.js";
import { useDownloadsStore } from "../stores/downloads.js";

/**
 * Phase 29 — the renderer-side benches and the Markdown renderer. The benches run here
 * against a REAL IpcRouter (registered exactly like production) and the REAL store
 * creator, with a small iteration count so the suite stays fast; the DEVICE run uses the
 * full 2,000/2,000/100 shapes through the real bridge. The one thing these tests also
 * pin: benching never mutates the live singleton's visible job list.
 */

function routerWithPerfDomain() {
  const router = new IpcRouter();
  registerPerfDomain(router, {
    supervisor: {
      isReady: false,
      request: (async () => ({ pong: true })) as never,
      sampleCoreRssBytes: async () => null,
    } as never,
    bootClock: {
      report: () => ({ phases: [], totalToCoreReadyMs: null, coreSpawnToReadyMs: null, recordedAt: 0 }),
    } as never,
    logger: { info: () => undefined } as never,
    report: {
      budgetsFile: "/definitely/not/here/perf-budgets.json",
      bootClock: { report: () => ({ phases: [], totalToCoreReadyMs: null, coreSpawnToReadyMs: null, recordedAt: 0 }) },
      supervisor: { isReady: false, request: (async () => ({})) as never, sampleCoreRssBytes: async () => null },
      appVersion: "test",
      platform: "linux",
      osRelease: "test",
      source: "headless-test",
      rendererAssetsDir: "/definitely/not/here/assets",
      logger: { info: () => undefined } as never,
    },
  });
  const rpc = async (method: string, params?: unknown): Promise<unknown> => {
    const response = (await router.handleRequest(makeRequest(newUlid(), method, params ?? {}), {})) as {
      ok: boolean;
      result?: unknown;
    };
    if (!response.ok) throw new Error("rpc failed");
    return response.result;
  };
  return rpc;
}

describe("benchIpcDispatch (Phase 29)", () => {
  it("times validated perf.probe round-trips through the real router", async () => {
    const rpc = routerWithPerfDomain();
    const ms = await benchIpcDispatch(rpc, 200);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("throws when the probe returns an unexpected shape", async () => {
    const broken = (async () => ({ pong: "yes" })) as never;
    await expect(benchIpcDispatch(broken, 3)).rejects.toThrow(/unexpected shape|pong/);
  });
});

describe("benchStoreHotPath (Phase 29)", () => {
  it("measures the hot path on a throwaway store and never touches the live singleton", () => {
    // Sentinel in the LIVE store: a buggy bench that used the singleton would erase it.
    useDownloadsStore.setState({ jobs: [], loaded: true });
    useDownloadsStore.getState().upsertJob({
      id: "01LIVESENTINEL00000000000000A",
      url: "https://example.com/live.bin",
      destinationDir: "/x",
      destinationPath: null,
      status: "downloading",
      totalBytes: 1,
      receivedBytes: 0,
      etag: null,
      lastModified: null,
      contentType: null,
      speedBps: 0,
      etaSeconds: null,
      errorCode: null,
      segmentCount: null,
      checksumActual: null,
      checksumVerified: null,
      recoveryCount: null,
      reboundAt: null,
      queuePosition: null,
      proxyProfileId: null,
      createdAt: 1,
      updatedAt: 1,
    } as never);

    const ms = benchStoreHotPath(200);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ms)).toBe(true);

    // The live store still carries EXACTLY the sentinel job and nothing else.
    const jobs = useDownloadsStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("01LIVESENTINEL00000000000000A");
    useDownloadsStore.setState({ jobs: [] });
  });
});

describe("benchQueueSort (Phase 29)", () => {
  it("sorts a synthetic list with the shipped comparator", () => {
    const ms = benchQueueSort(10);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ms)).toBe(true);
  });
});

describe("budgetReportToMarkdown (Phase 29)", () => {
  it("renders a deterministic table from a contract-typed report", () => {
    // The fixture from the cross-language domain fixture (same bytes cargo reads).
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = resolve(here, "..", "..", "..", "..", "..", "..", "packages", "contracts", "fixtures", "domain.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      budgetReport: Parameters<typeof budgetReportToMarkdown>[0];
    };
    const md = budgetReportToMarkdown(fixture.budgetReport);
    expect(md).toContain("# Performance budget report");
    expect(md).toContain("| core.coldStartReadyMs | 38 ms | 2000 ms | pass |");
    expect(md).toContain("| core.echoAvgUs | 2500 us | 2000 us | breach |");
    expect(md).toContain("| ts.uiQueueSortMs | — | 500 ms | skipped |");
    expect(md).toContain("7 passed, 1 breached, 1 skipped");
    expect(md).toBe(budgetReportToMarkdown(fixture.budgetReport)); // deterministic
  });
});
