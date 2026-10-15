import { dialog, BrowserWindow } from "electron";
import { METHODS } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";

/**
 * App dialogs domain (Phase 16) — the native directory picker deferred from Phase 3.
 *
 * The renderer gets ONLY the user's choice: a modal open dialog parented to the shell
 * window. It never receives a handle to open arbitrary dialogs itself, and `path: null`
 * (user cancel) is a valid result, never an error.
 */

/** Injectable slice of Electron's dialog surface. */
export interface DirectoryPicker {
  pick(): Promise<string | null>;
}

/** Electron-backed picker: openDirectory (+ createDirectory where the platform shows it). */
export function electronDirectoryPicker(): DirectoryPicker {
  return {
    async pick(): Promise<string | null> {
      const options: Electron.OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
      };
      const focused = BrowserWindow.getAllWindows()[0];
      const result = focused
        ? await dialog.showOpenDialog(focused, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    },
  };
}

/** Registers app.pickDirectory on the router (contract schemas enforced). */
export function registerAppDialogs(router: IpcRouter, picker: DirectoryPicker): void {
  const entry = METHODS["app.pickDirectory"];
  router.handle("app.pickDirectory", {
    paramsSchema: entry.params,
    resultSchema: entry.result,
    handler: async () => ({ path: await picker.pick() }),
  });
}
