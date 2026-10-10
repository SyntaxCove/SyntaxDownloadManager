import { z } from "zod";

/**
 * Application settings — persisted by the Electron main process (userData/settings.json).
 * Contract v1 covers the Phase 3 foundation set; later phases extend additively with defaults.
 * v1.3 (Phase 8) adds the queue/scheduler policy set (auto-start + daily download window).
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
  /** Max parallel active downloads (engine: 1..8). */
  concurrentDownloads: z.number().int().min(1).max(8).optional().default(3),
  /** Max range connections per single download (Phase 6 segmented engine; 1..16). */
  maxConnectionsPerDownload: z.number().int().min(1).max(16).optional().default(4),
  /** Global speed limit in KiB/s; 0 = unlimited. */
  speedLimitKBps: z.number().int().min(0).optional().default(0),
  // ---- v1.3 (Phase 8): queue + scheduler policy ----
  /** false: new downloads are parked as `paused` instead of entering the queue. */
  autoStartNewDownloads: z.boolean().optional().default(true),
  /** true: downloads auto-run only inside the daily [scheduleStart, scheduleEnd) window. */
  scheduleEnabled: z.boolean().optional().default(false),
  /** Daily window bounds, local time `HH:MM` (24h). Wrap-over windows are supported. */
  scheduleStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d/, "must be HH:MM (24h)")
    .optional()
    .default("00:00"),
  scheduleEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d/, "must be HH:MM (24h)")
    .optional()
    .default("00:00"),
  // ---- v1.5 (Phase 10): bundled media toolkit ----
  /** false: missing/failed media tools are NOT fetched automatically at startup. */
  mediaToolsAutoFetch: z.boolean().optional().default(true),
});
export type AppSettings = z.infer<typeof AppSettings>;

/** Canonical defaults — the single source for main-process persistence and renderer UI. */
export const SETTINGS_DEFAULTS: Readonly<AppSettings> = Object.freeze({
  theme: "system",
  language: "en",
  downloadDir: "~/Downloads",
  concurrentDownloads: 3,
  maxConnectionsPerDownload: 4,
  speedLimitKBps: 0,
  autoStartNewDownloads: true,
  scheduleEnabled: false,
  scheduleStart: "00:00",
  scheduleEnd: "00:00",
  mediaToolsAutoFetch: true,
});

export const SettingsGetParams = z.object({});
export const SettingsGetResult = z.object({ settings: AppSettings });

/** Patch semantics: only provided keys are updated; result is the full validated settings. */
export const SettingsSetAllParams = z.object({ settings: AppSettings.partial() });
export const SettingsSetAllResult = z.object({ settings: AppSettings });

export const SettingsChangedEvent = z.object({ settings: AppSettings });
