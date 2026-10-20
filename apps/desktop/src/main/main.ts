import { app, BrowserWindow, Menu, Notification, nativeImage, safeStorage, Tray, shell } from "electron";
import { existsSync } from "node:fs";
import { release as osRelease } from "node:os";
import { resolve, join } from "node:path";
import { EVENTS } from "@syntaxdm/contracts";
import { IpcRouter } from "./ipc/router.js";
import { bindElectronRpc } from "./ipc/electron-rpc.js";
import { createMainWindow, type RendererDiagnostic } from "./window.js";
import { resolveAppPaths } from "./paths.js";
import { SettingsStore } from "./domains/settings.js";
import { registerBrowserDomain } from "./domains/browser.js";
import { ProxyProfileStore } from "./domains/proxy.js";
import { pushToolkitPaths } from "./domains/toolkit.js";
import { electronDirectoryPicker } from "./domains/app-dialogs.js";
import type { OsNotificationPort } from "./domains/notify.js";
import { createElectronUpdater } from "./domains/updates-adapter.js";
import { registerUpdateDomain } from "./domains/updates.js";
import { registerAppDomains, pushCoreRuntimeState } from "./composition.js";
import { BootClock } from "./perf/boot-clock.js";
import { budgetReportSourceLabel, rendererAssetsDirUnder } from "./perf/report-env.js";
import {
  TrayController,
  countsFromStatuses,
  shouldHideOnClose,
  type TrayPort,
} from "./domains/tray.js";
import { ToolkitManager } from "./toolkit/manager.js";
import { buildSetPolicyPayload } from "./policy.js";
import { CoreSupervisor, resolveCoreBinaryPath } from "./core/core-supervisor.js";
import { JsonlLogger } from "./logging/logger.js";
import { parseCoreStderrLine } from "./logging/core-stderr.js";
import type { LogLevel } from "@syntaxdm/contracts";

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

  // Phase 23 (F-E): global safety net — the product never uses <webview>, so attachment is
  // denied on every webContents we ever create, including any created by future code paths.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });

  // Phase 22: the boot clock starts at the earliest observable point of the entry module —
  // mark() is called at lifecycle points that already exist below (zero behavior change).
  const bootClock = new BootClock();
  bootClock.mark("main-modules-evaluated");

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
    bootClock.mark("app-ready");
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

    // ---- Phase 20: the structured log pipeline starts FIRST — everything after this
    // line (settings load, core supervision, IPC) is observable in the ring and on disk.
    const logsDir = join(app.getPath("userData"), "logs");
    const logger = new JsonlLogger({ dir: logsDir });
    const envLevel = process.env.SYNTAXDM_LOG_LEVEL?.trim();
    const initialLevel: LogLevel =
      envLevel && ["debug", "info", "warn", "error"].includes(envLevel)
        ? (envLevel as LogLevel)
        : "info";
    logger.setLevel(initialLevel);
    logger.info("main", `app starting (v${app.getVersion()}, electron ${process.versions.electron})`, {
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("main", `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    app.on("child-process-gone", (_e, details) => {
      logger.error("main", `child process gone: ${details.type} ${details.reason}`, {
        exitCode: details.exitCode,
      });
    });

    const router = new IpcRouter((msg) => logger.info("ipc", msg));

    const settingsStore = new SettingsStore(app.getPath("userData"));
    await settingsStore.load();
    // verboseLogging (Phase 20): the setting only RATCHETS up above the env baseline
    // when enabled; disabling returns to the env/default level. Live for the main logger.
    const applyLogLevel = (): void => {
      logger.setLevel(settingsStore.settings.verboseLogging ? "debug" : initialLevel);
    };
    applyLogLevel();

    // Phase 9: proxy profiles — keychain-backed secrets, redacted to the renderer.
    const proxyStore = new ProxyProfileStore(app.getPath("userData"), safeStorage);
    await proxyStore.load();

    bindElectronRpc(router, () => BrowserWindow.getAllWindows(), {
      rendererIndexFile: paths.rendererIndex,
    });

    createMainWindow(paths, { width: 360, height: 240 }, (d: RendererDiagnostic) => {
      logger.error("renderer", d.msg, d.data);
    });
    bootClock.mark("window-created");

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
      log: (msg) => logger.info("supervisor", msg),
      // Phase 20: core stderr (tracing JSON) → structured records. This consumer also
      // keeps the OS pipe drained — without it a chatty core would deadlock on write.
      onStderrLine: (line) => {
        const record = parseCoreStderrLine(line, Date.now());
        if (record) logger.log(record.level, record.component, record.msg, record.data);
      },
      verboseCoreLogging: settingsStore.settings.verboseLogging,
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
    // Post-1.0: apply the persisted user-agent override before the first tab can exist,
    // so even the very first browser session is created with the right UA.
    tabManager.setUserAgent(settingsStore.settings.browserUserAgent || null);

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

    // Phase 22: log the finished boot report ONCE per session (flag set below).
    let bootReportLogged = false;

    supervisor.on("state", (status: string) => {
      // Broadcast lifecycle to every renderer (downloads page shows a banner).
      router.emit("core.state", EVENTS["core.state"].payload, { status });
      // A (re)started core starts with empty runtime maps and default policy — re-push
      // EVERYTHING after ready (Phase 16: this previously missed setConcurrency entirely
      // and left policy/clock to heal within the 10-minute timer; a restarted core now
      // gets the full settings immediately. All pushes are idempotent).
      if (status === "ready") {
        bootClock.mark("core-ready");
        pushCoreRuntimeState({ supervisor, settings: settingsStore, toolkit: toolkitManager, pushRuntimeProxies });
        seedTrayCounts();
        // Phase 22: log the finished boot report ONCE per session — real device numbers
        // reach the log pipeline, the diagnostics tail, and every exported zip.
        if (!bootReportLogged) {
          bootReportLogged = true;
          logger.info("perf", "boot timing report", bootClock.report());
        }
      }
    });
    // ---- Phase 17: OS notifications ----
    const notificationPort: OsNotificationPort = {
      supported: () => Notification.isSupported(),
      show: ({ title, body }) => {
        const n = new Notification({ title, body });
        n.on("click", () => focusShellWindow());
        n.show();
      },
    };

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
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn("tray", `tray unavailable: ${detail}`);
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

    // ---- Phase 25: the shipped domain composition (settings, download, media, torrent,
    // scheduler, browser-data, app-reveal, proxy, toolkit, dialogs, notify, diagnostics,
    // perf) — extracted so the E2E suites drive the exact same registration surface.
    registerAppDomains({
      router,
      supervisor,
      settings: settingsStore,
      proxyStore,
      toolkit: toolkitManager,
      logger,
      bootClock,
      updateController,
      pushRuntimeProxies,
      shell: {
        showItemInFolder: (p) => shell.showItemInFolder(p),
        openPath: (p) => shell.openPath(p),
      },
      directoryPicker: electronDirectoryPicker(),
      notificationPort,
      appFacts: {
        version: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown",
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptimeMs: () => Math.round(process.uptime() * 1000),
        memoryRssBytes: () => process.memoryUsage().rss,
      },
      perfReport: {
        budgetsFile: paths.perfBudgets,
        bootClock,
        supervisor,
        appVersion: app.getVersion(),
        platform: process.platform,
        osRelease: osRelease(),
        source: budgetReportSourceLabel(app.isPackaged),
        rendererAssetsDir: rendererAssetsDirUnder(appRoot),
        logger,
      },
      coreHealthTimeoutMs: 3_000,
    });
    registerUpdateDomain(router, updateController);
    updateController.startAutoChecks();

    supervisor.start();
    bootClock.mark("core-spawned");

    router.onEvent((name, payload) => {
      if (name === "settings.changed") {
        applyCoreLimits();
        applyCorePolicy();
        applyLogLevel();
        // Post-1.0: live user-agent application — new loads in every open tab pick it up.
        tabManager.setUserAgent(settingsStore.settings.browserUserAgent || null);
        // verbose logging reaches the core at its next (re)launch — env at spawn.
        supervisor.setVerboseCoreLogging(settingsStore.settings.verboseLogging);
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
