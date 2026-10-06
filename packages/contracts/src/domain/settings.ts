import { z } from "zod";

/**
 * Application settings — persisted by the Electron main process (userData/settings.json).
 * Contract v1 covers the Phase 3 foundation set; later phases extend additively with defaults.
 */

export const ThemeMode = z.enum(["system", "light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeMode>;

export const AppLanguage = z.enum(["fa", "en"]);
export type AppLanguage = z.infer<typeof AppLanguage>;

export const AppSettings = z.object({
  theme: ThemeMode.optional().default("system"),
  language: AppLanguage.optional().default("en"),
  /** Default directory for new downloads. */
  downloadDir: z.string().min(1).optional().default("~/Downloads"),
  /** Max parallel active downloads (engine v1: 1..8). */
  concurrentDownloads: z.number().int().min(1).max(8).optional().default(3),
  /** Global speed limit in KiB/s; 0 = unlimited. */
  speedLimitKBps: z.number().int().min(0).optional().default(0),
});
export type AppSettings = z.infer<typeof AppSettings>;

/** Canonical defaults — the single source for main-process persistence and renderer UI. */
export const SETTINGS_DEFAULTS: Readonly<AppSettings> = Object.freeze({
  theme: "system",
  language: "en",
  downloadDir: "~/Downloads",
  concurrentDownloads: 3,
  speedLimitKBps: 0,
});

export const SettingsGetParams = z.object({});
export const SettingsGetResult = z.object({ settings: AppSettings });

/** Patch semantics: only provided keys are updated; result is the full validated settings. */
export const SettingsSetAllParams = z.object({ settings: AppSettings.partial() });
export const SettingsSetAllResult = z.object({ settings: AppSettings });

export const SettingsChangedEvent = z.object({ settings: AppSettings });
