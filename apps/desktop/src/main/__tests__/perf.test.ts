import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BootClock } from "../perf/boot-clock.js";
import { IpcRouter } from "../ipc/router.js";
import { CoreSupervisor } from "../core/core-supervisor.js";
import { makeRequest, newUlid } from "@syntaxdm/contracts";

/**
 * Phase 22 — boot clock, router counters, and core-RSS sampling.
 * The enforced latency budgets live in scripts/perf-budgets.json and the perf gate
 * (renderer __tests__/perf.test.ts + core tests/perf.rs + scripts/check-budgets.mjs);
 * this file pins the INSTRUMENTATION those budgets are read from.
 */

describe("BootClock (Phase 22)", () => {
  /** Clock stepping through `ticks`; the constructor consumes tick 0 as its epoch. */
  function clockWithTicks(...ticks: number[]): BootClock {
    let i = 0;
    return new BootClock(() => {
      const v = ticks[Math.min(i, ticks.length - 1)] ?? 0;
      i += 1;
      return v;
    });
  }

  it("computes per-phase durations and core totals from marks", () => {
    // Epoch 0, modules 10, app-ready 100, window 106, spawn 108, ready 149; report reads 200.
    const clock = clockWithTicks(0, 10, 100, 106, 108, 149, 200);
    clock.mark("main-modules-evaluated");
    clock.mark("app-ready");
    clock.mark("window-created");
    clock.mark("core-spawned");
    clock.mark("core-ready");
    const report = clock.report();
    expect(report.phases.map((p) => p.phase)).toEqual([
      "main-modules-evaluated",
      "app-ready",
      "window-created",
      "core-spawned",
      "core-ready",
    ]);
    expect(report.phases.map((p) => p.durationMs)).toEqual([10, 90, 6, 2, 41]);
    expect(report.totalToCoreReadyMs).toBe(149);
    expect(report.coreSpawnToReadyMs).toBe(41);
  });

  it("leaves unmarked phases absent and core totals null before ready", () => {
    const clock = clockWithTicks(0, 10, 100, 110);
    clock.mark("main-modules-evaluated");
    clock.mark("app-ready");
    const report = clock.report();
    expect(report.phases.map((p) => p.phase)).toEqual(["main-modules-evaluated", "app-ready"]);
    expect(report.totalToCoreReadyMs).toBeNull();
    expect(report.coreSpawnToReadyMs).toBeNull();
    expect(clock.coreReadyMarked).toBe(false);
  });

  it("rejects unknown and duplicate marks", () => {
    const clock = clockWithTicks(0, 1);
    // @ts-expect-error — unknown phase at runtime must throw, not silently record.
    expect(() => clock.mark("first-paint")).toThrow(/unknown boot phase/);
    clock.mark("app-ready");
    expect(() => clock.mark("app-ready")).toThrow(/marked twice/);
  });

  it("clamps negative durations to 0 (defensive against clock skew)", () => {
    let fake = 50;
    const clock = new BootClock(() => fake);
    fake = 10; // mark time "before" the epoch (skewed clock)
    clock.mark("app-ready");
    const report = clock.report();
    expect(report.phases[0]?.durationMs).toBe(0);
  });
});

describe("IpcRouter counters (Phase 22)", () => {
  it("counts dispatched requests including error outcomes, and emitted events", async () => {
    const router = new IpcRouter();
    router.handle("ping.empty", { handler: async () => ({ pong: true }) });
    expect(router.counters()).toEqual({ requestsServed: 0, eventsEmitted: 0, invalidDropped: 0 });

    await router.handleRequest(makeRequest(newUlid(), "ping.empty", {}), {});
    await router.handleRequest(makeRequest(newUlid(), "nope.nope", {}), {}); // method_not_found still counts
    await router.handleRequest(makeRequest(newUlid(), "ping.empty", { bad: 1 }), {}); // invalid_params still counts
    expect(router.counters().requestsServed).toBe(3);

    // Schema-less emit (caller had no registered schema) still counts as emitted.
    router.emit("some.event", undefined, { anything: true });
    const events = router.counters().eventsEmitted;
    expect(events).toBe(1);

    // Malformed envelopes drop before dispatch and increment invalidDropped.
    await router.dispatch({ nope: true }, {}, { send: () => undefined });
    expect(router.counters().invalidDropped).toBe(1);
    expect(router.counters().requestsServed).toBe(3);
  });

  it("counts dropped events (invalid payload) without emitting", () => {
    const router = new IpcRouter();
    const seen: unknown[] = [];
    router.onEvent((_name, payload) => seen.push(payload));
    const badSchema = z.object({ must: z.string() });
    router.emit("some.event", badSchema, { must: 42 });
    expect(seen).toHaveLength(0);
    const c = router.counters();
    expect(c.eventsEmitted).toBe(0);
    expect(c.invalidDropped).toBe(1);
  });

  it("counters() returns a copy — callers cannot mutate the originals", () => {
    const router = new IpcRouter();
    const c = router.counters();
    c.requestsServed = 999;
    expect(router.counters().requestsServed).toBe(0);
  });
});

describe("CoreSupervisor.sampleCoreRssBytes (Phase 22)", () => {
  const tmpDirs: string[] = [];
  function fakeBinary(): string {
    const dir = mkdtempSync(join(tmpdir(), "syntaxdm-rss-"));
    tmpDirs.push(dir);
    const bin = join(dir, "download-core");
    writeFileSync(bin, "");
    return bin;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSupervisorWithPid(pid: number): CoreSupervisor {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: number;
      kill(): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = pid;
    child.kill = () => true;
    const spawnFn = (() => child) as unknown as typeof import("node:child_process").spawn;
    return new CoreSupervisor({
      binaryPath: fakeBinary(),
      dbPath: "/fake/db.sqlite",
      maxConcurrent: 3,
      spawnFn,
    });
  }

  it("returns null when no child is running", async () => {
    const supervisor = new CoreSupervisor({
      binaryPath: fakeBinary(),
      dbPath: "/fake/db.sqlite",
      maxConcurrent: 3,
    });
    await expect(supervisor.sampleCoreRssBytes()).resolves.toBeNull();
  });

  it("samples a real process RSS on Linux (self pid) and never throws off-Linux", async () => {
    // The fake child carries THIS process's pid — /proc/self/status is real on Linux,
    // so the test exercises the true reading path. Off-Linux the contract is null.
    const supervisor = makeSupervisorWithPid(process.pid);
    supervisor.start();
    const rss = await supervisor.sampleCoreRssBytes();
    if (process.platform === "linux") {
      expect(rss).toBeGreaterThan(0);
    } else {
      expect(rss).toBeNull();
    }
  });

  it("returns null for a dead/absent pid instead of throwing", async () => {
    const supervisor = makeSupervisorWithPid(3_999_999);
    supervisor.start();
    await expect(supervisor.sampleCoreRssBytes()).resolves.toBeNull();
  });
});

describe("perf-budgets.json integrity (Phase 22)", () => {
  /** Walk upward from cwd until scripts/perf-budgets.json is found (CJS-safe; same
   *  strategy as the Phase 19 package-layout drift guard). */
  function repoRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "scripts", "perf-budgets.json"))) return dir;
      dir = dirname(dir);
    }
    throw new Error(`perf-budgets.json not found upward from ${process.cwd()}`);
  }

  it("parses, carries measured baselines, and budgets never sit below reality", () => {
    const budgets = JSON.parse(readFileSync(join(repoRoot(), "scripts", "perf-budgets.json"), "utf8"));
    for (const section of ["core", "renderer"]) {
      for (const [name, entry] of Object.entries(
        budgets[section] as Record<string, { budget: number; measured: number }>,
      )) {
        expect(entry.budget, `${section}.${name} budget`).toBeGreaterThan(0);
        expect(entry.measured, `${section}.${name} measured`).toBeGreaterThanOrEqual(0);
        // A budget below its measured baseline would fail every gate run.
        expect(entry.budget, `${section}.${name} budget>=measured`).toBeGreaterThanOrEqual(
          entry.measured,
        );
      }
    }
    for (const key of ["ipcDispatch2000Ms", "uiStoreHotPathMs", "uiQueueSortMs"]) {
      expect(budgets.ts[key].budget).toBeGreaterThan(0);
    }
  });
});
