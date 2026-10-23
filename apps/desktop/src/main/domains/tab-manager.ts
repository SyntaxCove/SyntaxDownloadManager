import { WebContentsView, session } from "electron";
import type { BrowserWindow } from "electron";
import { newUlid, type BrowserTab } from "@syntaxdm/contracts";
import { titleForUrl, clampViewportBounds } from "./url-input.js";
import { VisitRecorder, type RecordedVisit } from "./history-recorder.js";
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
  /** Phase 14: a settled main-frame http(s) navigation worth one history row. */
  onVisited(visit: RecordedVisit & { tabId: string }): void;
}

/** Main-wired proxy resolution: profile id → session config (null → the default session). */
export type ProxyResolver = (profileId: string) => Promise<ResolvedTabProxy | null>;

/** Phase 33: internal (main-side) tab activity — never a renderer event. */
export type TabActivitySignal = { type: "pageChanged" | "mediaPlaying"; tabId: string };
/** Phase 33: called exactly once per browser session at creation (default + per-proxy). */
export type SessionLifecycleObserver = (
  session: Electron.Session,
  proxyProfileId: string | null,
) => void;

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
  /** Phase 14: per-tab settle dedupe for history recording. */
  private readonly visitRecorder = new VisitRecorder();
  private viewport: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 0, height: 0 };
  /** Post-1.0: the pristine Electron/Chromium UA, captured from the browser session
   *  before any override is applied — the reset target for `setUserAgent(null)`. */
  private defaultUserAgent: string | null = null;
  /** Post-1.0: the settings override; null = use the captured default unchanged. */
  private customUserAgent: string | null = null;
  /** Phase 33: observers wired by main before any tab/session can exist. */
  private sessionLifecycle: SessionLifecycleObserver | null = null;
  private tabActivity: ((signal: TabActivitySignal) => void) | null = null;

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
      // Capture the pristine UA first — after setUserAgent(custom) getUserAgent() would
      // echo the override back and a later reset would have nothing to reset to.
      if (this.defaultUserAgent === null) this.defaultUserAgent = this.session.getUserAgent();
      if (this.customUserAgent !== null) this.session.setUserAgent(this.effectiveUserAgent());
      // Phase 33: download interception + media sniffing attach per session, exactly once.
      this.sessionLifecycle?.(this.session, null);
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
    // Post-1.0: a proxied tab obeys the same user-agent override as the default session.
    if (this.customUserAgent !== null) ses.setUserAgent(this.effectiveUserAgent());
    this.proxySessions.set(profileId, ses);
    // Phase 33: the proxied session gets the same download/media handling.
    this.sessionLifecycle?.(ses, profileId);
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
        webSecurity: true, // Phase 23 (F-D): explicit — defaults are not reviewable facts.
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
    this.visitRecorder.forget(id);
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
        webSecurity: true, // Phase 23 (F-D): explicit — defaults are not reviewable facts.
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

  /**
   * Post-1.0: apply the user-agent override from settings to every session this manager
   * owns (null / empty = reset to the captured Electron default). `session.setUserAgent`
   * affects loads from this point on — already-open pages pick the new UA up on their
   * next navigation or reload, which the Settings page documents.
   */
  setUserAgent(custom: string | null): void {
    const trimmed = custom?.trim();
    this.customUserAgent = trimmed ? trimmed : null;
    const ua = this.effectiveUserAgent();
    if (this.session) this.session.setUserAgent(ua);
    for (const ses of this.proxySessions.values()) ses.setUserAgent(ua);
  }

  /** The effective user agent new tab loads will use, and whether it is an override. */
  getUserAgent(): { userAgent: string; isCustom: boolean } {
    return { userAgent: this.effectiveUserAgent(), isCustom: this.customUserAgent !== null };
  }

  /**
   * Phase 33: wire the main-side observers (download interception, media sniffing) that
   * attach to each browser session at creation. Must be set before any session exists —
   * main wires it during boot, before the renderer can request a tab. `null` detaches.
   */
  setSessionLifecycleObserver(cb: SessionLifecycleObserver | null): void {
    this.sessionLifecycle = cb;
  }

  /** Phase 33: internal tab activity (page navigations, media playback) for main-side consumers. */
  setTabActivityObserver(cb: ((signal: TabActivitySignal) => void) | null): void {
    this.tabActivity = cb;
  }

  /** Phase 33: attribute a webRequest/webContents id back to its tab (null = unknown). */
  tabIdForWebContents(webContentsId: number): string | null {
    for (const entry of this.tabs.values()) {
      const wc = entry.view.webContents;
      if (!wc.isDestroyed() && wc.id === webContentsId) return entry.id;
    }
    return null;
  }

  /**
   * Phase 33: the session a tab browses on — the credential source for downloads of
   * media that tab detected (cookies are per-partition, so the tab's identity decides).
   */
  async sessionForTab(tabId: string): Promise<Electron.Session | null> {
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    return this.sessionFor(entry.snapshot.proxyProfileId);
  }

  /** Phase 33: the tab's live webContents for main-side in-page scans (null = unknown/dead). */
  webContentsForTab(tabId: string): Electron.WebContents | null {
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    const wc = entry.view.webContents;
    return wc.isDestroyed() ? null : wc;
  }

  private effectiveUserAgent(): string {
    return this.customUserAgent ?? this.defaultUserAgent ?? "";
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
    wc.on("did-navigate", (_e, url) => {
      this.refresh(entry, { url, status: "loaded" });
      // Phase 33: a new main-frame document invalidates the tab's detected-media list.
      this.tabActivity?.({ type: "pageChanged", tabId: entry.id });
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) {
        this.refresh(entry, { url });
        // SPA soft navigations never fire the loading cycle — record them here, now,
        // with the title/favicon the loaded page already carries.
        this.recordVisit(entry, url);
      }
    });
    // Full navigations are recorded when the load settles (title + favicon are known by
    // then). Failures never reach here: a failed load fires did-fail-load, not settle.
    wc.on("did-stop-loading", () => {
      if (!wc.isDestroyed()) this.recordVisit(entry, wc.getURL());
    });
    wc.on("audio-state-changed", () => this.refresh(entry, { isAudible: wc.isCurrentlyAudible() }));
    // Phase 33: actual playback starts — the moment multi-server players switch sources;
    // the consumer debounces a DOM scan so the panel sees the newly-selected media.
    wc.on("media-started-playing", () => this.tabActivity?.({ type: "mediaPlaying", tabId: entry.id }));
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

  /** Filter a settle through the dedupe gate and hand it to main for persistence. */
  private recordVisit(entry: TabEntry, url: string): void {
    const visit = this.visitRecorder.admit({
      tabId: entry.id,
      url,
      title: entry.snapshot.title || null,
      faviconUrl: entry.snapshot.faviconUrl,
      at: Date.now(),
    });
    if (visit) this.events.onVisited({ ...visit, tabId: entry.id });
  }

  /** Flush all tabs (used on app quit); the persistent session keeps cookies/storage. */
  destroyAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }
}
