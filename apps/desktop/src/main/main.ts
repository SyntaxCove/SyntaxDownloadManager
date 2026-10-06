import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { IpcRouter } from "./ipc/router.js";
import { bindElectronRpc } from "./ipc/electron-rpc.js";
import { createMainWindow } from "./window.js";
import { resolveAppPaths } from "./paths.js";
import { SettingsStore, registerSettingsDomain } from "./domains/settings.js";
import { registerBrowserDomain } from "./domains/browser.js";

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

    bindElectronRpc(router, () => BrowserWindow.getAllWindows());

    createMainWindow(paths);

    const mainWindow = () => BrowserWindow.getAllWindows()[0];
    const tabManager = registerBrowserDomain(router, mainWindow);
    app.on("before-quit", () => {
      tabManager.destroyAll();
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
