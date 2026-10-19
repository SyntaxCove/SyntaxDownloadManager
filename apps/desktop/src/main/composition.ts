import type { IpcRouter } from "./ipc/router.js";
import type { CoreSupervisor } from "./core/core-supervisor.js";
import type { BootClock } from "./perf/boot-clock.js";
import type { JsonlLogger } from "./logging/logger.js";
import type { ToolkitManager } from "./toolkit/manager.js";
import { pushToolkitPaths } from "./domains/toolkit.js";
import { buildSetPolicyPayload } from "./policy.js";
import { registerSettingsDomain, type SettingsStore } from "./domains/settings.js";
import { registerDownloadDomain } from "./domains/download.js";
import { registerMediaDomain } from "./domains/media.js";
import { registerTorrentDomain } from "./domains/torrent.js";
import { registerSchedulerDomain } from "./domains/scheduler.js";
import { registerBrowserDataDomain } from "./domains/browser-data.js";
import { registerAppDomain, type RevealShell } from "./domains/app-reveal.js";
import { registerAppDialogs, type DirectoryPicker } from "./domains/app-dialogs.js";
import { registerProxyDomain, type ProxyProfileStore } from "./domains/proxy.js";
import { registerToolkitDomain } from "./domains/toolkit.js";
import { registerNotifyEngine, type OsNotificationPort } from "./domains/notify.js";
import type { UpdateController } from "./domains/updates.js";
import { registerDiagnosticsDomain, type DiagnosticsDeps } from "./domains/diagnostics.js";
import { registerPerfDomain } from "./domains/perf.js";

/**
 * Phase 25: the shipped domain composition, extracted from `main.ts` so the E2E suites
 * (src/e2e) drive EXACTLY the registration surface the real app runs — not a hand-copied
 * twin that could silently drift. `main.ts` calls this once; the E2E harness calls the
 * same function with recording stubs at the Electron port boundaries.
 *
 * Registration order is the shipped order and is behavior-relevant only for
 * `handle()` duplicate detection; every registration here happens before the supervisor
 * starts and before any renderer can issue a request.
 */

export interface AppDomainsDeps {
  router: IpcRouter;
  supervisor: CoreSupervisor;
  settings: SettingsStore;
  proxyStore: ProxyProfileStore;
  toolkit: ToolkitManager;
  logger: JsonlLogger;
  bootClock: BootClock;
  /** Diagnostics embeds the updater snapshot; main passes the real controller. */
  updateController: Pick<UpdateController, "getState">;
  /** Re-push runtime proxy endpoints to the core (main owns the closure). */
  pushRuntimeProxies: () => void;
  /** app.revealEntry ports (Electron shell in production). */
  shell: RevealShell;
  /** Native directory picker port (Electron dialog in production). */
  directoryPicker: DirectoryPicker;
  /** OS notification port (Electron Notification in production). */
  notificationPort: OsNotificationPort;
  /** Process facts for the diagnostics health report. */
  appFacts: DiagnosticsDeps["appFacts"];
  /** RPC timeout for the core health snapshot (small). */
  coreHealthTimeoutMs?: number;
}

export function registerAppDomains(deps: AppDomainsDeps): void {
  const {
    router,
    supervisor,
    settings,
    proxyStore,
    toolkit,
    logger,
    bootClock,
    updateController,
    pushRuntimeProxies,
    shell,
    directoryPicker,
    notificationPort,
    appFacts,
    coreHealthTimeoutMs,
  } = deps;

  registerSettingsDomain(router, settings);
  registerDownloadDomain(router, supervisor, settings);
  registerMediaDomain(router, supervisor);
  registerTorrentDomain(router, supervisor);
  registerSchedulerDomain(router, supervisor);
  registerBrowserDataDomain(router, supervisor);
  registerAppDomain(router, supervisor, shell);
  registerProxyDomain(router, proxyStore, supervisor, pushRuntimeProxies, settings);
  registerToolkitDomain(router, toolkit, supervisor);
  registerAppDialogs(router, directoryPicker);
  registerNotifyEngine(router, { port: notificationPort, settings });
  registerDiagnosticsDomain(router, {
    logger,
    supervisor,
    settings,
    toolkit,
    updater: updateController,
    appFacts,
    ...(coreHealthTimeoutMs !== undefined ? { coreHealthTimeoutMs } : {}),
  });
  registerPerfDomain(router, { supervisor, bootClock, logger });
}

/**
 * Re-push EVERYTHING the (re)started core starts without: runtime proxy endpoints,
 * verified toolkit paths, concurrency limits, engine policy and the scheduler clock.
 * Main runs this on every `ready` transition; the E2E harness runs the identical
 * function so a restarted core in tests behaves exactly like production. All pushes
 * are idempotent and fire-and-forget (a push lost during a crash is re-pushed on the
 * next ready transition).
 */
export function pushCoreRuntimeState(deps: {
  supervisor: CoreSupervisor;
  settings: SettingsStore;
  toolkit: ToolkitManager;
  pushRuntimeProxies: () => void;
}): void {
  const { supervisor, settings, toolkit, pushRuntimeProxies } = deps;
  pushRuntimeProxies();
  pushToolkitPaths(supervisor, toolkit.readyToolPaths());
  void supervisor
    .request("download.setConcurrency", {
      max: settings.settings.concurrentDownloads,
      maxConnectionsPerDownload: settings.settings.maxConnectionsPerDownload,
    })
    .catch(() => undefined); // core not ready yet — the ready handler re-applies
  void supervisor
    .request("download.setPolicy", buildSetPolicyPayload(settings.settings))
    .catch(() => undefined); // core not ready yet — the ready handler re-applies
  void supervisor
    .request("scheduler.setClock", { tzOffsetMinutes: -new Date().getTimezoneOffset() })
    .catch(() => undefined); // core not ready yet — the ready handler re-applies
}
