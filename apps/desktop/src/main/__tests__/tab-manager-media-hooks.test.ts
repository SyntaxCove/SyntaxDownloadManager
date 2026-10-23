import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 33: the TabManager hooks the browser-media domain consumes — the per-session
 * lifecycle observer (download interception + media sniffing attach exactly once per
 * session), the webContents→tab attribution, the per-tab activity signals (pageChanged /
 * mediaPlaying), and the credential-session resolution. Electron is stubbed at the exact
 * port boundary the manager uses (same discipline as tab-manager-ua.test.ts).
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
  let nextWebContentsId = 100;
  const makeWebContents = (): Record<string, unknown> => {
    const id = nextWebContentsId++;
    const wc: Record<string, unknown> = {
      id,
      // test seam: event handlers registered by attachWebContentsListeners
      handlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
      on(name: string, handler: (...args: unknown[]) => void) {
        (wc.handlers as Record<string, Array<(...args: unknown[]) => void>>)[name] = [
          ...((wc.handlers as Record<string, Array<(...args: unknown[]) => void>>)[name] ?? []),
          handler,
        ];
      },
      fire(name: string, ...args: unknown[]) {
        for (const h of (wc.handlers as Record<string, Array<(...args: unknown[]) => void>>)[name] ?? []) h(...args);
      },
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => "https://example.com/page"),
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
import type { BrowserTab } from "@syntaxdm/contracts";

function makeManager(resolveProxy?: (id: string) => Promise<unknown>): TabManager {
  return new TabManager(
    () => undefined,
    { onUpdated: () => undefined, onClosed: () => undefined, onVisited: () => undefined },
    (resolveProxy ?? (async () => null)) as never,
  );
}

/** Strict lookups that satisfy noUncheckedIndexedAccess — a miss is a test bug. */
const wcOf = (i: number): { id: number; fire: (name: string, ...args: unknown[]) => void } => {
  const wc = hoisted.webContentsInstances[i];
  if (!wc) throw new Error(`webContents ${i} was never created`);
  return wc as unknown as { id: number; fire: (name: string, ...args: unknown[]) => void };
};
const tabOf = (manager: TabManager, i = 0): BrowserTab => {
  const tab = manager.list()[i];
  if (!tab) throw new Error(`tab ${i} was never created`);
  return tab;
};

describe("TabManager Phase 33 hooks", () => {
  beforeEach(() => {
    for (const k of Object.keys(hoisted.sessions)) delete hoisted.sessions[k];
    hoisted.webContentsInstances.length = 0;
  });

  it("the session-lifecycle observer fires exactly once per session (default and proxy)", async () => {
    const manager = makeManager();
    const observed: Array<{ partition: string | null }> = [];
    manager.setSessionLifecycleObserver((ses) => {
      observed.push({ partition: ses ? "session" : "none" });
    });

    // Two tabs on the default session share it — one attach, not two.
    await manager.create({ url: "https://example.com/1" });
    await manager.create({ url: "https://example.com/2" });
    expect(observed).toHaveLength(1);

    // A proxied tab materializes a second session — a second attach with its profile id.
    const proxied = makeManager(async () => ({
      proxyRules: "http://proxy:3128",
      proxyBypassRules: "",
      username: null,
      password: null,
    }));
    const seen: Array<string | null> = [];
    proxied.setSessionLifecycleObserver((_ses, profileId) => seen.push(profileId ?? null));
    await proxied.create({ url: "https://example.com/" }); // direct → default session
    await proxied.create({ url: "https://example.com/", proxyProfileId: "01PROXY" });
    expect(seen).toEqual([null, "01PROXY"]);
  });

  it("attributes webRequest ids back to tabs and resolves the credential session per tab", async () => {
    const manager = makeManager();
    await manager.create({ url: "https://example.com/" });
    const wc = wcOf(0);
    const tab = tabOf(manager);

    expect(manager.tabIdForWebContents(wc.id)).toBe(tab.id);
    expect(manager.tabIdForWebContents(999_999)).toBeNull();

    const ses = await manager.sessionForTab(tab.id);
    expect(ses).not.toBeNull();
    expect(await manager.sessionForTab("01UNKNOWN")).toBeNull();
    expect(manager.webContentsForTab("01UNKNOWN")).toBeNull();
  });

  it("emits pageChanged on main-frame navigation and mediaPlaying on playback start", async () => {
    const manager = makeManager();
    const signals: Array<{ type: string; tabId: string }> = [];
    manager.setTabActivityObserver((s) => signals.push(s));
    await manager.create({ url: "https://example.com/" });
    const wc = wcOf(0);
    const tab = tabOf(manager);

    wc.fire("did-navigate", undefined as never, "https://example.com/other");
    wc.fire("media-started-playing");
    expect(signals).toEqual([
      { type: "pageChanged", tabId: tab.id },
      { type: "mediaPlaying", tabId: tab.id },
    ]);

    // in-page (SPA) navigation is NOT a new document — no pageChanged
    signals.length = 0;
    wc.fire("did-navigate-in-page", undefined as never, "https://example.com/other#s", true);
    expect(signals).toEqual([]);
  });

  it("detaching the observers stops the callbacks", async () => {
    const resolve = async () => ({
      proxyRules: "http://p:1",
      proxyBypassRules: "",
      username: null,
      password: null,
    });
    const manager = makeManager(resolve);
    const lifecycle = vi.fn();
    const activity = vi.fn();
    manager.setSessionLifecycleObserver(lifecycle);
    manager.setTabActivityObserver(activity);
    await manager.create({ url: "https://example.com/" }); // default session → attach #1
    await manager.create({ url: "https://example.com/", proxyProfileId: "01P" }); // proxy session → attach #2
    expect(lifecycle).toHaveBeenCalledTimes(2);
    manager.setSessionLifecycleObserver(null);
    manager.setTabActivityObserver(null);
    await manager.create({ url: "https://example.com/", proxyProfileId: "01Q" }); // new session, no observer
    expect(lifecycle).toHaveBeenCalledTimes(2);
    wcOf(2).fire("media-started-playing");
    expect(activity).not.toHaveBeenCalled();
  });
});
