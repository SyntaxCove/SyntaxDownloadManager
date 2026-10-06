import { BrowserWindow, shell } from "electron";
import type { AppPaths } from "./paths.js";
import { blockNewWindows, denyByDefaultPermissions, RENDERER_CSP, secureWebPreferences, willNavigateGuard } from "./security.js";

export interface MainWindowHandle {
  readonly window: BrowserWindow;
}

/**
 * Creates the shell window. Chrome (titlebar overlay, min size) targets Windows 11 but stays
 * usable on Linux/macOS for development. Browser tabs (Phase 4) are WebContentsViews attached
 * to this window — the shell window itself only ever shows our renderer.
 */
export function createMainWindow(paths: AppPaths, minShellSize = { width: 360, height: 240 }): MainWindowHandle {
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
  blockNewWindows(win);
  // Electron 44: permission handlers live on the session.
  win.webContents.session.setPermissionRequestHandler(denyByDefaultPermissions());
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
  // Links/target=_blank from the shell UI open in the OS browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (paths.devServerUrl) {
    void win.loadURL(paths.devServerUrl);
  } else {
    void win.loadFile(paths.rendererIndex);
  }
  return { window: win };
}
