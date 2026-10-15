import { isAbsolute, resolve } from "node:path";

/**
 * Path resolution for main-process assets. Keeping this pure makes the dev/prod split testable.
 */

export interface AppPaths {
  readonly rendererIndex: string;
  readonly preloadScript: string;
  readonly devServerUrl: string | null;
  /** Pinned media-tool manifest (Phase 10): dev = apps/desktop/resources, packaged = resourcesPath. */
  readonly toolchainsManifest: string;
  /** Tray icon (Phase 17): dev = apps/desktop/resources/icons, packaged = resourcesPath. */
  readonly trayIcon: string;
}

/**
 * dev:  SYNTAXDM_DEV_SERVER_URL (set by the dev launcher) wins; renderer loads from Vite.
 * prod: files relative to app root (apps/desktop) — dist/renderer/index.html and
 *       dist/preload/preload.cjs (bundled CJS because sandboxed preloads cannot require
 *       arbitrary modules).
 */
export function resolveAppPaths(opts: {
  appRoot: string;
  isPackaged: boolean;
  envDevServerUrl?: string;
}): AppPaths {
  const toolchainsManifest = opts.isPackaged
    ? resolve(opts.appRoot, "toolchains.json")
    : resolve(opts.appRoot, "resources/toolchains.json");
  const trayIcon = opts.isPackaged
    ? resolve(opts.appRoot, "syntaxdm-tray.png")
    : resolve(opts.appRoot, "resources/icons/syntaxdm-tray.png");
  const devServerUrl = opts.envDevServerUrl?.trim() ? opts.envDevServerUrl.trim() : null;
  if (devServerUrl) {
    return {
      rendererIndex: "",
      preloadScript: resolve(opts.appRoot, "dist/preload/preload.cjs"),
      devServerUrl,
      toolchainsManifest,
      trayIcon,
    };
  }
  return {
    rendererIndex: resolve(opts.appRoot, "dist/renderer/index.html"),
    preloadScript: resolve(opts.appRoot, "dist/preload/preload.cjs"),
    devServerUrl: null,
    toolchainsManifest,
    trayIcon,
  };
}

/** Only load renderer content from our own dist (prod) or the dev server (dev). */
export function isAllowedRendererSource(paths: AppPaths, url: string): boolean {
  if (paths.devServerUrl && url.startsWith(paths.devServerUrl)) return true;
  if (!isAbsolute(url) && url.startsWith("file://")) return url.startsWith("file://");
  return false;
}
