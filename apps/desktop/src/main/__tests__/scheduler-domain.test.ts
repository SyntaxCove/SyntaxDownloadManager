import { describe, expect, it, vi } from "vitest";
import {
  METHODS,
  SchedulerCreateResult,
  ErrorEnvelope,
  SuccessEnvelope,
  makeRequest,
  newUlid,
  type SchedulerJob,
} from "@unidm/contracts";
import { registerSchedulerDomain } from "../domains/scheduler.js";
import { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 15 — scheduler domain: a validated forwarder to the Rust core. Params must reach
 * the core untouched, results must pass the contract schemas, and a payload that does not
 * match the row's action kind is rejected at the boundary before the core is touched.
 */

const schedulerJobFixture: SchedulerJob = {
  id: "01K4SCHE0000000000000000AA",
  kind: "download.create",
  payload: { url: "https://example.com/setup.exe", destinationDir: "/home/user/Downloads" },
  startAt: 1735689600000,
  repeat: "daily",
  enabled: true,
  nextRunAt: 1735776000000,
  lastFiredAt: 1735689600000,
  lastResultCode: "ok",
  lastResultMessage: "created download job 01JD8W3G5XQ9V4M2K7PZ6N8S0T",
  createdAt: 1735603200000,
  updatedAt: 1735689600000,
};

function makeRouterWithFakeCore(
  coreResponse: () => Promise<unknown>,
): { router: IpcRouter; supervisor: CoreSupervisor } {
  const router = new IpcRouter((msg) => console.log(msg));
  const supervisor = {
    request: vi.fn(coreResponse),
  } as unknown as CoreSupervisor;
  registerSchedulerDomain(router, supervisor);
  return { router, supervisor };
}

describe("scheduler domain (Phase 15)", () => {
  it("the five renderer-facing methods are core-served; setClock is not among them", () => {
    for (const m of [
      "scheduler.list",
      "scheduler.create",
      "scheduler.update",
      "scheduler.remove",
      "scheduler.runNow",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
    }
    // setClock is main → core only — never registered on the renderer-facing router.
    expect(METHODS["scheduler.setClock"].server).toBe("core");
  });

  it("forwards scheduler.create params untouched and validates the result", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      job: schedulerJobFixture,
    }));
    const params = {
      kind: "download.create",
      payload: { url: "https://example.com/setup.exe", destinationDir: "/home/user/Downloads" },
      startAt: 1735689600000,
      repeat: "daily",
    };
    const res = await router.handleRequest(
      makeRequest(newUlid(), "scheduler.create", params),
      {},
    );
    const ok = res as SuccessEnvelope;
    expect(ok.ok).toBe(true);
    expect(SchedulerCreateResult.parse(ok.result).job.kind).toBe("download.create");
    // The boundary applies the schema's `enabled` default before forwarding.
    expect(supervisor.request).toHaveBeenCalledWith(
      "scheduler.create",
      { ...params, enabled: true },
      30_000,
    );
  });

  it("rejects a payload that does not match the action kind before the core is touched", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      job: schedulerJobFixture,
    }));
    const res = await router.handleRequest(
      makeRequest(newUlid(), "scheduler.create", {
        kind: "download.create",
        payload: { url: "https://example.com/x" }, // destinationDir missing
        startAt: 1,
        repeat: "none",
      }),
      {},
    );
    const err = res as ErrorEnvelope;
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("invalid_params");
    expect(supervisor.request).not.toHaveBeenCalled();
  });

  it("forwards update / runNow / remove / list with their params", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      job: schedulerJobFixture,
    }));
    const id = schedulerJobFixture.id;

    await router.handleRequest(
      makeRequest(newUlid(), "scheduler.update", { id, patch: { enabled: false } }),
      {},
    );
    expect(supervisor.request).toHaveBeenCalledWith(
      "scheduler.update",
      { id, patch: { enabled: false } },
      30_000,
    );

    await router.handleRequest(makeRequest(newUlid(), "scheduler.runNow", { id }), {});
    expect(supervisor.request).toHaveBeenCalledWith("scheduler.runNow", { id }, 30_000);

    await router.handleRequest(makeRequest(newUlid(), "scheduler.remove", { id }), {});
    expect(supervisor.request).toHaveBeenCalledWith("scheduler.remove", { id }, 30_000);

    await router.handleRequest(makeRequest(newUlid(), "scheduler.list", {}), {});
    expect(supervisor.request).toHaveBeenCalledWith("scheduler.list", {}, 30_000);
  });

  it("surfaces core errors as typed envelopes", async () => {
    const { router } = makeRouterWithFakeCore(async () => {
      throw new (await import("@unidm/contracts")).UniDmError(
        "invalid_state",
        "scheduler job is already firing",
      );
    });
    const res = await router.handleRequest(
      makeRequest(newUlid(), "scheduler.runNow", { id: schedulerJobFixture.id }),
      {},
    );
    const err = res as ErrorEnvelope;
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("invalid_state");
    expect(err.error.message).toContain("already firing");
  });
});
