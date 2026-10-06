import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreClient } from "../core/core-client.js";
import { CoreSupervisor, resolveCoreBinaryPath } from "../core/core-supervisor.js";
import { makeSuccess, makeError, makeEvent } from "@unidm/contracts";

/**
 * The core is simulated at the *stream* level (a real duplex JSONL peer) — this exercises the
 * genuine framing, id-matching, timeout and event paths of CoreClient without needing the
 * Rust binary in a Node test process. The binary itself is covered by cargo's
 * spawned-binary test.
 */

function makePair() {
  // what the "core" writes → client reads; what the client writes → "core" reads
  const coreToClient = new PassThrough();
  const clientToCore = new PassThrough();
  const client = new CoreClient(coreToClient, clientToCore);
  const coreIn = clientToCore; // core reads requests here
  const coreOut = coreToClient; // core writes responses here
  return { client, coreIn, coreOut };
}

function readLines(stream: PassThrough, onLine: (json: string) => void) {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  });
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("CoreClient", () => {
  it("matches responses to request ids and resolves with the result", async () => {
    const { client, coreIn, coreOut } = makePair();
    readLines(coreIn, (line) => {
      const req = JSON.parse(line);
      coreOut.write(JSON.stringify(makeSuccess(req.id, { pong: true })) + "\n");
    });
    const result = await client.request<{ pong: boolean }>("core.ping");
    expect(result.pong).toBe(true);
    client.removeAllListeners();
  });

  it("rejects with a UniDmError carrying the contract code", async () => {
    const { client, coreIn, coreOut } = makePair();
    readLines(coreIn, (line) => {
      const req = JSON.parse(line);
      coreOut.write(
        JSON.stringify(makeError(req.id, { code: "invalid_state", message: "bad state" })) + "\n",
      );
    });
    await expect(client.request("download.pause", { id: "x" })).rejects.toMatchObject({
      code: "invalid_state",
      message: "bad state",
    });
    client.removeAllListeners();
  });

  it("times out requests that never get a response", async () => {
    const { client } = makePair();
    const promise = client.request("download.list", {}, 500);
    const expectation = expect(promise).rejects;
    await vi.advanceTimersByTimeAsync(600);
    await expectation.toMatchObject({ code: "timeout" });
    client.removeAllListeners();
  });

  it("dispatches events with validated payloads and drops invalid ones", async () => {
    const { client, coreOut } = makePair();
    const seen: Array<[string, unknown]> = [];
    client.on("event", (name, payload) => seen.push([name, payload]));

    coreOut.write(
      JSON.stringify(
        makeEvent("download.progress", {
          jobId: "01JD8W3G5XQ9V4M2K7PZ6N8S0T",
          receivedBytes: 10,
          totalBytes: 20,
          speedBps: 5,
          etaSeconds: 2,
        }),
      ) + "\n",
    );
    // invalid: receivedBytes negative → dropped
    coreOut.write(
      JSON.stringify(
        makeEvent("download.progress", {
          jobId: "01JD8W3G5XQ9V4M2K7PZ6N8S0T",
          receivedBytes: -5,
          totalBytes: 20,
          speedBps: 5,
          etaSeconds: 2,
        }),
      ) + "\n",
    );
    coreOut.write("not json at all\n");
    await new Promise((r) => setImmediate(r));

    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("download.progress");
    client.removeAllListeners();
  });

  it("rejects all inflight requests when the stream closes", async () => {
    const { client, coreIn, coreOut } = makePair();
    readLines(coreIn, () => undefined); // never answers
    const promise = client.request("download.list");
    const assertion = expect(promise).rejects.toMatchObject({ code: "core_unavailable" });
    coreOut.end();
    coreIn.end();
    await assertion;
    client.removeAllListeners();
  });
});

describe("CoreSupervisor (spawn-less behaviors)", () => {
  it("reports unavailable when the binary does not exist", () => {
    const supervisor = new CoreSupervisor({
      binaryPath: "/definitely/not/here/download-core",
      dbPath: "/tmp/x.db",
      maxConcurrent: 3,
    });
    const states: string[] = [];
    supervisor.on("state", (s) => states.push(s));
    supervisor.start();
    expect(supervisor.currentState).toBe("unavailable");
    expect(states).toContain("unavailable");
  });

  it("resolves the binary path per platform/package state", () => {
    expect(resolveCoreBinaryPath({ appRoot: "/a", isPackaged: false })).toMatch(/core[\\/]target[\\/]debug/);
    expect(resolveCoreBinaryPath({ appRoot: "/a", isPackaged: true })).toMatch(/bin[\\/]download-core/);
    expect(resolveCoreBinaryPath({ appRoot: "/a", isPackaged: true, envOverride: "/custom/x" })).toBe("/custom/x");
  });
});

// EventEmitter import kept for future supervisor event typing; silence unused warning.
void EventEmitter;
