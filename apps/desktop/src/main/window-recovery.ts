/**
 * Phase 24 hardening (F-2): renderer crash recovery policy.
 *
 * `render-process-gone` used to be logged only — a crashed renderer left the user on a
 * dead window until they restarted the app themselves. The shell now auto-reloads after
 * a non-clean-exit crash, but with a hard budget so a crash loop can never become a
 * reload loop: at most `MAX_ATTEMPTS` reloads inside any `WINDOW_MS` sliding window,
 * with linear backoff between attempts. Pure logic, no Electron imports, fully
 * unit-tested; window.ts owns the bookkeeping and the actual `webContents.reload()`.
 */

/** Reload attempts allowed inside any WINDOW_MS sliding window. */
export const MAX_ATTEMPTS = 3;
/** Sliding window for the attempt budget. */
export const WINDOW_MS = 60_000;
/** Linear backoff between attempts: 1 s, 2 s, 3 s. */
export const BASE_BACKOFF_MS = 1_000;

export interface ReloadDecision {
  reload: boolean;
  /** How long to wait before calling reload(); 0 when not reloading. */
  delayMs: number;
  /** Attempts now inside the window (only meaningful when reload is true). */
  attempts: number;
}

/**
 * Decide whether a crashed renderer should be auto-reloaded.
 *
 * @param reason        Electron's `render-process-gone` details.reason
 * @param priorAttempts reloads already performed inside the current window
 * @param nowMs         monotonic-ish wall clock (Date.now() at the call site)
 * @param lastAttemptMs when the last reload was scheduled, null if never
 */
export function rendererReloadDecision(
  reason: string,
  priorAttempts: number,
  nowMs: number,
  lastAttemptMs: number | null,
): ReloadDecision {
  // A clean exit means the window was closed deliberately — never resurrect it.
  if (reason === "clean-exit") return { reload: false, delayMs: 0, attempts: priorAttempts };
  // The budget is sliding: outside WINDOW_MS the window empties and attempts reset.
  const insideWindow = lastAttemptMs !== null && nowMs - lastAttemptMs < WINDOW_MS;
  const attempts = insideWindow ? priorAttempts : 0;
  if (attempts >= MAX_ATTEMPTS) return { reload: false, delayMs: 0, attempts };
  return { reload: true, delayMs: BASE_BACKOFF_MS * (attempts + 1), attempts: attempts + 1 };
}
