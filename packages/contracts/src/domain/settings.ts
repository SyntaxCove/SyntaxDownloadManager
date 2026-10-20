import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Application settings — persisted by the Electron main process (userData/settings.json).
 * Contract v1 covers the Phase 3 foundation set; later phases extend additively with defaults.
 * v1.3 (Phase 8) adds the queue/scheduler policy set (auto-start + daily download window).
 * v1.11 (Phase 16) adds the app-level default proxy for new downloads.
 * v1.12 (Phase 17) adds notification + tray preferences (main-consumed only; the core
 * never learns settings).
 * v1.13 (Phase 18) adds the auto-update check preference (main-consumed only).
 * v1.17 (post-1.0) adds the browser user-agent override (main-consumed only; applied to
 * the browser/proxy tab sessions by the TabManager — the core never learns settings).
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
  // ---- v1.11 (Phase 16): app-level default proxy ----
  /**
   * Proxy profile applied by main to renderer-issued `download.create` requests that omit
   * an explicit `proxyProfileId`; null = direct. Injection is creation-time only (the id is
   * persisted on the job row); a run whose profile is missing stays fail-closed (Phase 9:
   * paused with `proxy_profile_not_found`, never a silent direct fallback).
   */
  defaultProxyProfileId: Ulid.nullable().optional().default(null),
  // ---- v1.12 (Phase 17): notifications + tray ----
  /** false: OS notifications and in-app toasts for completed jobs are suppressed. */
  notifyOnComplete: z.boolean().optional().default(true),
  /** false: OS notifications and in-app toasts for failed jobs are suppressed. */
  notifyOnFailure: z.boolean().optional().default(true),
  /**
   * true: closing the shell window hides it to the tray and keeps downloads running.
   * Effective only while a tray icon actually exists — if tray creation failed, closing
   * keeps the plain quit behavior (an app that vanishes with no tray icon would strand
   * the engine and the user's only way back in).
   */
  closeToTray: z.boolean().optional().default(true),
  // ---- v1.13 (Phase 18): auto-update channel ----
  /**
   * false: the background update checks (startup + 12 h periodic) are suppressed; a
   * manual check from the Settings page remains available (the updater itself is still
   * consent-gated end to end: check never downloads, download never installs).
   */
  updateAutoCheck: z.boolean().optional().default(true),
  // ---- v1.14 (Phase 20): diagnostics ----
  /**
   * true: the main logger records `debug` records and the core is spawned with
   * `RUST_LOG=debug` (applies on the next core spawn; the main logger level is live).
   * Default false keeps logs at info — a bounded, scrubbed, rotating set sized for
   * support exports, not for continuous verbose capture.
   */
  verboseLogging: z.boolean().optional().default(false),
  // ---- v1.17 (post-1.0): browser user agent ----
  /**
   * Custom user agent for browser tabs (persist:browser + per-proxy sessions). Empty
   * string = the Electron/Chromium default is used unchanged. Applied live: new loads
   * in every tab of the affected sessions pick it up; the effective string (custom or
   * captured default) is surfaced to the renderer via `browser.getUserAgent`.
   */
  browserUserAgent: z.string().max(512).optional().default(""),
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
  defaultProxyProfileId: null,
  notifyOnComplete: true,
  notifyOnFailure: true,
  closeToTray: true,
  updateAutoCheck: true,
  verboseLogging: false,
  browserUserAgent: "",
});

export const SettingsGetParams = z.object({});
export const SettingsGetResult = z.object({ settings: AppSettings });

/** Patch semantics: only provided keys are updated; result is the full validated settings. */
export const SettingsSetAllParams = z.object({ settings: AppSettings.partial() });
export const SettingsSetAllResult = z.object({ settings: AppSettings });

export const SettingsChangedEvent = z.object({ settings: AppSettings });
