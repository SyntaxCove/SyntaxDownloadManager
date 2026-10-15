import { beforeEach, describe, expect, it } from "vitest";
import {
  useSchedulerStore,
  subscribeSchedulerEvents,
  localInputToEpochMs,
  epochMsToLocalInput,
} from "../stores/scheduler.js";
import type { SchedulerJob } from "@syntaxdm/contracts";

/**
 * Phase 15 — scheduler store against a stubbed preload bridge: the create lifecycle
 * (local-time conversion + server-authoritative snapshot), the update/enable flow,
 * runNow, remove, and the authoritative `scheduler.updated` event model.
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];
let coreError: { code: string; message: string } | null = null;

const jobFixture = (patch: Partial<SchedulerJob> = {}): SchedulerJob => ({
  id: "01K4SCHE0000000000000000AA",
  kind: "download.create",
  payload: { url: "https://example.com/setup.exe", destinationDir: "/home/user/Downloads" },
  startAt: 1735689600000,
  repeat: "daily",
  enabled: true,
  nextRunAt: 1735776000000,
  lastFiredAt: null,
  lastResultCode: null,
  lastResultMessage: null,
  createdAt: 1735603200000,
  updatedAt: 1735603200000,
  ...patch,
});

let eventSink: ((payload: unknown) => void) | null = null;

function rpcResult(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "scheduler.list":
      return { jobs: useSchedulerStore.getState().jobs };
    case "scheduler.create":
      // The renderer bridge re-validates results — the row must be a schema-valid fixture.
      return { job: jobFixture({ id: "01K4SCHE0000000000000000AB", startAt: Number(p.startAt) }) };
    case "scheduler.update":
      return {
        job: jobFixture({
          id: String(p.id),
          enabled: Boolean((p.patch as { enabled?: boolean }).enabled),
        }),
      };
    case "scheduler.runNow":
      return {
        job: jobFixture({
          id: String(p.id),
          lastFiredAt: 1735689600000,
          lastResultCode: "ok",
          lastResultMessage: "started 0 paused job(s)",
        }),
      };
    case "scheduler.remove":
      useSchedulerStore.setState({
        jobs: useSchedulerStore.getState().jobs.filter((j) => j.id !== String(p.id)),
      });
      return { removed: true };
    default:
      return {};
  }
}

beforeEach(() => {
  calls.length = 0;
  coreError = null;
  eventSink = null;
  useSchedulerStore.setState({ jobs: [], jobsLoaded: false, error: null });
  (globalThis as Record<string, unknown>).window = {
    syntaxdm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (coreError) return Promise.reject(coreError);
        return Promise.resolve(rpcResult(method, params));
      },
      onEvent: (_name: string, cb: (payload: unknown) => void) => {
        eventSink = cb;
        return () => undefined;
      },
      emit: () => undefined,
    },
  };
});

describe("scheduler store (Phase 15)", () => {
  it("loadJobs pulls the authoritative list once", async () => {
    const store = useSchedulerStore.getState();
    useSchedulerStore.setState({ jobs: [jobFixture()] });
    await store.loadJobs();
    expect(useSchedulerStore.getState().jobsLoaded).toBe(true);
    expect(calls[0]?.method).toBe("scheduler.list");
  });

  it("createJob converts the local input to epoch and upserts the snapshot", async () => {
    const store = useSchedulerStore.getState();
    const ok = await store.createJob({
      kind: "download.startAll",
      payload: {},
      startLocal: "2025-01-01T09:00",
      repeat: "daily",
      enabled: true,
    });
    expect(ok).toBe(true);
    expect(calls[0]?.method).toBe("scheduler.create");
    const sent = calls[0]?.params as { startAt: number; repeat: string };
    // 2025-01-01T09:00 local — the epoch must reflect the runtime's timezone.
    expect(sent.startAt).toBe(new Date("2025-01-01T09:00").getTime());
    expect(sent.repeat).toBe("daily");
    const jobs = useSchedulerStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe("01K4SCHE0000000000000000AB");
    expect(useSchedulerStore.getState().error).toBeNull();
  });

  it("createJob refuses an unusable start time without touching the core", async () => {
    const store = useSchedulerStore.getState();
    const ok = await store.createJob({
      kind: "download.startAll",
      payload: {},
      startLocal: "",
      repeat: "none",
      enabled: true,
    });
    expect(ok).toBe(false);
    expect(useSchedulerStore.getState().error).toContain("start");
    expect(calls).toHaveLength(0);
  });

  it("runNow records the outcome snapshot on the row", async () => {
    useSchedulerStore.setState({ jobs: [jobFixture()] });
    await useSchedulerStore.getState().runNow("01K4SCHE0000000000000000AA");
    expect(calls[0]?.method).toBe("scheduler.runNow");
    const row = useSchedulerStore.getState().jobs[0];
    expect(row?.lastResultCode).toBe("ok");
    expect(row?.lastFiredAt).toBe(1735689600000);
  });

  it("removeJob drops the row locally after the core confirms", async () => {
    useSchedulerStore.setState({ jobs: [jobFixture()] });
    await useSchedulerStore.getState().removeJob("01K4SCHE0000000000000000AA");
    expect(useSchedulerStore.getState().jobs).toHaveLength(0);
  });

  it("core failures land in the store error banner", async () => {
    coreError = { code: "invalid_state", message: "scheduler job is already firing" };
    await useSchedulerStore.getState().runNow("01K4SCHE0000000000000000AA");
    expect(useSchedulerStore.getState().error).toContain("already firing");
  });

  it("scheduler.updated events are authoritative upserts (create + fire outcome)", () => {
    const off = subscribeSchedulerEvents();
    expect(eventSink).toBeTypeOf("function");

    // New row arrives via event.
    eventSink?.({ job: jobFixture() });
    expect(useSchedulerStore.getState().jobs).toHaveLength(1);

    // Fired outcome replaces the row in place.
    eventSink?.({
      job: jobFixture({
        lastFiredAt: 1735689600000,
        lastResultCode: "network_error",
        lastResultMessage: "connection refused",
        enabled: false,
        nextRunAt: null,
      }),
    });
    const rows = useSchedulerStore.getState().jobs;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastResultCode).toBe("network_error");
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.nextRunAt).toBeNull();
    off();
  });

  it("local/epoch conversions round-trip through the runtime timezone", () => {
    const epoch = 1767225600000; // 2026-01-01T00:00Z
    const local = epochMsToLocalInput(epoch);
    expect(localInputToEpochMs(local)).toBe(epoch);
    expect(localInputToEpochMs("not-a-date")).toBeNull();
    expect(localInputToEpochMs("")).toBeNull();
  });
});
