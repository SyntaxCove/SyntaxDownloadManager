import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Post-1.0: the user-agent override path of the TabManager. Electron is stubbed at the
 * exact port boundary the manager uses (session.fromPartition, WebContentsView) so the
 * real production code runs: default capture, live application to the browser AND proxy
 * sessions, and the reset semantics of setUserAgent(null/"").
 */

interface FakeSession {
  getUserAgent: ReturnType<typeof vi.fn>;
  setUserAgent: ReturnType<typeof vi.fn>;
  setPermissionRequestHandler: ReturnType<typeof vi.fn>;
  setProxy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const sessions: Record<string, FakeSession> = {};
  const makeSession = (): FakeSession => ({
    getUserAgent: vi.fn(() => "DefaultElectronUA/1.0"),
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setProxy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  });

  const webContentsInstances: Array<Record<string, unknown>> = [];
  const makeWebContents = (): Record<string, unknown> => {
    const wc: Record<string, unknown> = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => "about:blank"),
      getTitle: vi.fn(() => ""),
      isLoading: vi.fn(() => false),
      isAudioMuted: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      setAudioMuted: vi.fn(),
      close: vi.fn(),
      navigationHistory: { canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false) },
    };
    webContentsInstances.push(wc);
    return wc;
  };

  class FakeWebContentsView {
    webContents: Record<string, unknown>;
    setVisible: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    constructor(_opts: unknown) {
      this.webContents = makeWebContents();
      this.setVisible = vi.fn();
      this.setBounds = vi.fn();
    }
  }

  return { sessions, makeSession, webContentsInstances, FakeWebContentsView };
});

vi.mock("electron", () => ({
  session: {
    fromPartition: (partition: string) => {
      hoisted.sessions[partition] ??= hoisted.makeSession();
      return hoisted.sessions[partition];
    },
  },
  WebContentsView: hoisted.FakeWebContentsView,
}));

import { TabManager } from "../domains/tab-manager.js";

function makeManager(resolveProxy: (id: string) => Promise<unknown> = async () => null): TabManager {
  return new TabManager(
    () => undefined, // no window: bounds paths stay dormant, sessions still materialize
    { onUpdated: () => undefined, onClosed: () => undefined, onVisited: () => undefined },
    resolveProxy as never,
  );
}

describe("TabManager user agent (post-1.0)", () => {
  beforeEach(() => {
    for (const k of Object.keys(hoisted.sessions)) delete hoisted.sessions[k];
    hoisted.webContentsInstances.length = 0;
  });

  /** Lookup that satisfies TS strictness without `!` — a missing stub is a test bug. */
  const sessionOf = (partition: string): FakeSession => {
    const ses = hoisted.sessions[partition];
    if (!ses) throw new Error(`stub session ${partition} was never created`);
    return ses;
  };

  it("before any override, the effective UA is the captured Electron default", async () => {
    const manager = makeManager();
    expect(manager.getUserAgent()).toEqual({ userAgent: "", isCustom: false }); // no session yet
    await manager.create({ url: "https://example.com/" });
    const ses = sessionOf("persist:browser");
    expect(ses.setUserAgent).not.toHaveBeenCalled();
    expect(manager.getUserAgent()).toEqual({ userAgent: "DefaultElectronUA/1.0", isCustom: false });
  });

  it("an override set BEFORE session creation is applied when the session materializes", async () => {
    const manager = makeManager();
    manager.setUserAgent("CustomUA/2.0");
    await manager.create({ url: "https://example.com/" });
    const ses = sessionOf("persist:browser");
    expect(ses.setUserAgent).toHaveBeenCalledWith("CustomUA/2.0");
    expect(manager.getUserAgent()).toEqual({ userAgent: "CustomUA/2.0", isCustom: true });
  });

  it("an override set AFTER session creation is applied live to the existing session", async () => {
    const manager = makeManager();
    await manager.create({ url: "https://example.com/" });
    const ses = sessionOf("persist:browser");
    manager.setUserAgent("CustomUA/2.0");
    expect(ses.setUserAgent).toHaveBeenLastCalledWith("CustomUA/2.0");
    expect(manager.getUserAgent()).toEqual({ userAgent: "CustomUA/2.0", isCustom: true });
  });

  it("resetting (null / empty / whitespace) restores the captured default", async () => {
    const manager = makeManager();
    await manager.create({ url: "https://example.com/" });
    const ses = sessionOf("persist:browser");
    manager.setUserAgent("CustomUA/2.0");
    manager.setUserAgent(null);
    expect(ses.setUserAgent).toHaveBeenLastCalledWith("DefaultElectronUA/1.0");
    expect(manager.getUserAgent()).toEqual({ userAgent: "DefaultElectronUA/1.0", isCustom: false });
    manager.setUserAgent("   ");
    expect(manager.getUserAgent().isCustom).toBe(false);
    manager.setUserAgent("");
    expect(manager.getUserAgent().userAgent).toBe("DefaultElectronUA/1.0");
  });

  it("override values are trimmed", async () => {
    const manager = makeManager();
    manager.setUserAgent("  Padded/UA  ");
    expect(manager.getUserAgent()).toEqual({ userAgent: "Padded/UA", isCustom: true });
  });

  it("proxied tabs' sessions receive the same override", async () => {
    const manager = makeManager(async () => ({
      proxyRules: "http://proxy:8080",
      proxyBypassRules: "",
      username: "u",
      password: "p",
    }));
    manager.setUserAgent("CustomUA/2.0");
    await manager.create({ url: "https://example.com/", proxyProfileId: "profile-1" });
    const proxied = sessionOf("persist:proxy.profile-1");
    expect(proxied).toBeDefined();
    expect(proxied.setUserAgent).toHaveBeenCalledWith("CustomUA/2.0");
    // And a later live change reaches the already-created proxy session too.
    manager.setUserAgent("CustomUA/3.0");
    expect(proxied.setUserAgent).toHaveBeenLastCalledWith("CustomUA/3.0");
  });
});
