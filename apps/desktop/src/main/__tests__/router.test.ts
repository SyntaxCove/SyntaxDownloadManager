import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IpcRouter, toContractError } from "../ipc/router.js";
import { SyntaxDmError, makeRequest, newUlid, PROTOCOL_VERSION } from "@syntaxdm/contracts";

function setup() {
  const sent: unknown[] = [];
  const sink = { send: (m: unknown) => sent.push(m) };
  const router = new IpcRouter();
  router.handle("echo.upper", {
    paramsSchema: z.object({ text: z.string() }),
    resultSchema: z.object({ upper: z.string() }),
    handler: async (params) => ({ upper: (params as { text: string }).text.toUpperCase() }),
  });
  router.handle("fail.uni", {
    handler: async () => {
      throw new SyntaxDmError("storage_error", "db locked");
    },
  });
  router.handle("fail.plain", {
    handler: async () => {
      throw new Error("boom");
    },
  });
  router.handle("ping.empty", { handler: async () => ({ pong: true }) });
  return { router, sink, sent };
}

describe("IpcRouter", () => {
  it("validates params, invokes handler, validates result", async () => {
    const { router } = setup();
    const res = await router.handleRequest(makeRequest(newUlid(), "echo.upper", { text: "uni" }), {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ upper: "UNI" });
  });

  it("rejects invalid params with invalid_params and zod issues", async () => {
    const { router } = setup();
    const res = await router.handleRequest(makeRequest(newUlid(), "echo.upper", { text: 42 }), {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("invalid_params");
      expect((res.error.data as { issues: unknown[] }).issues).toHaveLength(1);
    }
  });

  it("maps unknown methods to method_not_found", async () => {
    const { router } = setup();
    const res = await router.handleRequest(makeRequest(newUlid(), "nope.nope", {}), {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("method_not_found");
  });

  it("maps malformed envelopes to parse_error preserving the id when possible", async () => {
    const { router } = setup();
    const res = await router.handleRequest({ v: 1, method: "x" }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("parse_error");

    const res2 = await router.handleRequest({ v: 9, id: "abc-123", method: "x" }, {});
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.id).toBe("abc-123");
  });

  it("converts handler errors to typed envelopes", async () => {
    const { router } = setup();
    const uni = await router.handleRequest(makeRequest(newUlid(), "fail.uni", {}), {});
    expect(uni.ok).toBe(false);
    if (!uni.ok) expect(uni.error.code).toBe("storage_error");

    const plain = await router.handleRequest(makeRequest(newUlid(), "fail.plain", {}), {});
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error.code).toBe("internal_error");
  });

  it("allows parameterless methods", async () => {
    const { router } = setup();
    const res = await router.handleRequest(makeRequest(newUlid(), "ping.empty"), {});
    expect(res.ok).toBe(true);
  });

  it("enforces protocol version on incoming requests", async () => {
    const { router } = setup();
    const res = await router.handleRequest({ v: PROTOCOL_VERSION + 1, id: "x1", method: "ping.empty" }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("parse_error");
  });

  it("drops invalid event payloads and never emits them", () => {
    const { router } = setup();
    const listener = vi.fn();
    router.onEvent(listener);
    router.emit("e.test", z.object({ n: z.number() }), { n: "not-a-number" });
    expect(listener).not.toHaveBeenCalled();
    router.emit("e.test", z.object({ n: z.number() }), { n: 5 });
    expect(listener).toHaveBeenCalledWith("e.test", { n: 5 });
  });

  it("rejects duplicate method registration", () => {
    const { router } = setup();
    expect(() => router.handle("ping.empty", { handler: async () => null })).toThrow(/twice/);
  });

  it("toContractError normalizes unknown throwables", () => {
    expect(toContractError("oops")).toEqual({ code: "internal_error", message: "oops" });
    expect(toContractError(new SyntaxDmError("io_error", "disk"))).toEqual({
      code: "io_error", message: "disk",
    });
  });
});
