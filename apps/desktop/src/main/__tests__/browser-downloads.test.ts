import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachBrowserDownloadHandling,
  assembleHandoffHeaders,
  deriveFilename,
  isRoutableDownloadUrl,
  sessionCookieHeader,
  type BrowserDownloadDeps,
} from "../domains/browser-downloads.js";

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("isRoutableDownloadUrl", () => {
  it("routes only http(s) sources — blob:/data:/file: stay native", () => {
    expect(isRoutableDownloadUrl("https://x/file.zip")).toBe(true);
    expect(isRoutableDownloadUrl("HTTP://X/FILE.ZIP")).toBe(true);
    expect(isRoutableDownloadUrl("blob:https://x/abc")).toBe(false);
    expect(isRoutableDownloadUrl("data:application/octet-stream;base64,AAAA")).toBe(false);
    expect(isRoutableDownloadUrl("file:///C:/x.exe")).toBe(false);
  });
});

describe("assembleHandoffHeaders", () => {
  it("assembles the session-fact headers and drops empty/non-http entries", () => {
    const headers = assembleHandoffHeaders({
      cookieHeader: "sid=abc; theme=dark",
      userAgent: "  SyntaxDM-UA/1.2  ",
      referer: "https://site.com/page",
      origin: "https://site.com",
    });
    expect(headers).toEqual({
      "User-Agent": "SyntaxDM-UA/1.2",
      Referer: "https://site.com/page",
      Origin: "https://site.com",
      Cookie: "sid=abc; theme=dark",
    });
  });

  it("omits every fact it does not have", () => {
    expect(assembleHandoffHeaders({ cookieHeader: null, userAgent: null, referer: "about:blank", origin: null })).toEqual({});
    expect(
      assembleHandoffHeaders({ cookieHeader: "   ", userAgent: "", referer: "https://x/", origin: null }).Cookie,
    ).toBeUndefined();
  });
});

describe("sessionCookieHeader", () => {
  it("sorts most-specific paths first and joins with '; '", async () => {
    const ses = {
      cookies: {
        get: async () => [
          { name: "wide", value: "1", path: "/" },
          { name: "deep", value: "2", path: "/a/b" },
          { name: "mid", value: "3", path: "/a" },
        ],
      },
    } as unknown as Electron.Session;
    expect(await sessionCookieHeader(ses, "https://x/a/b/file")).toBe("deep=2; mid=3; wide=1");
  });

  it("returns null for an empty jar and for cookie-jar failures", async () => {
    const empty = { cookies: { get: async () => [] } } as unknown as Electron.Session;
    expect(await sessionCookieHeader(empty, "https://x/")).toBeNull();
    const broken = {
      cookies: {
        get: async () => {
          throw new Error("jar unavailable");
        },
      },
    } as unknown as Electron.Session;
    expect(await sessionCookieHeader(broken, "https://x/")).toBeNull();
  });
});

describe("deriveFilename", () => {
  it("prefers the browser-suggested name and sanitizes it", () => {
    expect(deriveFilename("https://x/a", 'report: "final".pdf')).toBe('report_ _final_.pdf');
  });

  it("falls back to the decoded URL path segment", () => {
    expect(deriveFilename("https://x/a/b/My%20File.zip", "")).toBe("My File.zip");
  });

  it("never returns an empty name", () => {
    expect(deriveFilename("https://x/", null)).toBe("download.bin");
    expect(deriveFilename("garbage", undefined)).toBe("download.bin");
  });
});

// ---------------------------------------------------------------------------
// the will-download wiring (fake session + fake item at the exact port boundary)
// ---------------------------------------------------------------------------

interface FakeItem {
  getURL: ReturnType<typeof vi.fn>;
  getFilename: ReturnType<typeof vi.fn>;
  getInitiatorOrigin: ReturnType<typeof vi.fn>;
}

type TestDeps = BrowserDownloadDeps & {
  createJob: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
};

function makeDeps(overrides?: Partial<BrowserDownloadDeps>): TestDeps {
  const createJob = overrides?.createJob ?? vi.fn().mockResolvedValue({ job: { id: "j1" } });
  const notify = overrides?.notify ?? vi.fn();
  const logger =
    overrides?.logger ?? { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: BrowserDownloadDeps = {
    isCoreReady: overrides?.isCoreReady ?? (() => true),
    createJob,
    getDownloadDir: overrides?.getDownloadDir ?? (() => "C:\\Downloads"),
    logger,
    notify,
  };
  if (overrides?.now !== undefined) {
    return { ...deps, now: overrides.now } as TestDeps;
  }
  return deps as TestDeps;
}

function makeFakeSession(cookies: Array<{ name: string; value: string; path?: string }> = []) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const downloadURL = vi.fn();
  const ses = {
    on: (name: string, handler: (...args: unknown[]) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    downloadURL,
    getUserAgent: () => "SyntaxDM-UA/1.2",
    cookies: { get: async () => cookies },
    /** test seam: fire the will-download handler */
    emitWillDownload: (event: { preventDefault: ReturnType<typeof vi.fn> }, item: FakeItem, wc?: unknown) => {
      for (const h of handlers.get("will-download") ?? []) h(event, item, wc);
    },
  };
  return ses;
}

const makeItem = (url: string, filename: string): FakeItem => ({
  getURL: vi.fn(() => url),
  getFilename: vi.fn(() => filename),
  getInitiatorOrigin: vi.fn(() => "https://site.com"),
});

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5));
};

describe("attachBrowserDownloadHandling", () => {
  let deps: ReturnType<typeof makeDeps>;
  let ses: ReturnType<typeof makeFakeSession>;
  let preventDefault: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deps = makeDeps();
    ses = makeFakeSession([{ name: "sid", value: "abc", path: "/" }]);
    preventDefault = vi.fn();
    attachBrowserDownloadHandling(ses as unknown as Electron.Session, deps);
  });

  it("hands an http(s) download to the engine with derived filename and headers", async () => {
    ses.emitWillDownload({ preventDefault }, makeItem("https://cdn.x/files/setup.exe", "setup.exe"));
    await flush();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.createJob).toHaveBeenCalledWith({
      url: "https://cdn.x/files/setup.exe",
      destinationDir: "C:\\Downloads",
      filename: "setup.exe",
      overwrite: false,
      headers: expect.objectContaining({ Cookie: "sid=abc", "User-Agent": "SyntaxDM-UA/1.2" }),
    });
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("keeps blob:/data: downloads native (never preventDefault, never trapped)", async () => {
    ses.emitWillDownload({ preventDefault }, makeItem("blob:https://x/1", "blob"));
    ses.emitWillDownload({ preventDefault }, makeItem("data:text/plain;base64,AA", "data"));
    await flush();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(deps.createJob).not.toHaveBeenCalled();
  });

  it("keeps the download native when the core is not ready", async () => {
    const notReady = makeDeps({ isCoreReady: () => false });
    const ses2 = makeFakeSession();
    const pd = vi.fn();
    attachBrowserDownloadHandling(ses2 as unknown as Electron.Session, notReady);
    ses2.emitWillDownload({ preventDefault: pd }, makeItem("https://x/a.zip", "a.zip"));
    await flush();
    expect(pd).not.toHaveBeenCalled();
    expect(notReady.createJob).not.toHaveBeenCalled();
  });

  it("rescues natively exactly once when the hand-off fails after preventDefault", async () => {
    const failing = makeDeps({ createJob: vi.fn().mockRejectedValue(new Error("core died")) });
    const ses2 = makeFakeSession();
    attachBrowserDownloadHandling(ses2 as unknown as Electron.Session, failing);
    const item = makeItem("https://x/rescue.zip", "rescue.zip");
    const pd = vi.fn();
    ses2.emitWillDownload({ preventDefault: pd }, item);
    await flush();
    expect(pd).toHaveBeenCalledTimes(1);
    expect(failing.createJob).toHaveBeenCalledTimes(1);
    // the rescue re-issues the URL to the session
    expect(ses2.downloadURL).toHaveBeenCalledWith("https://x/rescue.zip");
    expect(failing.notify).toHaveBeenCalledTimes(1);
    // the re-issued will-download consumes the marker: native, no second preventDefault
    const pd2 = vi.fn();
    ses2.emitWillDownload({ preventDefault: pd2 }, item);
    await flush();
    expect(pd2).not.toHaveBeenCalled();
    expect(failing.createJob).toHaveBeenCalledTimes(1);
  });

  it("logs the hand-off without ever logging header values", async () => {
    ses.emitWillDownload({ preventDefault }, makeItem("https://cdn.x/v.mp4", "v.mp4"));
    await flush();
    const allLogs = JSON.stringify([
      ...deps.logger.info.mock.calls,
      ...deps.logger.warn.mock.calls,
      ...deps.logger.error.mock.calls,
    ]);
    expect(allLogs).not.toContain("sid=abc");
    expect(allLogs).not.toContain('"Cookie": "');
  });
});
