import { WebContentsView, session } from "electron";
import type { BrowserWindow } from "electron";
import { newUlid, type BrowserTab } from "@unidm/contracts";
import { titleForUrl, clampViewportBounds } from "./url-input.js";
import type { ResolvedTabProxy } from "./proxy.js";

/**
 * TabManager — the browser engine. One `WebContentsView` per tab (the deprecated
 * `BrowserView` is never used). The manager owns:
 *  - tab lifecycle (create/close/activate with LRU fallback);
 *  - navigation + history controls;
 *  - per-tab state snapshots pushed to the renderer via the event callbacks;
 *  - overlay geometry (the active view is positioned inside the shell window content view;
 *    zero-size bounds hide it when the shell shows another page);
 *  - a dedicated persistent session (persist:browser) with an explicit permission policy;
 *  - Phase 9: per-proxy sessions (`persist:proxy.<profileId>`) with fixed-server rules and a
 *    login handler that answers proxy auth challenges with the profile's credentials.
 *
 * Security posture for web content: sandboxed, contextIsolated, no preload, no Node,
 * popups are converted to tabs, permission requests resolved by an explicit allow-list,
 * proxy credentials never embedded in Chromium rules (never visible to web content).
 */

export interface TabEvents {
  onUpdated(tab: BrowserTab): void;
  onClosed(id: string): void;
}

/** Main-wired proxy resolution: profile id → session config (null → the default session). */
export type ProxyResolver = (profileId: string) => Promise<ResolvedTabProxy | null>;

interface TabEntry {
  readonly id: string;
  view: WebContentsView;
  snapshot: BrowserTab;
}

const PERMISSION_POLICY: ReadonlySet<string> = new Set([
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
  "media",
  "mediaKeySystem",
]);

export class TabManager {
  private readonly tabs = new Map<string, TabEntry>();
  /** LRU order for activation fallback when the active tab closes. */
  private order: string[] = [];
  private activeId: string | null = null;
  private session: Electron.Session | null = null;
  /** One persistent session per proxy profile — cookies/storage scoped to the identity. */
  private readonly proxySessions = new Map<string, Electron.Session>();
  private viewport: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly events: TabEvents,
    private readonly resolveProxy: ProxyResolver = async () => null,
  ) {}

  get active(): BrowserTab | null {
    return this.activeId ? (this.tabs.get(this.activeId)?.snapshot ?? null) : null;
  }

  get count(): number {
    return this.tabs.size;
  }

  private browserSession(): Electron.Session {
    if (!this.session) {
      this.session = session.fromPartition("persist:browser");
      this.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(PERMISSION_POLICY.has(permission));
      });
    }
    return this.session;
  }

  /** Cached session per proxy profile: fixed-server rules + proxy auth challenge handling. */
  private async sessionFor(profileId: string | null | undefined): Promise<Electron.Session> {
    if (!profileId) return this.browserSession();
    const cached = this.proxySessions.get(profileId);
    if (cached) return cached;
    const resolved = await this.resolveProxy(profileId);
    if (!resolved) return this.browserSession(); // stale profile id → direct (defensive)
    const ses = session.fromPartition(`persist:proxy.${profileId}`);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(PERMISSION_POLICY.has(permission));
    });
    // Credentials live here, never in the rules — web content never sees them.
    void ses
      .setProxy({
        mode: "fixed_servers",
        proxyRules: resolved.proxyRules,
        proxyBypassRules: resolved.proxyBypassRules || undefined,
      })
      .catch(() => undefined);
    // Electron's typings expose session 'login' only via the generic emitter
    // (the typed overload belongs to net.ClientRequest); payload is (authInfo, callback).
    (ses as unknown as NodeJS.EventEmitter).on(
      "login",
      (authInfo: Electron.AuthInfo, callback: (username?: string, password?: string) => void) => {
        if (authInfo.isProxy && resolved.username !== null) {
          callback(resolved.username, resolved.password ?? "");
        } else {
          callback(); // cancel: only proxy auth is answered
        }
      },
    );
    this.proxySessions.set(profileId, ses);
    return ses;
  }

  async create(params: { url?: string; activate?: boolean; proxyProfileId?: string | null }): Promise<BrowserTab> {
    const id = newUlid();
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        session: await this.sessionFor(params.proxyProfileId),
        // No preload: third-party web content never gets bridge code.
      },
    });

    const url = params.url ?? "about:blank";
    const snapshot: BrowserTab = {
      id,
      title: titleForUrl(url),
      url,
      faviconUrl: null,
      status: "loading",
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      isAudioMuted: false,
      isAudible: false,
      proxyProfileId: params.proxyProfileId ?? null,
      createdAt: Date.now(),
    };
    const entry: TabEntry = { id, view, snapshot };
    this.tabs.set(id, entry);
    this.order.push(id);
    this.attachWebContentsListeners(entry);

    if (params.activate !== false) this.activate(id);
    void view.webContents.loadURL(url).catch(() => {
      // did-fail-load drives the UI state; a rejected loadURL must not crash creation.
    });
    this.events.onUpdated(entry.snapshot);
    return entry.snapshot;
  }

  close(id: string): boolean {
    const entry = this.tabs.get(id);
    if (!entry) return false;
    const win = this.getWindow();
    if (win && !win.isDestroyed() && this.activeId === id) {
      try {
        win.contentView.removeChildView(entry.view);
      } catch {
        // window may already be tearing down
      }
    }
    entry.view.webContents.close();
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.events.onClosed(id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order.at(-1);
      if (next) this.activate(next);
    }
    return true;
  }

  activate(id: string): BrowserTab | null {
    const entry = this.tabs.get(id);
    if (!entry) return null;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return null;
    if (this.activeId && this.activeId !== id) {
      const current = this.tabs.get(this.activeId);
      if (current) {
        try {
          win.contentView.removeChildView(current.view);
        } catch {
          // already detached
        }
      }
    }
    win.contentView.addChildView(entry.view);
    entry.view.setVisible(true);
    this.applyBounds(entry);
    this.activeId = id;
    this.order = [...this.order.filter((x) => x !== id), id];
    entry.snapshot = this.snapshot(entry);
    this.events.onUpdated(entry.snapshot);
    return entry.snapshot;
  }

  navigate(id: string, url: string): BrowserTab | null {
    const entry = this.tabs.get(id);
    if (!entry) return null;
    void entry.view.webContents.loadURL(url).catch(() => undefined);
    entry.snapshot = { ...entry.snapshot, url, status: "loading", isLoading: true };
    this.events.onUpdated(entry.snapshot);
    return entry.snapshot;
  }

  back(id: string): BrowserTab | null {
    const entry = this.tabs.get(id);
    if (entry?.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack();
    }
    return entry ? this.snapshot(entry) : null;
  }

  forward(id: string): BrowserTab | null {
    const entry = this.tabs.get(id);
    if (entry?.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward();
    }
    return entry ? this.snapshot(entry) : null;
  }

  reload(id: string): BrowserTab | null {
    const entry = this.tabs.get(id);
    if (entry) {
      entry.view.webContents.reload();
      entry.snapshot = { ...entry.snapshot, status: "loading", isLoading: true };
      this.events.onUpdated(entry.snapshot);
      return entry.snapshot;
    }
    return null;
  }

  setMuted(id: string, muted: boolean): BrowserTab | null {
    const entry = this.tabs.get(id);
    if (!entry) return null;
    entry.view.webContents.setAudioMuted(muted);
    entry.snapshot = this.snapshot(entry);
    this.events.onUpdated(entry.snapshot);
    return entry.snapshot;
  }

  /**
   * Phase 9: move a tab onto a proxy profile (or back to direct). The underlying
   * WebContentsView is recreated on the target session partition at the current URL —
   * a live session cannot be swapped under a webContents. Documented trade-off: this
   * tab's back/forward history resets; cookies/storage stay scoped to each partition.
   */
  async setProxy(id: string, profileId: string | null): Promise<BrowserTab | null> {
    const entry = this.tabs.get(id);
    if (!entry) return null;
    const wasActive = this.activeId === id;
    const wc = entry.view.webContents;
    const currentUrl = wc.isDestroyed()
      ? entry.snapshot.url
      : wc.getURL() || entry.snapshot.url;
    const muted = wc.isDestroyed() ? entry.snapshot.isAudioMuted : wc.isAudioMuted();

    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(entry.view);
      } catch {
        // not attached
      }
    }
    if (!wc.isDestroyed()) wc.close();

    entry.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        session: await this.sessionFor(profileId),
      },
    });
    entry.snapshot = {
      ...entry.snapshot,
      proxyProfileId: profileId ?? null,
      url: currentUrl,
      title: titleForUrl(currentUrl),
      status: "loading",
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      isAudioMuted: muted,
    };
    this.attachWebContentsListeners(entry);
    if (wasActive && win && !win.isDestroyed()) {
      win.contentView.addChildView(entry.view);
      entry.view.setVisible(true);
      this.applyBounds(entry);
    }
    void entry.view.webContents.loadURL(currentUrl).catch(() => {
      // did-fail-load drives the UI state.
    });
    this.events.onUpdated(entry.snapshot);
    return entry.snapshot;
  }

  list(): BrowserTab[] {
    return [...this.tabs.values()].map((e) => e.snapshot);
  }

  /** Renderer-reported viewport rect; clamped against the real content size. */
  setViewportBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.viewport = rect;
    if (rect.width === 0 || rect.height === 0) {
      this.hideOverlay();
      return;
    }
    const win = this.getWindow();
    const entry = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!entry) return;
    if (!win || win.isDestroyed()) return;
    const size = win.getContentSize();
    this.applyBounds(entry, clampViewportBounds(rect, { width: size[0] ?? 0, height: size[1] ?? 0 }));
  }

  /** Hide the overlay when the shell shows a non-browser page. */
  hideOverlay(): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const entry = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (entry) {
      try {
        win.contentView.removeChildView(entry.view);
      } catch {
        // not attached
      }
    }
  }

  private applyBounds(entry: TabEntry, clamped?: { x: number; y: number; width: number; height: number }): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const size = win.getContentSize();
    const rect = clamped ?? clampViewportBounds(this.viewport, { width: size[0] ?? 0, height: size[1] ?? 0 });
    entry.view.setBounds({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  private snapshot(entry: TabEntry): BrowserTab {
    const wc = entry.view.webContents;
    return {
      ...entry.snapshot,
      title: wc.isDestroyed() ? entry.snapshot.title : wc.getTitle() || titleForUrl(entry.snapshot.url),
      url: wc.isDestroyed() ? entry.snapshot.url : wc.getURL(),
      faviconUrl: entry.snapshot.faviconUrl,
      isLoading: wc.isDestroyed() ? false : wc.isLoading(),
      status: wc.isDestroyed() ? "crashed" : "loaded",
      canGoBack: wc.isDestroyed() ? false : wc.navigationHistory.canGoBack(),
      canGoForward: wc.isDestroyed() ? false : wc.navigationHistory.canGoForward(),
      isAudioMuted: wc.isDestroyed() ? false : wc.isAudioMuted(),
      isAudible: wc.isDestroyed() ? false : wc.isCurrentlyAudible(),
    };
  }

  private refresh(entry: TabEntry, patch: Partial<BrowserTab>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    this.events.onUpdated(entry.snapshot);
  }

  private attachWebContentsListeners(entry: TabEntry): void {
    const wc = entry.view.webContents;

    wc.on("did-start-loading", () => this.refresh(entry, { isLoading: true, status: "loading" }));
    wc.on("did-stop-loading", () =>
      this.refresh(entry, { isLoading: false, status: "loaded", canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }),
    );
    wc.on("page-title-updated", (_e, title) => this.refresh(entry, { title }));
    wc.on("page-favicon-updated", (_e, icons) => {
      const favicon = icons.at(-1) ?? null;
      this.refresh(entry, { faviconUrl: favicon });
    });
    wc.on("did-navigate", (_e, url) => this.refresh(entry, { url, status: "loaded" }));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) this.refresh(entry, { url });
    });
    wc.on("audio-state-changed", () => this.refresh(entry, { isAudible: wc.isCurrentlyAudible() }));
    wc.on("render-process-gone", (_e, details) =>
      this.refresh(entry, { status: details.reason === "clean-exit" ? "loaded" : "crashed", isLoading: false }),
    );

    // Popups never become native windows — they become tabs (single-window browsing);
    // a popup inherits the source tab's proxy identity.
    wc.setWindowOpenHandler(({ url }) => {
      void this.create({ url, activate: true, proxyProfileId: entry.snapshot.proxyProfileId });
      return { action: "deny" };
    });
  }

  /** Flush all tabs (used on app quit); the persistent session keeps cookies/storage. */
  destroyAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }
}
