import { describe, expect, it, vi } from "vitest";
import { METHODS, SuccessEnvelope, makeRequest, newUlid } from "@syntaxdm/contracts";
import { registerAppDialogs, type DirectoryPicker } from "../domains/app-dialogs.js";
import { IpcRouter } from "../ipc/router.js";

/**
 * Phase 16 — app.pickDirectory: the native directory picker deferred from Phase 3.
 * The renderer only receives the user's choice; cancel is a valid null result, never an
 * error. (Electron's dialog surface is injected, so these tests exercise the domain and
 * router wiring; the Electron call itself is a one-liner covered by the GUI walkthrough.)
 */

function makeRouter(picker: DirectoryPicker): IpcRouter {
  const router = new IpcRouter((msg) => console.log(msg));
  registerAppDialogs(router, picker);
  return router;
}

describe("app.pickDirectory (Phase 16)", () => {
  it("returns the picked path", async () => {
    const pick = vi.fn(async () => "/home/user/Downloads");
    const router = makeRouter({ pick });
    const res = (await router.handleRequest(
      makeRequest(newUlid(), "app.pickDirectory", {}),
      {},
    )) as SuccessEnvelope;
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ path: "/home/user/Downloads" });
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("cancel resolves to path: null (never an error)", async () => {
    const router = makeRouter({ pick: async () => null });
    const res = (await router.handleRequest(
      makeRequest(newUlid(), "app.pickDirectory", {}),
      {},
    )) as SuccessEnvelope;
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ path: null });
  });

  it("params must be empty; the result schema rejects empty strings", async () => {
    const router = makeRouter({ pick: async () => "" });
    const res = await router.handleRequest(
      makeRequest(newUlid(), "app.pickDirectory", {}),
      {},
    );
    // The picker returned "" (a bug upstream) — the result schema refuses it at the boundary.
    expect(res.ok).toBe(false);
  });

  it("is registered on the main server with a no-payload contract", () => {
    expect(METHODS["app.pickDirectory"].server).toBe("main");
    expect(METHODS["app.pickDirectory"].params!.safeParse({}).success).toBe(true);
  });
});
