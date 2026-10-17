import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 20 supervisor additions: stderr consumption (every line reaches onStderrLine —
 * the OS pipe must drain or the core deadlocks on write) and the diagnostics-facing
 * lifecycle facts (restarts, lastExit, pid, ready uptime).
 */

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  kill(): boolean;
}

function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = pid;
  child.kill = () => true;
  return child;
}

const tmpDirs: string[] = [];
function fakeBinary(): string {
  // The supervisor refuses to spawn a non-existent binary (existsSync guard) — tests
  // therefore point it at a real (empty) file in a temp dir.
  const dir = mkdtempSync(join(tmpdir(), "syntaxdm-sup-"));
  tmpDirs.push(dir);
  const bin = join(dir, "download-core");
  writeFileSync(bin, "");
  return bin;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

function makeSupervisor(overrides: {
  onStderrLine?: (line: string) => void;
  verboseCoreLogging?: boolean;
  log?: (msg: string) => void;
}) {
  const spawned: FakeChild[] = [];
  const spawnFn = ((_bin: string, _args: unknown, _opts: unknown) => {
    const child = makeFakeChild(4000 + spawned.length);
    spawned.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const supervisor = new CoreSupervisor({
    binaryPath: fakeBinary(),
    dbPath: "/fake/db.sqlite",
    maxConcurrent: 3,
    spawnFn,
    ...overrides,
  });
  return { supervisor, spawned };
}

describe("CoreSupervisor — stderr wiring (Phase 20)", () => {
  it("delivers every complete stderr line to onStderrLine, across chunk boundaries", () => {
    const received: string[] = [];
    const { supervisor, spawned } = makeSupervisor({
      onStderrLine: (l) => received.push(l),
    });
    supervisor.start();
    const err = spawned[0]!.stderr;
    err.emit("data", '{"level":"INFO","message":"a"}\n{"lev');
    err.emit("data", 'el":"INFO","message":"b"}\ntrailing');
    expect(received).toEqual(['{"level":"INFO","message":"a"}', '{"level":"INFO","message":"b"}']);
  });

  it("flushes the trailing partial line when the child exits", () => {
    const received: string[] = [];
    const { supervisor, spawned } = makeSupervisor({
      onStderrLine: (l) => received.push(l),
    });
    supervisor.start();
    spawned[0]!.stderr.emit("data", "final words without newline");
    expect(received).toEqual([]);
    spawned[0]!.emit("exit", 0, null);
    expect(received).toEqual(["final words without newline"]);
  });

  it("falls back to the log sink when no onStderrLine is provided", () => {
    const logged: string[] = [];
    const { supervisor, spawned } = makeSupervisor({ log: (m) => logged.push(m) });
    supervisor.start();
    spawned[0]!.stderr.emit("data", "raw line\n");
    expect(logged.some((m) => m.includes("[core:stderr] raw line"))).toBe(true);
  });

  it("spawns the core with RUST_LOG=debug when verboseCoreLogging is set", () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const { supervisor } = makeSupervisor({ verboseCoreLogging: true });
    // Re-spawn capture: intercept via the fake child's spawn opts is done inside
    // makeSupervisor's spawnFn — capture here by wrapping process spawn is unnecessary;
    // instead assert through a dedicated supervisor with an env-capturing spawnFn.
    const spawnFn = ((_bin: string, _args: unknown, opts: { env: Record<string, string | undefined> }) => {
      capturedEnv = opts.env;
      return makeFakeChild(1);
    }) as unknown as typeof import("node:child_process").spawn;
    const verbose = new CoreSupervisor({
      binaryPath: fakeBinary(),
      dbPath: "/fake/db.sqlite",
      maxConcurrent: 3,
      verboseCoreLogging: true,
      spawnFn,
    });
    verbose.start();
    expect(capturedEnv?.RUST_LOG).toBe("debug");
    void supervisor;

    let capturedEnv2: Record<string, string | undefined> | undefined;
    const spawnFn2 = ((_bin: string, _args: unknown, opts: { env: Record<string, string | undefined> }) => {
      capturedEnv2 = opts.env;
      return makeFakeChild(2);
    }) as unknown as typeof import("node:child_process").spawn;
    const quiet = new CoreSupervisor({
      binaryPath: fakeBinary(),
      dbPath: "/fake/db.sqlite",
      maxConcurrent: 3,
      spawnFn: spawnFn2,
    });
    quiet.start();
    expect(capturedEnv2?.RUST_LOG).toBeUndefined();
  });
});

describe("CoreSupervisor — lifecycle facts (Phase 20)", () => {
  it("counts restarts, records the last exit, and clears it on a graceful stop", async () => {
    const { supervisor, spawned } = makeSupervisor({});
    supervisor.start();
    expect(supervisor.restarts).toBe(0);
    expect(supervisor.pid).toBe(4000);
    expect(supervisor.lastExit).toBeNull();

    // First crash → restart scheduled, exit recorded.
    spawned[0]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.lastExit).toEqual({ code: 1, signal: null });
    expect(supervisor.restarts).toBe(1);
    expect(supervisor.consecutiveFailures).toBe(1);

    // Second child proves ready → uptime becomes measurable. (The client validates event
    // payloads against the contract, so the ready event carries the real shape.)
    await vi.advanceTimersByTimeAsync(500); // backoff delay before relaunch
    expect(spawned.length).toBe(2);
    spawned[1]!.stdout.emit(
      "data",
      JSON.stringify({
        v: 1,
        id: "e",
        event: "core.ready",
        payload: { contractVersion: "1.14.0", protocolVersion: 1 },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(supervisor.currentState).toBe("ready");
    expect(supervisor.readyUptimeMs).not.toBeNull();

    // Graceful stop: exit info cleared, restart counter NOT incremented. The stop flow's
    // internal timers (shutdown request window, kill escalation) run on fake timers —
    // advance them so the stop continuation executes, then acknowledge the child exit.
    const stopPromise = supervisor.stop(5_000);
    await vi.advanceTimersByTimeAsync(2_600); // graceful shutdown window expires (child never answers)
    spawned[1]!.emit("exit", 0, null); // child acknowledges termination
    await stopPromise;
    expect(supervisor.lastExit).toBeNull();
    expect(supervisor.restarts).toBe(1);
    expect(supervisor.pid).toBeNull();
    expect(supervisor.readyUptimeMs).toBeNull();
  });
});
