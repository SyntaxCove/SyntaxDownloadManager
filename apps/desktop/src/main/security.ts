import type { BrowserWindow } from "electron";

/**
 * Security baseline (specs: security ranks second only to data integrity).
 * Every value here is code-reviewed material — do not relax without a phase report entry.
 */

export interface SecureWindowOptions {
  readonly preloadScript: string;
  /** Dev server origin when developing, otherwise null. */
  readonly devServerUrl: string | null;
}

/** webPreferences applied to every window we create. Sandbox stays ON. */
export function secureWebPreferences(opts: SecureWindowOptions) {
  return {
    preload: opts.preloadScript,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    experimentalFeatures: false,
    enableBlinkFeatures: "",
    spellcheck: false,
  } as const;
}

/**
 * `will-navigate` guard: the shell window may only navigate within our own sources (dev server
 * in dev; nothing else in prod — startup loadFile handles the initial page). External targets
 * opened by the *browser tab system* (Phase 4) live in dedicated WebContentsViews with their own
 * policy — never in the shell window itself.
 */
export function willNavigateGuard(getAllowed: () => { devServerUrl: string | null }) {
  return (event: { preventDefault(): void }, url: string): void => {
    const allowed = getAllowed();
    if (allowed.devServerUrl && url.startsWith(allowed.devServerUrl)) return;
    // prod: any will-navigate attempt on the shell window is denied by default.
    event.preventDefault();
  };
}

/**
 * Permission handler: deny-by-default. Features the browser (Phase 4) legitimately needs are
 * granted per-tab by explicit policy later; everything else stays denied in the shell window.
 */
export function denyByDefaultPermissions() {
  // none granted in the shell window; browser tabs configure their own policy in Phase 4.
  return (_wc: unknown, _permission: string, callback: (granted: boolean) => void, _details?: unknown) => {
    callback(false);
  };
}

/** Applied to all new windows; we never spawn `window.open` popups from the shell. */
export function blockNewWindows(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Content-Security-Policy delivered as an onLoadInjected header — belt and braces with index.html. */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ipc: http://ipc.localhost",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
