import { autoUpdater } from "electron-updater";
import type { UpdateState } from "@unidm/contracts";
import { UniDmError } from "@unidm/contracts";
import { resolveUpdateFeed, UpdateController, type UpdatePort } from "./updates.js";

/**
 * Phase 18: the thin electron-updater adapter — main-runtime glue, deliberately untested
 * (every decision lives in the tested UpdateController; this file only translates
 * electron-updater's events and API into the port/callback shape).
 *
 * electron-updater configuration:
 *  - autoDownload=false  — a check NEVER downloads (consent point #2 is update.download);
 *  - autoInstallOnAppQuit=true — a downloaded update applies on the next real quit
 *    (surfaced honestly in the Settings copy);
 *  - allowDowngrade=false, disableWebInstaller=true — no surprise rollbacks, no
 *    interactive fallback page;
 *  - feed: env override via setFeedURL (https-validated in resolveUpdateFeed) or the
 *    packaged resources/app-update.yml electron-builder generates (Phase 19).
 */

export interface UpdateAdapterOptions {
  readonly isPackaged: boolean;
  readonly envFeedUrl: string | undefined | null;
  readonly resourcesAppUpdateYmlExists: boolean;
  readonly currentVersion: string;
  readonly autoCheckEnabled: () => boolean;
  readonly emit: (state: UpdateState) => void;
  readonly onQuitForInstall: () => void;
}

interface UpdaterInfoLike {
  version?: unknown;
  releaseDate?: unknown;
  releaseNotes?: unknown;
}

interface UpdaterProgressLike {
  percent?: unknown;
  transferred?: unknown;
  total?: unknown;
  bytesPerSecond?: unknown;
}

function asInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

export function createElectronUpdater(options: UpdateAdapterOptions): UpdateController {
  const feed = resolveUpdateFeed({
    isPackaged: options.isPackaged,
    envFeedUrl: options.envFeedUrl,
    resourcesAppUpdateYmlExists: options.resourcesAppUpdateYmlExists,
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  // electron-updater logs are verbose; route them through the app's prefixed console.
  autoUpdater.logger = {
    info: (m) => console.log(`[update] ${String(m)}`),
    warn: (m) => console.log(`[update] warn: ${String(m)}`),
    error: (m) => console.log(`[update] error: ${String(m)}`),
    debug: (m) => console.log(`[update] debug: ${String(m)}`),
  };

  if (feed.kind === "env") {
    autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
  }
  // feed.kind === "app-update": the packaged app-update.yml IS the configuration —
  // electron-updater reads it from resources/ on its own.

  const port: UpdatePort =
    feed.kind === "env" || feed.kind === "app-update"
      ? {
          check: () => {
            void autoUpdater.checkForUpdates();
          },
          download: () => {
            void autoUpdater.downloadUpdate();
          },
          install: () => {
            autoUpdater.quitAndInstall(false, true);
          },
        }
      : // Defense in depth: the controller's guards make this unreachable; if a guard
        // ever regresses, the failure is a classified UniDmError, not a mystery call.
        {
          check: () => {
            throw new UniDmError("invalid_state", "updater has no feed configured");
          },
          download: () => {
            throw new UniDmError("invalid_state", "updater has no feed configured");
          },
          install: () => {
            throw new UniDmError("invalid_state", "updater has no feed configured");
          },
        };

  const controller = new UpdateController({
    port,
    feed,
    currentVersion: options.currentVersion,
    emit: options.emit,
    onQuitForInstall: options.onQuitForInstall,
    autoCheckEnabled: options.autoCheckEnabled,
  });

  autoUpdater.on("checking-for-update", () => controller.onChecking());
  autoUpdater.on("update-available", (info) => {
    const i = info as UpdaterInfoLike;
    controller.onAvailable({
      version: typeof i.version === "string" ? i.version : "",
      releaseDate: i.releaseDate,
      releaseNotes: i.releaseNotes,
    });
  });
  autoUpdater.on("update-not-available", () => controller.onNotAvailable());
  autoUpdater.on("download-progress", (progress) => {
    const p = progress as UpdaterProgressLike;
    controller.onProgress({
      percent: typeof p.percent === "number" && Number.isFinite(p.percent) ? Math.min(100, Math.max(0, p.percent)) : 0,
      transferredBytes: asInt(p.transferred),
      totalBytes: typeof p.total === "number" && Number.isFinite(p.total) ? asInt(p.total) : null,
      bytesPerSecond: asInt(p.bytesPerSecond),
    });
  });
  autoUpdater.on("update-downloaded", () => controller.onDownloaded());
  autoUpdater.on("error", (err) => controller.onUpdaterError(err));

  return controller;
}
