import { beforeEach, describe, expect, it } from "vitest";
import type { UpdateState } from "@unidm/contracts";
import { useUpdateStore, subscribeUpdateState } from "../stores/updates.js";

/**
 * Phase 18 — the update store against a stubbed preload bridge: load, the three consent
 * points (check / download / install) each followed by a snapshot refresh, and the
 * `update.state` event mirror. Every lifecycle decision lives main-side; the store is a
 * dumb mirror and must stay one.
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];
let eventSink: ((payload: unknown) => void) | null = null;

const stateFixture = (patch: Partial<UpdateState> = {}): UpdateState => ({
  status: "idle",
  unavailableReason: null,
  currentVersion: "0.5.0",
  availableVersion: null,
  releaseDate: null,
  releaseNotes: null,
  progress: null,
  errorCode: null,
  message: null,
  lastCheckedAt: null,
  ...patch,
});

let respondWith: UpdateState = stateFixture();

beforeEach(() => {
  calls.length = 0;
  eventSink = null;
  respondWith = stateFixture();
  useUpdateStore.setState({ state: null, loaded: false });
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve(method === "update.getState" ? { state: respondWith } : { started: true, accepted: true });
      },
      onEvent: (_name: string, cb: (payload: unknown) => void) => {
        eventSink = cb;
        return () => undefined;
      },
    },
  };
});

describe("update store (Phase 18)", () => {
  it("load pulls the authoritative snapshot once", async () => {
    respondWith = stateFixture({ status: "unavailable", unavailableReason: "not_packaged" });
    await useUpdateStore.getState().load();
    expect(calls[0]?.method).toBe("update.getState");
    expect(useUpdateStore.getState().state?.status).toBe("unavailable");
    expect(useUpdateStore.getState().loaded).toBe(true);
  });

  it("check issues the consent point and refreshes the snapshot", async () => {
    respondWith = stateFixture({ status: "checking" });
    await useUpdateStore.getState().check();
    expect(calls.map((c) => c.method)).toEqual(["update.check", "update.getState"]);
    expect(useUpdateStore.getState().state?.status).toBe("checking");
  });

  it("download and install follow the same consent+refresh shape", async () => {
    respondWith = stateFixture({ status: "downloaded" });
    await useUpdateStore.getState().download();
    await useUpdateStore.getState().install();
    expect(calls.map((c) => c.method)).toEqual(["update.download", "update.getState", "update.install", "update.getState"]);
    expect(useUpdateStore.getState().state?.status).toBe("downloaded");
  });

  it("update.state events mirror the full snapshot without polling", () => {
    subscribeUpdateState();
    expect(eventSink).not.toBeNull();
    eventSink?.(stateFixture({ status: "available", availableVersion: "0.6.0" }));
    expect(useUpdateStore.getState().state?.availableVersion).toBe("0.6.0");
    expect(useUpdateStore.getState().loaded).toBe(true);
  });
});
