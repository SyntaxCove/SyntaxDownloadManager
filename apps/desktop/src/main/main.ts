import { app, BrowserWindow, safeStorage } from "electron";
import { resolve, join } from "node:path";
import { EVENTS } from "@unidm/contracts";
import { IpcRouter } from "./ipc/router.js";
import { bindElectronRpc } from "./ipc/electron-rpc.js";
import { createMainWindow } from "./window.js";
import { resolveAppPaths } from "./paths.js";
import { SettingsStore, registerSettingsDomain } from "./domains/settings.js";
import { registerBrowserDomain } from "./domains/browser.js";
import { registerDownloadDomain } from "./domains/download.js";
import { registerMediaDomain } from "./domains/media.js";
import { ProxyProfileStore, registerProxyDomain } from "./domains/proxy.js";
import { registerToolkitDomain, pushToolkitPaths } from "./domains/toolkit.js";
import { ToolkitManager } from "./toolkit/manager.js";
import { buildSetPolicyPayload } from "./policy.js";
import { CoreSupervisor, resolveCoreBinaryPath } from "./core/core-supervisor.js";

/**
 * UniDM entry point. Lifecycle:
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
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    const appRoot = app.isPackaged ? process.resourcesPath : resolve(__dirname, "../..");
    const paths = resolveAppPaths({
      appRoot,
      isPackaged: app.isPackaged,
      envDevServerUrl: process.env.UNIDM_DEV_SERVER_URL,
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

    const mainWindow = () => BrowserWindow.getAllWindows()[0];
    const tabManager = registerBrowserDomain(router, mainWindow, {
      resolveProxy: (id) => proxyStore.resolveForTab(id),
      hasProfile: (id) => proxyStore.has(id),
    });

    // Rust download core: supervised subprocess owning the SQLite database.
    const supervisor = new CoreSupervisor({
      binaryPath: resolveCoreBinaryPath({ appRoot, isPackaged: app.isPackaged, envOverride: process.env.UNIDM_CORE_BIN }),
      dbPath: join(app.getPath("userData"), "downloads.db"),
      maxConcurrent: settingsStore.settings.concurrentDownloads,
      maxConnectionsPerDownload: settingsStore.settings.maxConnectionsPerDownload,
      log: (msg) => console.log(msg),
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

    supervisor.on("state", (status: string) => {
      // Broadcast lifecycle to every renderer (downloads page shows a banner).
      router.emit("core.state", EVENTS["core.state"].payload, { status });
      // A (re)started core starts with empty runtime maps — re-push after ready.
      if (status === "ready") {
        pushRuntimeProxies();
        pushToolkitPaths(supervisor, toolkitManager.readyToolPaths());
      }
    });
    registerDownloadDomain(router, supervisor);
    registerMediaDomain(router, supervisor);
    registerProxyDomain(router, proxyStore, supervisor, pushRuntimeProxies);
    registerToolkitDomain(router, toolkitManager, supervisor);
    supervisor.start();

    // Push the concurrency settings to the core at startup and re-apply whenever the
    // user changes them (the core clamps and applies both live).
    const applyCoreLimits = (): void => {
      const { concurrentDownloads, maxConnectionsPerDownload } = settingsStore.settings;
      void supervisor
        .request("download.setConcurrency", {
          max: concurrentDownloads,
          maxConnectionsPerDownload,
        })
        .catch(() => undefined); // core not ready yet — env defaults already cover it
    };

    // Phase 8: engine operating policy — auto-start, daily download window, global
    // bandwidth. Re-applied on settings changes AND every 10 minutes so the core's
    // clock stays aligned with the user's local time (DST / travel drift guard).
    const applyCorePolicy = (): void => {
      void supervisor
        .request("download.setPolicy", buildSetPolicyPayload(settingsStore.settings))
        .catch(() => undefined); // core not ready yet — retried by the timer
    };

    supervisor
      .whenReady()
      .then(() => {
        applyCoreLimits();
        applyCorePolicy();
        pushRuntimeProxies();
      })
      .catch(() => undefined);
    router.onEvent((name) => {
      if (name === "settings.changed") {
        applyCoreLimits();
        applyCorePolicy();
      }
    });

    // Phase 10: fetch missing media tools at startup when the user allows it.
    if (settingsStore.settings.mediaToolsAutoFetch) {
      toolkitManager.ensureAll();
    }
    const policyTimer = setInterval(applyCorePolicy, 10 * 60 * 1000);
    app.on("before-quit", () => clearInterval(policyTimer));

    app.on("before-quit", () => {
      tabManager.destroyAll();
      // Persisting job state before teardown outranks a fast exit.
      void supervisor.stop(4_000);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(paths);
    });
  });

  // Desktop app convention: close-to-quit (tray minimize is a later phase decision, Phase 17).
  app.on("window-all-closed", () => {
    app.quit();
  });

}
