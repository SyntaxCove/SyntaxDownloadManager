import { z } from "zod";
import { AppSettings } from "./settings.js";
import { ToolkitStatusResult } from "./toolkit.js";
import { UpdateState } from "./update.js";

/**
 * Diagnostics domain (Phase 20, v1.14): structured logs, log export, health report.
 *
 * Posture:
 *  - MAIN-SERVED surface except the one core-served snapshot method `diagnostics.health`;
 *    the core never learns about logs or exports (its own tracing output reaches the main
 *    logger over stderr, parsed there).
 *  - The renderer sees structured log RECORDS and report data — never raw filesystem
 *    handles. Absolute paths appear only where the user explicitly consents (the export
 *    destination they picked via `app.pickDirectory`, returned as the written zip path);
 *    log file listings are names within the app's own logs directory. The Phase 14
 *    `app.revealEntry` security rule (job-row-derived paths only) is unchanged.
 *  - Records are redacted at write time (credentials in URLs, token/secret-looking query
 *    values and bearer headers); what reaches the ring buffer, the files and the UI has
 *    already been scrubbed.
 *  - Everything degrades gracefully: a not-ready core yields `snapshot: null` (classified
 *    state, never a thrown error — a diagnostics surface that fails is worthless).
 */

export const LogLevel = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

/** One structured log record — the unit of every sink (ring buffer, file, UI). */
export const LogRecord = z.object({
  /** Epoch ms. */
  ts: z.number().int().nonnegative(),
  level: LogLevel,
  /** Bounded producer tag: "main", "ipc", "supervisor", "core", "core-raw", "renderer", … */
  component: z.string().min(1).max(40),
  /** Human-readable message, credential-scrubbed, capped. */
  msg: z.string().max(2000),
  /** Optional structured detail (already redacted; kept JSON-safe). */
  data: z.unknown().optional(),
});
export type LogRecord = z.infer<typeof LogRecord>;

/**
 * Core-reported health snapshot (Phase 20, mirrored by dc-protocol `CoreHealthSnapshot` —
 * cross-language fixture `diagnosticsCoreHealth` proves both sides agree on the wire).
 * The database is the product's most critical asset, so its integrity check leads.
 */
export const CoreHealthCounts = z.object({
  mediaJobs: z.number().int().nonnegative(),
  torrentJobs: z.number().int().nonnegative(),
  historyEntries: z.number().int().nonnegative(),
  bookmarks: z.number().int().nonnegative(),
  schedulerJobs: z.number().int().nonnegative(),
});
export type CoreHealthCounts = z.infer<typeof CoreHealthCounts>;

export const CoreHealthSnapshot = z.object({
  /** SQLite `PRAGMA quick_check` first row: "ok" or a bounded problem list (capped 500). */
  dbQuickCheck: z.string().min(1).max(500),
  dbPageCount: z.number().int().nonnegative(),
  dbPageSize: z.number().int().nonnegative(),
  /** Download jobs grouped by status (deterministic key order on the wire). */
  jobsByStatus: z.record(z.string().max(40), z.number().int().nonnegative()),
  counts: CoreHealthCounts,
  /** Core process uptime. */
  uptimeMs: z.number().int().nonnegative(),
  contractVersion: z.string().min(1),
  protocolVersion: z.number().int(),
});
export type CoreHealthSnapshot = z.infer<typeof CoreHealthSnapshot>;

/**
 * Toolkit status as seen by diagnostics: identical to the Phase 10 renderer shape except
 * that `manifestVersion: null` (no manifest loaded — packaged resources missing/corrupt)
 * is legal here, because the health report must reflect reality, not throw on it.
 */
export const DiagToolkitStatus = ToolkitStatusResult.extend({
  manifestVersion: z.literal(1).nullable(),
});
export type DiagToolkitStatus = z.infer<typeof DiagToolkitStatus>;

/** Supervisor lifecycle facts (main-side view of the child process). */
export const DiagCoreSupervision = z.object({
  state: z.enum(["stopped", "starting", "ready", "restarting", "unavailable"]),
  /** Total restart attempts this app session. */
  restarts: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** Exit of the last terminated child (graceful stop resets it to null). */
  lastExit: z
    .object({ code: z.number().int().nullable(), signal: z.string().nullable() })
    .nullable(),
  pid: z.number().int().nonnegative().nullable(),
  /** Time since the current (or last) ready transition. */
  uptimeMs: z.number().int().nonnegative().nullable(),
});
export type DiagCoreSupervision = z.infer<typeof DiagCoreSupervision>;

export const DiagCore = z.object({
  supervision: DiagCoreSupervision,
  /** null when the core was not reachable at report time (classified degradation). */
  snapshot: CoreHealthSnapshot.nullable(),
});
export type DiagCore = z.infer<typeof DiagCore>;

export const LogFileInfo = z.object({
  /** File name inside the logs directory (never an absolute path). */
  name: z.string().min(1).max(120),
  bytes: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
});
export type LogFileInfo = z.infer<typeof LogFileInfo>;

export const DiagLogs = z.object({
  files: z.array(LogFileInfo),
  totalBytes: z.number().int().nonnegative(),
});
export type DiagLogs = z.infer<typeof DiagLogs>;

/**
 * Full health report — the single payload of `diagnostics.getHealthReport` and the
 * `health-report.json` entry of every exported diagnostics zip.
 */
export const HealthReport = z.object({
  /** Epoch ms of assembly. */
  generatedAt: z.number().int().nonnegative(),
  app: z.object({
    /** Running app version (app.getVersion()). */
    version: z.string().min(1),
    electronVersion: z.string().min(1),
    platform: z.string().min(1).max(16),
    arch: z.string().min(1).max(16),
    pid: z.number().int().nonnegative(),
    uptimeMs: z.number().int().nonnegative(),
    memoryRssBytes: z.number().int().nonnegative(),
  }),
  versions: z.object({
    contract: z.string().min(1),
    protocol: z.number().int(),
  }),
  /** Sanitized settings snapshot (no secrets live in settings — proxy secrets are
   *  keychain-bound and never appear here). */
  settings: AppSettings,
  core: DiagCore,
  /** Existing toolkit status (Phase 10 shapes; null manifest tolerated and reported). */
  toolkit: DiagToolkitStatus,
  /** Existing sanitized updater state (Phase 18 shape, reused verbatim). */
  updater: UpdateState,
  logs: DiagLogs,
});
export type HealthReport = z.infer<typeof HealthReport>;

// ---- main-served methods ----

export const DiagnosticsGetHealthReportParams = z.object({});
export const DiagnosticsGetHealthReportResult = z.object({ report: HealthReport });

export const DiagnosticsGetRecentLogsParams = z.object({
  /** Filter by level; undefined = all levels. */
  level: LogLevel.optional(),
  /** Newest-last tail size. */
  limit: z.number().int().min(10).max(500).optional().default(200),
});
export const DiagnosticsGetRecentLogsResult = z.object({ records: z.array(LogRecord) });

/**
 * Writes `syntaxdm-diagnostics-<timestamp>.zip` (all current log files + a fresh
 * health-report.json) into `directory` — the folder the user picked via
 * `app.pickDirectory`. Main validates the directory and performs the write; the renderer
 * only ever receives the resulting absolute path (its consented destination).
 */
export const DiagnosticsExportLogsParams = z.object({
  directory: z.string().min(1).max(1024),
});
export const DiagnosticsExportLogsResult = z.object({
  path: z.string().min(1).max(1200),
  bytes: z.number().int().nonnegative(),
});

// ---- core-served method ----

export const DiagnosticsHealthParams = z.object({});
export const DiagnosticsHealthResult = z.object({ health: CoreHealthSnapshot });
