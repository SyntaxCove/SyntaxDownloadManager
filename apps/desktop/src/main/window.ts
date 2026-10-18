import { BrowserWindow, shell } from "electron";
import type { AppPaths } from "./paths.js";
import { blockNewWindows, denyByDefaultChecks, denyByDefaultPermissions, isWebUrl, RENDERER_CSP, secureWebPreferences, willNavigateGuard } from "./security.js";

export interface MainWindowHandle {
  readonly window: BrowserWindow;
}

/** Renderer-side diagnostic surfaces forwarded to the main logger (Phase 20). */
export interface RendererDiagnostic {
  kind: "console-error" | "render-gone";
  msg: string;
  data?: unknown;
}

/**
 * Creates the shell window. Chrome (titlebar overlay, min size) targets Windows 11 but stays
 * usable on Linux/macOS for development. Browser tabs (Phase 4) are WebContentsViews attached
 * to this window — the shell window itself only ever shows our renderer.
 */
export function createMainWindow(
  paths: AppPaths,
  minShellSize = { width: 360, height: 240 },
  /** Phase 20: forwards renderer console errors + crash events to the main logger. */
  onDiagnostic?: (d: RendererDiagnostic) => void,
): MainWindowHandle {
  const useOverlay = process.platform === "win32";
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: minShellSize.width,
    minHeight: minShellSize.height,
    show: false,
    backgroundColor: "#202020",
    titleBarStyle: useOverlay ? "hidden" : "default",
    titleBarOverlay: useOverlay ? { color: "#202020", symbolColor: "#ffffff", height: 40 } : false,
    webPreferences: secureWebPreferences({ preloadScript: paths.preloadScript, devServerUrl: paths.devServerUrl }),
  });

  win.once("ready-to-show", () => win.show());
  // Phase 20: renderer error visibility. Only console *errors* are forwarded (info/warn
  // noise would dominate the log); a gone renderer is always recorded, whatever its reason.
  if (onDiagnostic) {
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 3) {
        onDiagnostic({
          kind: "console-error",
          msg: message.slice(0, 2000),
          data: { line, source: sourceId.slice(0, 200) },
        });
      }
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      onDiagnostic({
        kind: "render-gone",
        msg: `renderer process gone: ${details.reason}`,
        data: { exitCode: details.exitCode },
      });
    });
  }
  blockNewWindows(win);
  // Electron 44: permission handlers live on the session.
  win.webContents.session.setPermissionRequestHandler(denyByDefaultPermissions());
  // Phase 23 (F-C): deny the synchronous permission-check path too (clipboard probes, …).
  win.webContents.session.setPermissionCheckHandler(denyByDefaultChecks());
  win.webContents.on("will-navigate", (details, url) =>
    willNavigateGuard(() => ({ devServerUrl: paths.devServerUrl }))(details, url),
  );
  // Hard CSP header in addition to the index.html meta tag.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith("file://")) {
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [RENDERER_CSP] } });
    } else {
      callback({});
    }
  });
  // Links/target=_blank from the shell UI open in the OS browser — but only http/https
  // (Phase 23 F-A): file:/custom-scheme handoffs to the OS are dropped, never forwarded.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (paths.devServerUrl) {
    void win.loadURL(paths.devServerUrl);
  } else {
    void win.loadFile(paths.rendererIndex);
  }
  return { window: win };
}
