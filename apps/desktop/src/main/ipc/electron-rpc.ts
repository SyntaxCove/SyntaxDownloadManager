import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { IpcRouter } from "./router.js";
import { UniDmError } from "@unidm/contracts";

/** Single channel namespace — keeps the preload surface auditable. */
export const RPC_CHANNEL = "unidm.rpc";
export const EVENT_CHANNEL = "unidm.event";

/**
 * Binds the transport-agnostic IpcRouter to Electron IPC:
 *  - renderer → main: ipcMain.handle(RPC_CHANNEL) with sender verification;
 *  - main → renderer: every router event is broadcast to all live shell windows.
 *
 * Sender verification: only our own top frame (renderer built by Vite) may call RPC. This is
 * the IPC-boundary firewall — untrusted pages live in Phase 4 WebContentsViews and never get
 * the preload bridge.
 */
export function bindElectronRpc(router: IpcRouter, getWindow: () => BrowserWindow[]): void {
  ipcMain.removeHandler(RPC_CHANNEL);
  ipcMain.handle(RPC_CHANNEL, async (event, raw: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? "")) {
      // Refuse without echoing details into the untrusted frame.
      throw new UniDmError("invalid_params", "untrusted sender");
    }
    return router.handleRequest(raw, { senderId: event.sender.id });
  });

  router.onEvent((name, payload) => {
    for (const win of getWindow()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, { v: 1, event: name, payload });
    }
  });
}

export function isTrustedSender(frameUrl: string): boolean {
  if (frameUrl.startsWith("file://") && frameUrl.includes("/dist/renderer/index.html")) return true;
  const dev = process.env.UNIDM_DEV_SERVER_URL;
  if (dev && frameUrl.startsWith(dev)) return true;
  return false;
}
