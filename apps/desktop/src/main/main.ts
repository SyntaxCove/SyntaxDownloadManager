import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { IpcRouter } from "./ipc/router.js";
import { bindElectronRpc } from "./ipc/electron-rpc.js";
import { createMainWindow } from "./window.js";
import { resolveAppPaths } from "./paths.js";

/**
 * UniDM entry point. Lifecycle:
 *  1. single-instance lock (second launch focuses the existing window);
 *  2. renderer process sandbox enabled process-wide before `ready`;
 *  3. shell window + typed IPC router bound to Electron.
 *
 * Feature domains register their methods on the same router in their own phases:
 * settings (Phase 3), browser tabs (Phase 4), downloads via the Rust core (Phase 5+).
 * The Rust core is NOT spawned here yet — Phase 5 introduces the supervisor behind the same
 * router surface (`download.*` methods), so this wiring never changes shape again.
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

  app.whenReady().then(() => {
    const appRoot = app.isPackaged ? process.resourcesPath : resolve(__dirname, "../..");
    const paths = resolveAppPaths({
      appRoot,
      isPackaged: app.isPackaged,
      envDevServerUrl: process.env.UNIDM_DEV_SERVER_URL,
    });

    const router = new IpcRouter((msg) => console.log(msg));
    bindElectronRpc(router, () => BrowserWindow.getAllWindows());

    createMainWindow(paths);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(paths);
    });
  });

  // Desktop app convention: close-to-quit (tray minimize is a later phase decision, Phase 17).
  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    // Phase 5 will append core shutdown (SIGTERM → SIGKILL escalation) here.
  });
}
