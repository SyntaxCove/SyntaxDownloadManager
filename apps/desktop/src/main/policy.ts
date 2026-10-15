import type { AppSettings } from "@syntaxdm/contracts";

/**
 * Phase 8 — engine operating policy payload. Pure helpers so the queue/scheduler
 * translation is unit-testable; main.ts applies the result over the core supervisor.
 */

/** "HH:MM" (already validated by the settings contract) → local minutes-of-day. */
export function parseHhMm(value: string): number {
  const parts = value.split(":");
  const h = Number.parseInt(parts[0] ?? "", 10);
  const m = Number.parseInt(parts[1] ?? "", 10);
  return (Number.isFinite(h) ? (h ?? 0) : 0) * 60 + (Number.isFinite(m) ? (m ?? 0) : 0);
}

export interface SetPolicyPayload {
  autoStartNew: boolean;
  scheduleMode: "always" | "window";
  windowStartMinute: number;
  windowEndMinute: number;
  speedLimitKBps: number;
  tzOffsetMinutes: number;
}

/** Translate persisted settings into a `download.setPolicy` payload. */
export function buildSetPolicyPayload(settings: AppSettings): SetPolicyPayload {
  return {
    autoStartNew: settings.autoStartNewDownloads,
    scheduleMode: settings.scheduleEnabled ? "window" : "always",
    windowStartMinute: parseHhMm(settings.scheduleStart),
    windowEndMinute: parseHhMm(settings.scheduleEnd),
    speedLimitKBps: settings.speedLimitKBps,
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  };
}
