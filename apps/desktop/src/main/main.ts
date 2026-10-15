import { app, BrowserWindow, Menu, Notification, nativeImage, safeStorage, Tray, shell } from "electron";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { EVENTS } from "@syntaxdm/contracts";
import { IpcRouter } from "./ipc/router.js";
import { bindElectronRpc } from "./ipc/electron-rpc.js";
import { createMainWindow } from "./window.js";
import { resolveAppPaths } from "./paths.js";
import { SettingsStore, registerSettingsDomain } from "./domains/settings.js";
import { registerBrowserDomain } from "./domains/browser.js";
import { registerDownloadDomain } from "./domains/download.js";
import { registerMediaDomain } from "./domains/media.js";
import { registerTorrentDomain } from "./domains/torrent.js";
import { registerSchedulerDomain } from "./domains/scheduler.js";
import { ProxyProfileStore, registerProxyDomain } from "./domains/proxy.js";
import { registerToolkitDomain, pushToolkitPaths } from "./domains/toolkit.js";
import { registerBrowserDataDomain } from "./domains/browser-data.js";
import { registerAppDomain } from "./domains/app-reveal.js";
import { registerAppDialogs, electronDirectoryPicker } from "./domains/app-dialogs.js";
import { registerNotifyEngine, type OsNotificationPort } from "./domains/notify.js";
import { createElectronUpdater } from "./domains/updates-adapter.js";
import { registerUpdateDomain } from "./domains/updates.js";
import {
  TrayController,
  countsFromStatuses,
  shouldHideOnClose,
  type TrayPort,
} from "./domains/tray.js";
import { ToolkitManager } from "./toolkit/manager.js";
import { buildSetPolicyPayload } from "./policy.js";
import { CoreSupervisor, resolveCoreBinaryPath } from "./core/core-supervisor.js";

/**
 * Syntax Download Manager entry point. Lifecycle:
 *  1. single-instance lock (second launch focuses the existing window);
 *  2. renderer process sandbox enabled process-wide before `ready`;
 *  3. shell window + typed IPC router bound to Electron;
 *  4. settings domain registered on the router (Phase 3); browser tabs (Phase 4) and the
 *     Rust download core (Phase 5) register on the same surface later.
 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.enableSandbox();

  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      // Phase 17: the window may be hidden to the tray — a second launch reveals it.
      win.show();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    const appRoot = app.isPackaged ? process.resourcesPath : resolve(__dirname, "../..");
    // Phase 17: stable Windows notification identity (OS toast grouping + Action Center).
    // Dev caveat: unpackaged runs have no Start-menu shortcut carrying this AUM ID, so
    // Windows may not deliver toasts there; packaged installs (Phase 19) register it.
    app.setAppUserModelId("com.syntaxdm.desktop");
    const paths = resolveAppPaths({
      appRoot,
      isPackaged: app.isPackaged,
      envDevServerUrl: process.env.SYNTAXDM_DEV_SERVER_URL,
    });

    const router = new IpcRouter((msg) => console.log(msg));

    const settingsStore = new SettingsStore(app.getPath("userData"));
    await settingsStore.load();
    registerSettingsDomain(router, settingsStore);

    // Phase 9: proxy profiles — keychain-backed secrets, redacted to the renderer.
    const proxyStore = new ProxyProfileStore(app.getPath("userData"), safeStorage);
    await proxyStore.load();

    bindElectronRpc(router, () => BrowserWindow.getAllWindows());

    createMainWindow(paths);

    const mainWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0];
    const focusShellWindow = (): void => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    };

    // ---- Phase 17: tray + close-to-tray ----
    let tray: TrayController | null = null;
    let quitting = false;
    const shellWindow = BrowserWindow.getAllWindows()[0];
    if (shellWindow) {
      shellWindow.on("close", (e) => {
        // Effective only while a tray icon actually exists (see shouldHideOnClose).
        if (shouldHideOnClose(settingsStore.settings.closeToTray, tray !== null, quitting)) {
          e.preventDefault();
          shellWindow.hide();
        }
      });
    }

    // Tray counts: a job-status mirror seeded from download.list at every core ready
    // transition and updated from validated download.updated snapshots thereafter.
    const trayStatuses = new Map<string, string>();
    const pushTrayCounts = (): void => {
      tray?.updateCounts(countsFromStatuses([...trayStatuses.values()].map((status) => ({ status }))));
    };
    const seedTrayCounts = (): void => {
      void supervisor
        .request<{ jobs: Array<{ id: string; status: string }> }>("download.list", {})
        .then(({ jobs }) => {
          trayStatuses.clear();
          for (const j of jobs) trayStatuses.set(j.id, j.status);
          pushTrayCounts();
        })
        .catch(() => undefined); // core not ready yet — re-seeded on the next ready transition
    };

    // Rust download core: supervised subprocess owning the SQLite database.
    // (Constructed before the browser domain so the visit sink below can capture it.)
    const supervisor = new CoreSupervisor({
      binaryPath: resolveCoreBinaryPath({ appRoot, isPackaged: app.isPackaged, envOverride: process.env.SYNTAXDM_CORE_BIN }),
      dbPath: join(app.getPath("userData"), "downloads.db"),
      maxConcurrent: settingsStore.settings.concurrentDownloads,
      maxConnectionsPerDownload: settingsStore.settings.maxConnectionsPerDownload,
      log: (msg) => console.log(msg),
    });

    // Phase 14: settled main-frame visits are persisted through the core (fire-and-forget:
    // a row lost during a core restart is accepted — download bytes never take this path).
    const tabManager = registerBrowserDomain(router, mainWindow, {
      resolveProxy: (id) => proxyStore.resolveForTab(id),
      hasProfile: (id) => proxyStore.has(id),
    }, (visit) => {
      void supervisor
        .request("browser.history.record", {
          url: visit.url,
          ...(visit.title !== null ? { title: visit.title } : {}),
          ...(visit.faviconUrl !== null ? { faviconUrl: visit.faviconUrl } : {}),
          visitedAt: visit.visitedAt,
        })
        .catch(() => undefined); // classified: history is best-effort during core restarts
    });

    // Phase 10: bundled media toolkit — pinned FFmpeg / yt-dlp / Deno, fetched + verified
    // into the user profile, then pushed to the core as executable paths.
    const toolkitManager = new ToolkitManager({
      manifestPath: paths.toolchainsManifest,
      toolsRoot: join(app.getPath("userData"), "tools"),
      statePath: join(app.getPath("userData"), "toolkit-state.json"),
      onStatus: (status) =>
        router.emit("toolkit.progress", EVENTS["toolkit.progress"].payload, status),
      onReadyToolsChanged: (tools) => pushToolkitPaths(supervisor, tools),
    });
    await toolkitManager.load().catch(() => undefined); // classified failures surface via toolkit.getStatus

    // Phase 9: push the full resolved runtime proxy set to the core. Secrets cross this
    // single boundary (main → core memory) and are re-pushed after core restarts.
    const pushRuntimeProxies = (): void => {
      void proxyStore
        .runtimeEndpoints()
        .then((profiles) => supervisor.request("proxy.setRuntime", { profiles }))
        .catch(() => undefined); // core not ready yet — re-pushed on the ready transition
    };

    // Push the concurrency settings to the core and re-apply whenever the user changes
    // them (the core clamps and applies both live). Defined before the state handler so
    // the ready transition can always reference them.
    const applyCoreLimits = (): void => {
      const { concurrentDownloads, maxConnectionsPerDownload } = settingsStore.settings;
      void supervisor
        .request("download.setConcurrency", {
          max: concurrentDownloads,
          maxConnectionsPerDownload,
        })
        .catch(() => undefined); // core not ready yet — the ready handler re-applies
    };

    // Phase 8: engine operating policy — auto-start, daily download window, global
    // bandwidth. Re-applied on settings changes AND every 10 minutes so the core's
    // clock stays aligned with the user's local time (DST / travel drift guard).
    const applyCorePolicy = (): void => {
      void supervisor
        .request("download.setPolicy", buildSetPolicyPayload(settingsStore.settings))
        .catch(() => undefined); // core not ready yet — the ready handler re-applies
    };

    // Phase 15: the scheduler derives recurring runs in the user's local wall clock —
    // push the offset at startup and from the same 10-minute drift-guard timer.
    const applySchedulerClock = (): void => {
      void supervisor
        .request("scheduler.setClock", { tzOffsetMinutes: -new Date().getTimezoneOffset() })
        .catch(() => undefined); // core not ready yet — the ready handler re-applies
    };

    supervisor.on("state", (status: string) => {
      // Broadcast lifecycle to every renderer (downloads page shows a banner).
      router.emit("core.state", EVENTS["core.state"].payload, { status });
      // A (re)started core starts with empty runtime maps and default policy — re-push
      // EVERYTHING after ready (Phase 16: this previously missed setConcurrency entirely
      // and left policy/clock to heal within the 10-minute timer; a restarted core now
      // gets the full settings immediately. All pushes are idempotent).
      if (status === "ready") {
        pushRuntimeProxies();
        pushToolkitPaths(supervisor, toolkitManager.readyToolPaths());
        applyCoreLimits();
        applyCorePolicy();
        applySchedulerClock();
        seedTrayCounts();
      }
    });
    registerDownloadDomain(router, supervisor, settingsStore);
    registerMediaDomain(router, supervisor);
    registerTorrentDomain(router, supervisor);
    registerSchedulerDomain(router, supervisor);
    registerBrowserDataDomain(router, supervisor);
    registerAppDomain(router, supervisor, {
      showItemInFolder: (p) => shell.showItemInFolder(p),
      openPath: (p) => shell.openPath(p),
    });
    registerProxyDomain(router, proxyStore, supervisor, pushRuntimeProxies, settingsStore);
    registerToolkitDomain(router, toolkitManager, supervisor);
    registerAppDialogs(router, electronDirectoryPicker());

    // ---- Phase 17: OS notifications ----
    const notificationPort: OsNotificationPort = {
      supported: () => Notification.isSupported(),
      show: ({ title, body }) => {
        const n = new Notification({ title, body });
        n.on("click", () => focusShellWindow());
        n.show();
      },
    };
    registerNotifyEngine(router, { port: notificationPort, settings: settingsStore });

    // ---- Phase 17: tray icon (creation is guarded — without a live tray, close-to-tray
    // self-disables and closing keeps the Phase 2 quit behavior) ----
    try {
      const icon = nativeImage.createFromPath(paths.trayIcon);
      if (icon.isEmpty()) throw new Error(`tray icon missing: ${paths.trayIcon}`);
      const electronTray = new Tray(icon);
      const trayPort: TrayPort = {
        setTooltip: (text) => electronTray.setToolTip(text),
        setContextMenu: (items, onAction) => {
          electronTray.setContextMenu(
            Menu.buildFromTemplate(
              items.map((item) => {
                const action = item.id;
                return {
                  label: item.label,
                  enabled: item.enabled,
                  ...(action ? { click: () => onAction(action) } : {}),
                };
              }),
            ),
          );
        },
        onClick: (cb) => electronTray.on("click", () => cb()),
        destroy: () => electronTray.destroy(),
      };
      tray = new TrayController({
        port: trayPort,
        supervisor,
        onOpen: focusShellWindow,
        onQuit: () => {
          quitting = true;
          app.quit();
        },
      });
    } catch (err) {
      console.log(`[tray] unavailable (${err instanceof Error ? err.message : String(err)})`);
      tray = null;
    }

    // ---- Phase 18: auto-update channel ----
    // Feed: SYNTAXDM_UPDATE_FEED_URL (https) or the packaged resources/app-update.yml
    // (electron-builder, Phase 19). Unpackaged runs resolve to unavailable/not_packaged.
    const updateController = createElectronUpdater({
      isPackaged: app.isPackaged,
      envFeedUrl: process.env.SYNTAXDM_UPDATE_FEED_URL,
      resourcesAppUpdateYmlExists: existsSync(join(process.resourcesPath, "app-update.yml")),
      currentVersion: app.getVersion(),
      autoCheckEnabled: () => settingsStore.settings.updateAutoCheck,
      emit: (state) => router.emit("update.state", EVENTS["update.state"].payload, state),
      // Same teardown as a real quit, BEFORE the installer spawns — quitAndInstall may
      // not run before-quit on every electron-updater version, and the close-to-tray
      // handler must never hide the window during an install restart.
      onQuitForInstall: () => {
        quitting = true;
        tray?.destroy();
        tray = null;
        void supervisor.stop(4_000);
      },
    });
    registerUpdateDomain(router, updateController);
    updateController.startAutoChecks();

    supervisor.start();

    router.onEvent((name, payload) => {
      if (name === "settings.changed") {
        applyCoreLimits();
        applyCorePolicy();
      } else if (name === "download.updated") {
        const job = (payload as { job?: { id?: unknown; status?: unknown } } | null)?.job;
        if (job && typeof job.id === "string" && typeof job.status === "string") {
          trayStatuses.set(job.id, job.status);
          pushTrayCounts();
        }
      }
    });

    // Phase 10: fetch missing media tools at startup when the user allows it.
    if (settingsStore.settings.mediaToolsAutoFetch) {
      toolkitManager.ensureAll();
    }
    const policyTimer = setInterval(() => {
      applyCorePolicy();
      applySchedulerClock();
    }, 10 * 60 * 1000);
    app.on("before-quit", () => {
      clearInterval(policyTimer);
      updateController.stopAutoChecks();
    });

    app.on("before-quit", () => {
      // Quitting must never be intercepted by close-to-tray; tear the tray down first
      // so the icon does not linger after the process is gone.
      quitting = true;
      tray?.destroy();
      tray = null;
    });

    app.on("before-quit", () => {
      tabManager.destroyAll();
      // Persisting job state before teardown outranks a fast exit.
      void supervisor.stop(4_000);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(paths);
    });
  });

  // Phase 17: with close-to-tray the window hides instead of closing, so this only fires
  // on a real close (quit path or tray-less close) — the historical quit behavior stands.
  app.on("window-all-closed", () => {
    app.quit();
  });

}
