/**
 * Restart backoff policy (pure, testable).
 * Delays: 500ms, 1s, 2s, 4s, 8s, 15s (capped). After MAX_CONSECUTIVE failures the supervisor
 * gives up and reports `unavailable`. A healthy stretch longer than RESET_AFTER ms resets the
 * failure streak.
 */

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 15_000;
export const MAX_CONSECUTIVE = 8;
export const RESET_AFTER_MS = 60_000;

export function delayForFailure(consecutiveFailures: number): number {
  const raw = BASE_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(raw, MAX_DELAY_MS);
}

export function shouldGiveUp(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE;
}

/** True when a stretch of healthy uptime is long enough to reset the failure streak. */
export function shouldResetStreak(uptimeMs: number): boolean {
  return uptimeMs >= RESET_AFTER_MS;
}
