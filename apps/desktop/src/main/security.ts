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

/**
 * Phase 23 (F-A): OS handoffs are http/https only. `shell.openExternal` with a `file:`
 * or custom-scheme URL (e.g. `ms-msdt:`, `search-ms:`) is a known Windows code-execution
 * class — the URL is dropped instead of forwarded, and nothing is echoed back.
 */
export function isWebUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:" || new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Phase 23 (F-C): the synchronous half of the permission policy. `setPermissionCheckHandler`
 * answers non-interactive checks (clipboard read queries, notifications probes, …); the shell
 * session grants none — interactive requests are denied by `denyByDefaultPermissions()` too.
 */
export function denyByDefaultChecks() {
  // none granted in the shell window; browser tabs configure their own policy.
  return (_wc: unknown, _permission: string, _details?: unknown): boolean => false;
}

/**
 * Content-Security-Policy delivered as an onHeadersReceived header — belt and braces with
 * the meta tag in index.html (the meta covers dev and prod; this header hardens the
 * packaged file:// load specifically).
 */
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
