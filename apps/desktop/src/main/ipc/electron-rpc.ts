import { ipcMain, session } from "electron";
import type { BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";
import { IpcRouter } from "./router.js";
import { SyntaxDmError } from "@syntaxdm/contracts";

/** Single channel namespace — keeps the preload surface auditable. */
export const RPC_CHANNEL = "syntaxdm.rpc";
export const EVENT_CHANNEL = "syntaxdm.event";

/**
 * Binds the transport-agnostic IpcRouter to Electron IPC:
 *  - renderer → main: ipcMain.handle(RPC_CHANNEL) with sender verification;
 *  - main → renderer: every router event is broadcast to all live shell windows.
 *
 * Sender verification (Phase 23 hardened, F-B) — ALL of the following must hold:
 *  1. *Session identity*: the sender runs on the default session. Browser tabs live on
 *     `persist:browser` / `persist:proxy.*` sessions and never get the preload bridge;
 *     this makes that a hard fact instead of an accident of preload plumbing.
 *  2. *Packaged-origin exactness*: in prod the frame URL must equal the app's own
 *     renderer index (hash tolerated, stripped on both sides) — not merely contain it.
 *     When the packaged index path is unknown (legacy callers/tests), the narrower
 *     dist-renderer substring check is kept as a fallback.
 *  3. In dev the configured dev-server origin is accepted instead.
 * This is the IPC-boundary firewall — untrusted pages live in Phase 4 WebContentsViews
 * and never get the preload bridge.
 */
export function bindElectronRpc(
  router: IpcRouter,
  getWindow: () => BrowserWindow[],
  opts?: { rendererIndexFile?: string },
): void {
  ipcMain.removeHandler(RPC_CHANNEL);
  ipcMain.handle(RPC_CHANNEL, async (event, raw: unknown) => {
    const trusted = isTrustedRpcSender({
      frameUrl: event.senderFrame?.url ?? "",
      sessionIsDefault: event.sender.session === session.defaultSession,
      expectedFileUrl: opts?.rendererIndexFile ? pathToFileURL(opts.rendererIndexFile).href : null,
      devServerUrl: process.env.SYNTAXDM_DEV_SERVER_URL ?? null,
    });
    if (!trusted) {
      // Refuse without echoing details into the untrusted frame.
      throw new SyntaxDmError("invalid_params", "untrusted sender");
    }
    return router.handleRequest(raw, { senderId: event.sender.id });
  });

  router.onEvent((name, payload) => {
    for (const win of getWindow()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, { v: 1, event: name, payload });
    }
  });
}

/** Pure decision core of the sender firewall — fully unit-testable without Electron. */
export function isTrustedRpcSender(args: {
  frameUrl: string;
  sessionIsDefault: boolean;
  /** pathToFileURL(rendererIndex).href when the packaged layout is known, else null. */
  expectedFileUrl: string | null;
  devServerUrl: string | null;
}): boolean {
  if (!args.sessionIsDefault) return false;
  if (args.devServerUrl && args.frameUrl.startsWith(args.devServerUrl)) return true;
  if (args.expectedFileUrl) {
    return stripHash(args.frameUrl) === stripHash(args.expectedFileUrl);
  }
  // Legacy fallback: packaged index unknown — keep the dist-renderer containment check.
  return args.frameUrl.startsWith("file://") && args.frameUrl.includes("/dist/renderer/index.html");
}

function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Legacy frame-URL-only check kept for existing callers/tests. Production trust now
 * flows through `isTrustedRpcSender` (session identity + exact packaged origin).
 */
export function isTrustedSender(frameUrl: string): boolean {
  return isTrustedRpcSender({
    frameUrl,
    sessionIsDefault: true,
    expectedFileUrl: null,
    devServerUrl: process.env.SYNTAXDM_DEV_SERVER_URL ?? null,
  });
}
