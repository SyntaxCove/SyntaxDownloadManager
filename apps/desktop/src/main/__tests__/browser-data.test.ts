import { describe, expect, it, vi } from "vitest";
import { METHODS, makeRequest, newUlid } from "@syntaxdm/contracts";
import { registerBrowserDataDomain } from "../domains/browser-data.js";
import { registerAppDomain, resolveEntryPath } from "../domains/app-reveal.js";
import type { RevealShell } from "../domains/app-reveal.js";
import { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 14 — browser data domain (validated forwarder to the core) and the app reveal
 * domain (paths resolved ONLY from core-fetched job rows; the renderer never supplies one).
 */

const ULID_OK = "01JD8W3G5XQ9V4M2K7PZ6N8S0T";

function makeRouterWithFakeCore(
  coreResponse: (method: string, params: unknown) => Promise<unknown>,
): { router: IpcRouter; supervisor: CoreSupervisor; request: ReturnType<typeof vi.fn> } {
  const router = new IpcRouter((msg) => console.log(msg));
  const request = vi.fn(coreResponse);
  const supervisor = { request } as unknown as CoreSupervisor;
  return { router, supervisor, request };
}

describe("browser-data domain (Phase 14)", () => {
  it("all nine methods are registered as core-served forwarders", async () => {
    const { router, request } = makeRouterWithFakeCore(async () => ({ recorded: true }));
    registerBrowserDataDomain(router, { request } as unknown as CoreSupervisor);
    for (const m of [
      "browser.history.record",
      "browser.history.list",
      "browser.history.delete",
      "browser.history.clear",
      "browser.bookmark.create",
      "browser.bookmark.list",
      "browser.bookmark.getByUrl",
      "browser.bookmark.update",
      "browser.bookmark.remove",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
      expect(router.has(m)).toBe(true);
    }
  });

  it("history.record forwards params untouched and validates the result shape", async () => {
    const { router, request } = makeRouterWithFakeCore(async () => ({ recorded: true }));
    registerBrowserDataDomain(router, { request } as unknown as CoreSupervisor);
    const response = await router.handleRequest(
      makeRequest(newUlid(), "browser.history.record", {
        url: "https://example.com/x",
        title: "X",
        visitedAt: 1735689600000,
      }),
      {},
    );
    expect(response.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("browser.history.record", {
      url: "https://example.com/x",
      title: "X",
      visitedAt: 1735689600000,
    });
  });

  it("a core response that violates the contract is rejected by the result schema", async () => {
    const { router } = makeRouterWithFakeCore(async () => ({ recorded: "nope" }));
    registerBrowserDataDomain(router, {
      request: async () => ({ recorded: "nope" }),
    } as unknown as CoreSupervisor);
    const response = await router.handleRequest(
      makeRequest(newUlid(), "browser.history.record", { url: "https://example.com/x" }),
      {},
    );
    expect(response.ok).toBe(false);
  });
});

describe("resolveEntryPath", () => {
  it("download/media use destinationPath", () => {
    expect(resolveEntryPath("download", { job: { destinationPath: "/d/file.zip" } })).toBe(
      "/d/file.zip",
    );
    expect(resolveEntryPath("media", { job: { destinationPath: "/d/video.mkv" } })).toBe(
      "/d/video.mkv",
    );
  });

  it("null destinationPath is classified, never guessed", () => {
    expect(() => resolveEntryPath("download", { job: { destinationPath: null } })).toThrowError(
      expect.objectContaining({ code: "entry_path_unavailable" }),
    );
    expect(() => resolveEntryPath("media", { job: {} })).toThrowError(
      expect.objectContaining({ code: "entry_path_unavailable" }),
    );
  });

  it("torrent resolves destinationDir + name; missing name is classified", () => {
    expect(
      resolveEntryPath("torrent", { job: { destinationDir: "/d", name: "Linux ISO" } }),
    ).toBe("/d/Linux ISO");
    expect(() =>
      resolveEntryPath("torrent", { job: { destinationDir: "/d", name: null } }),
    ).toThrowError(expect.objectContaining({ code: "entry_path_unavailable" }));
  });

  it("a missing job row is invalid_state", () => {
    expect(() => resolveEntryPath("download", { job: null })).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });
});

describe("app.revealEntry domain", () => {
  const shellCalls: Array<{ op: "show" | "open"; path: string }> = [];
  const shell: RevealShell = {
    showItemInFolder: (path) => {
      shellCalls.push({ op: "show", path });
    },
    openPath: async (path) => {
      shellCalls.push({ op: "open", path });
      return "";
    },
  };

  function makeRouter(jobRow: unknown): { router: IpcRouter; request: ReturnType<typeof vi.fn> } {
    const router = new IpcRouter((msg) => console.log(msg));
    const request = vi.fn(async () => jobRow);
    registerAppDomain(router, { request } as unknown as CoreSupervisor, shell);
    return { router, request };
  }

  it("folder mode fetches the job from the core and reveals the resolved path", async () => {
    shellCalls.length = 0;
    const existsPath = process.execPath; // a path that certainly exists
    const { router, request } = makeRouter({ job: { destinationPath: existsPath } });
    const response = await router.handleRequest(
      makeRequest(newUlid(), "app.revealEntry", { kind: "download", id: ULID_OK, mode: "folder" }),
      {},
    );
    expect(response.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("download.get", { id: ULID_OK });
    expect(shellCalls).toEqual([{ op: "show", path: existsPath }]);
  });

  it("media jobs resolve through media.get and open through the shell", async () => {
    shellCalls.length = 0;
    const existsPath = process.execPath;
    const { router, request } = makeRouter({ job: { destinationPath: existsPath } });
    const response = await router.handleRequest(
      makeRequest(newUlid(), "app.revealEntry", { kind: "media", id: ULID_OK, mode: "open" }),
      {},
    );
    expect(response.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("media.get", { id: ULID_OK });
    expect(shellCalls).toEqual([{ op: "open", path: existsPath }]);
  });

  it("torrent jobs resolve through torrent.get into destinationDir + name", async () => {
    shellCalls.length = 0;
    const { router } = makeRouter({ job: { destinationDir: ".", name: "." } });
    const response = await router.handleRequest(
      makeRequest(newUlid(), "app.revealEntry", { kind: "torrent", id: ULID_OK, mode: "folder" }),
      {},
    );
    expect(response.ok).toBe(true);
    expect(shellCalls[0]?.path.endsWith(".")).toBe(true);
  });

  it("an unresolved path fails with entry_path_unavailable before touching the shell", async () => {
    shellCalls.length = 0;
    const { router } = makeRouter({ job: { destinationPath: null } });
    const response = await router.handleRequest(
      makeRequest(newUlid(), "app.revealEntry", { kind: "download", id: ULID_OK, mode: "folder" }),
      {},
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("entry_path_unavailable");
    expect(shellCalls).toHaveLength(0);
  });

  it("a path missing on disk fails with file_missing — never a silent no-op", async () => {
    shellCalls.length = 0;
    const { router } = makeRouter({ job: { destinationPath: "/definitely/not/there.bin" } });
    const response = await router.handleRequest(
      makeRequest(newUlid(), "app.revealEntry", { kind: "download", id: ULID_OK, mode: "open" }),
      {},
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("file_missing");
    expect(shellCalls).toHaveLength(0);
  });

  it("a shell open error propagates as io_error", async () => {
    const router = new IpcRouter((msg) => console.log(msg));
    registerAppDomain(
      router,
      {
        request: async () => ({ job: { destinationPath: process.execPath } }),
      } as unknown as CoreSupervisor,
      { showItemInFolder: () => undefined, openPath: async () => "shell failure" },
    );
    const response = await router.handleRequest(
      makeRequest(newUlid(), "app.revealEntry", { kind: "download", id: ULID_OK, mode: "open" }),
      {},
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("io_error");
  });
});
