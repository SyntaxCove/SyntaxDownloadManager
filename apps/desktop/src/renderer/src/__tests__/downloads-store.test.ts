import { beforeEach, describe, expect, it } from "vitest";
import type { DownloadJob } from "@syntaxdm/contracts";
import { compareQueueDisplay, useDownloadsStore } from "../stores/downloads.js";

/**
 * Phase 8 — downloads store queue actions (queueMove / startAll / pauseAll /
 * setSpeedLimit) against a stubbed preload bridge, plus the display-order comparator.
 */

type RpcCall = { method: string; params: unknown };

const calls: RpcCall[] = [];

function jobFixture(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T",
    url: "https://example.com/file.zip",
    destinationDir: "/tmp",
    destinationPath: null,
    status: "queued",
    totalBytes: null,
    receivedBytes: 0,
    etag: null,
    lastModified: null,
    contentType: null,
    speedBps: null,
    etaSeconds: null,
    errorCode: null,
    segmentCount: null,
    checksumActual: null,
    checksumVerified: null,
    recoveryCount: null,
    reboundAt: null,
    queuePosition: null,
    proxyProfileId: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as DownloadJob;
}

function rpcResult(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "download.list":
      return { jobs: useDownloadsStore.getState().jobs };
    case "download.queueMove":
      return { job: jobFixture({ id: String(p.id), queuePosition: 0 }) };
    case "download.startAll":
      return { started: 2 };
    case "download.pauseAll":
      return { paused: 3 };
    case "download.setSpeedLimit":
      return { job: jobFixture({ id: String(p.id), speedLimitKBps: Number(p.kbps) }) };
    case "download.create":
      return {
        job: jobFixture({
          id: "01JD8W3G5XQ9V4M2K7PZ6N8S0V",
          url: String(p.url),
          ...(p.proxyProfileId !== undefined ? { proxyProfileId: p.proxyProfileId as string | null } : {}),
        }),
      };
    default:
      return {};
  }
}

beforeEach(() => {
  calls.length = 0;
  useDownloadsStore.setState({ jobs: [], loaded: true, core: "ready" });
  (globalThis as Record<string, unknown>).window = {
    syntaxdm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve(rpcResult(method, params));
      },
      onEvent: () => () => undefined,
      emit: () => undefined,
    },
  };
});

describe("downloads store — queue actions (Phase 8)", () => {
  it("queueMove proxies to the core with the given direction and upserts the job", async () => {
    const { queueMove } = useDownloadsStore.getState();
    await queueMove("01JD8W3G5XQ9V4M2K7PZ6N8S0T", "top");
    expect(calls).toEqual([
      { method: "download.queueMove", params: { id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T", direction: "top" } },
    ]);
    expect(useDownloadsStore.getState().jobs[0]?.queuePosition).toBe(0);
  });

  it("startAll proxies and refreshes the job list", async () => {
    const { startAll } = useDownloadsStore.getState();
    const started = await startAll();
    expect(started).toBe(2);
    expect(calls[0]).toEqual({ method: "download.startAll", params: {} });
    expect(calls[1]?.method).toBe("download.list");
  });

  it("pauseAll proxies and refreshes the job list", async () => {
    const { pauseAll } = useDownloadsStore.getState();
    const paused = await pauseAll();
    expect(paused).toBe(3);
    expect(calls[0]).toEqual({ method: "download.pauseAll", params: {} });
  });

  it("setSpeedLimit proxies the per-job cap and upserts", async () => {
    const { setSpeedLimit } = useDownloadsStore.getState();
    await setSpeedLimit("01JD8W3G5XQ9V4M2K7PZ6N8S0T", 512);
    expect(calls).toEqual([
      { method: "download.setSpeedLimit", params: { id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T", kbps: 512 } },
    ]);
    expect(useDownloadsStore.getState().jobs[0]?.speedLimitKBps).toBe(512);
  });
});

describe("compareQueueDisplay (Phase 8 display order)", () => {
  it("groups: active runs, then the queue in slot order, then the rest", () => {
    const late = jobFixture({ id: "late", queuePosition: 1, createdAt: 200 });
    const early = jobFixture({ id: "early", queuePosition: 1, createdAt: 100 });
    const first = jobFixture({ id: "first", queuePosition: 0 });
    const parked = jobFixture({ id: "parked", status: "paused", queuePosition: null });
    const active = jobFixture({ id: "active", status: "downloading", queuePosition: null });
    const ordered = [late, parked, first, active, early].sort(compareQueueDisplay);
    expect(ordered.map((j) => j.id)).toEqual(["active", "first", "early", "late", "parked"]);
  });

  it("keeps same-group jobs in their original (stable) order", () => {
    const a = jobFixture({ id: "a", status: "completed", queuePosition: null });
    const b = jobFixture({ id: "b", status: "paused", queuePosition: null });
    const ordered = [b, a].sort(compareQueueDisplay);
    expect(ordered.map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("returns 0 for equal keys (comparator stability)", () => {
    const a = jobFixture({ id: "a" });
    const b = jobFixture({ id: "b" });
    expect(compareQueueDisplay(a, b)).toBe(0);
    expect(compareQueueDisplay(a, a)).toBe(0);
  });
});

describe("downloads store — create proxy choice (Phase 16)", () => {
  it("no argument = app default: the field is OMITTED (main injects the setting)", async () => {
    const { create } = useDownloadsStore.getState();
    await create("https://example.com/a.bin", "/tmp");
    expect(calls[0]).toEqual({
      method: "download.create",
      params: { url: "https://example.com/a.bin", destinationDir: "/tmp", overwrite: false },
    });
  });

  it("null = explicit direct: proxyProfileId: null rides on the wire", async () => {
    const { create } = useDownloadsStore.getState();
    await create("https://example.com/b.bin", "/tmp", null);
    expect(calls[0]).toEqual({
      method: "download.create",
      params: {
        url: "https://example.com/b.bin",
        destinationDir: "/tmp",
        overwrite: false,
        proxyProfileId: null,
      },
    });
  });

  it("a profile id passes through verbatim", async () => {
    const { create } = useDownloadsStore.getState();
    await create("https://example.com/c.bin", "/tmp", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(calls[0]).toEqual({
      method: "download.create",
      params: {
        url: "https://example.com/c.bin",
        destinationDir: "/tmp",
        overwrite: false,
        proxyProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
    expect(useDownloadsStore.getState().jobs[0]?.proxyProfileId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });
});

// ---- Phase 25: stale-response guard (E2E-found) ----

describe("upsertJob stale-response guard", () => {
  beforeEach(() => {
    useDownloadsStore.setState({ jobs: [], loaded: false, core: "unknown" });
  });

  it("a newer event snapshot is never regressed by an older async RPC response", () => {
    // Engine-async pause: the "paused" event (updatedAt T2) can land before the pause
    // RPC resolves with the stale "downloading" row (updatedAt T1 < T2).
    const pausedEvent = jobFixture({ status: "paused", updatedAt: 1700000002000 });
    const staleResponse = jobFixture({ status: "downloading", updatedAt: 1700000001000 });

    useDownloadsStore.getState().upsertJob(pausedEvent);
    useDownloadsStore.getState().upsertJob(staleResponse);

    expect(useDownloadsStore.getState().jobs[0]?.status).toBe("paused");
  });

  it("a genuinely newer row still replaces the mirrored one", () => {
    useDownloadsStore.getState().upsertJob(jobFixture({ status: "downloading", updatedAt: 1000 }));
    useDownloadsStore.getState().upsertJob(jobFixture({ status: "completed", updatedAt: 2000 }));
    expect(useDownloadsStore.getState().jobs[0]?.status).toBe("completed");
  });

  it("equal updatedAt still applies (idempotent re-upsert of the same snapshot)", () => {
    useDownloadsStore.getState().upsertJob(jobFixture({ status: "paused", updatedAt: 1000 }));
    useDownloadsStore.getState().upsertJob(jobFixture({ status: "paused", updatedAt: 1000 }));
    expect(useDownloadsStore.getState().jobs).toHaveLength(1);
    expect(useDownloadsStore.getState().jobs[0]?.status).toBe("paused");
  });
});
