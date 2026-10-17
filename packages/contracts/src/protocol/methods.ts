import { z } from "zod";
import {
  DownloadCreateParams, DownloadCreateResult, DownloadListParams, DownloadListResult,
  JobIdParams, JobByIdResult, DownloadRemoveParams, DownloadRemoveResult,
  DownloadRecoverParams, DownloadRecoverResult, DownloadReplaceUrlParams,
  DownloadReplaceUrlResult, DownloadRetryParams, DownloadRetryResult,
  DownloadQueueMoveParams, DownloadQueueMoveResult, DownloadStartAllParams,
  DownloadStartAllResult, DownloadPauseAllParams, DownloadPauseAllResult,
  DownloadSetSpeedLimitParams, DownloadSetSpeedLimitResult, DownloadSetPolicyParams,
  DownloadSetPolicyResult, DownloadSetProxyParams, DownloadSetProxyResult,
} from "../domain/download.js";
import {
  TabCreateParams, TabCreateResult, TabIdParams, TabResult, TabNavigateParams,
  TabMuteParams, TabCloseResult, TabListParams, TabListResult,
  TabSetProxyParams, TabSetProxyResult,
} from "../domain/browser.js";
import {
  SettingsGetParams, SettingsGetResult, SettingsSetAllParams, SettingsSetAllResult,
} from "../domain/settings.js";
import {
  ProxyListParams, ProxyListResult, ProxyCreateParams, ProxyCreateResult,
  ProxyUpdateParams, ProxyUpdateResult, ProxyRemoveParams, ProxyRemoveResult,
  ProxySetRuntimeParams, ProxySetRuntimeResult, ProxyTestParams, ProxyTestResult,
} from "../domain/proxy.js";
import {
  ToolkitGetStatusParams, ToolkitGetStatusResult, ToolkitEnsureAllParams,
  ToolkitEnsureAllResult, ToolkitEnsureParams, ToolkitEnsureResult, ToolkitCancelParams,
  ToolkitCancelResult, ToolkitSetPathsParams, ToolkitSetPathsResult,
} from "../domain/toolkit.js";
import {
  MediaDownloadParams, MediaDownloadResult, MediaListParams, MediaListResult,
  MediaJobIdParams, MediaJobByIdResult, MediaRemoveParams, MediaRemoveResult,
  MediaInspectParams, MediaInspectResult,
} from "../domain/media.js";
import {
  TorrentAddParams, TorrentAddResult, TorrentListParams, TorrentListResult,
  TorrentJobIdParams, TorrentJobByIdResult, TorrentRemoveParams, TorrentRemoveResult,
} from "../domain/torrent.js";
import {
  HistoryRecordParams, HistoryRecordResult, HistoryListParams, HistoryListResult,
  HistoryDeleteParams, HistoryDeleteResult, HistoryClearParams, HistoryClearResult,
  BookmarkCreateParams, BookmarkCreateResult, BookmarkListParams, BookmarkListResult,
  BookmarkGetByUrlParams, BookmarkGetByUrlResult, BookmarkUpdateParams, BookmarkUpdateResult,
  BookmarkRemoveParams, BookmarkRemoveResult, RevealEntryParams, RevealEntryResult,
} from "../domain/browser-data.js";
import {
  SchedulerListParams, SchedulerListResult, SchedulerCreateParams, SchedulerCreateResult,
  SchedulerUpdateParams, SchedulerUpdateResult, SchedulerJobIdParams, SchedulerJobByIdResult,
  SchedulerRemoveResult, SchedulerRunNowResult, SchedulerSetClockParams,
  SchedulerSetClockResult,
} from "../domain/scheduler.js";
import {
  UpdateGetStateParams, UpdateGetStateResult, UpdateCheckParams, UpdateCheckResult,
  UpdateDownloadParams, UpdateDownloadResult, UpdateInstallParams, UpdateInstallResult,
} from "../domain/update.js";
import {
  DiagnosticsGetHealthReportParams, DiagnosticsGetHealthReportResult,
  DiagnosticsGetRecentLogsParams, DiagnosticsGetRecentLogsResult,
  DiagnosticsExportLogsParams, DiagnosticsExportLogsResult,
  DiagnosticsHealthParams, DiagnosticsHealthResult,
} from "../domain/diagnostics.js";

/**
 * Method registry: method name → { params, result } schemas. Both sides of every boundary
 * validate against these at runtime. Handlers register against `AnyMethod` to stay type-safe.
 */

export interface MethodEntry {
  readonly params: z.ZodType<unknown>;
  readonly result: z.ZodType<unknown>;
  /** Which component serves the method. */
  readonly server: "main" | "core";
}

const PingResult = z.object({
  pong: z.literal(true),
  contractVersion: z.string().min(1),
  protocolVersion: z.number().int(),
  now: z.number().int().nonnegative(),
});

export const METHODS = {
  // ---- core (Rust download-core, Phase 5) ----
  "core.ping": { server: "core", params: z.object({}).optional(), result: PingResult },
  "core.shutdown": { server: "core", params: z.object({}).optional(), result: z.object({ ok: z.literal(true) }) },
  "download.create": { server: "core", params: DownloadCreateParams, result: DownloadCreateResult },
  "download.list": { server: "core", params: DownloadListParams, result: DownloadListResult },
  "download.get": { server: "core", params: JobIdParams, result: JobByIdResult },
  "download.pause": { server: "core", params: JobIdParams, result: JobByIdResult },
  "download.resume": { server: "core", params: JobIdParams, result: JobByIdResult },
  "download.cancel": { server: "core", params: JobIdParams, result: JobByIdResult },
  "download.remove": { server: "core", params: DownloadRemoveParams, result: DownloadRemoveResult },
  /** Applied by main at startup and whenever the parallel-downloads settings change.
   *  `maxConnectionsPerDownload` (v1.1) controls segmentation of a single job. */
  "download.setConcurrency": {
    server: "core",
    params: z.object({
      max: z.number().int().min(1).max(8),
      maxConnectionsPerDownload: z.number().int().min(1).max(16).optional(),
    }),
    result: z.object({ applied: z.literal(true) }),
  },
  // ---- core (v1.2, Phase 7): recovery engine ----
  "download.recover": { server: "core", params: DownloadRecoverParams, result: DownloadRecoverResult },
  "download.replaceUrl": { server: "core", params: DownloadReplaceUrlParams, result: DownloadReplaceUrlResult },
  "download.retry": { server: "core", params: DownloadRetryParams, result: DownloadRetryResult },
  // ---- core (v1.3, Phase 8): queue management + bandwidth/scheduler policy ----
  "download.queueMove": { server: "core", params: DownloadQueueMoveParams, result: DownloadQueueMoveResult },
  "download.startAll": { server: "core", params: DownloadStartAllParams, result: DownloadStartAllResult },
  "download.pauseAll": { server: "core", params: DownloadPauseAllParams, result: DownloadPauseAllResult },
  "download.setSpeedLimit": { server: "core", params: DownloadSetSpeedLimitParams, result: DownloadSetSpeedLimitResult },
  /** Applied by main at startup, on settings changes and every 10 min (tz drift guard). */
  "download.setPolicy": { server: "core", params: DownloadSetPolicyParams, result: DownloadSetPolicyResult },
  // ---- core (v1.4, Phase 9): proxy routing ----
  /** Change the proxy profile a job routes through (null = direct). */
  "download.setProxy": { server: "core", params: DownloadSetProxyParams, result: DownloadSetProxyResult },
  /** Full replace of the core's in-memory runtime proxy map (main is the source of truth). */
  "proxy.setRuntime": { server: "core", params: ProxySetRuntimeParams, result: ProxySetRuntimeResult },
  /** GET a probe URL through the profile; returns latency + exit IP or a classified error. */
  "proxy.test": { server: "core", params: ProxyTestParams, result: ProxyTestResult },
  // ---- core (v1.5, Phase 10): bundled media toolkit paths ----
  /** Full replace of the core's in-memory toolkit path map (main pushes only verified tools). */
  "toolkit.setPaths": { server: "core", params: ToolkitSetPathsParams, result: ToolkitSetPathsResult },
  // ---- core (v1.6, Phase 11): media inspector ----
  /** Inspect a media page with the bundled yt-dlp; returns a normalized MediaManifest. */
  "media.inspect": { server: "core", params: MediaInspectParams, result: MediaInspectResult },
  // ---- core (v1.7, Phase 12): persistent media download & merge pipeline ----
  /** Create + queue a media job (selected formats → bundled yt-dlp → bundled FFmpeg mux). */
  "media.download": { server: "core", params: MediaDownloadParams, result: MediaDownloadResult },
  "media.list": { server: "core", params: MediaListParams, result: MediaListResult },
  "media.get": { server: "core", params: MediaJobIdParams, result: MediaJobByIdResult },
  "media.pause": { server: "core", params: MediaJobIdParams, result: MediaJobByIdResult },
  "media.resume": { server: "core", params: MediaJobIdParams, result: MediaJobByIdResult },
  "media.cancel": { server: "core", params: MediaJobIdParams, result: MediaJobByIdResult },
  "media.remove": { server: "core", params: MediaRemoveParams, result: MediaRemoveResult },
  // ---- core (v1.8, Phase 13): native torrent engine ----
  /** Add a .torrent (base64) or magnet URI; the swarm is the persistent source. */
  "torrent.add": { server: "core", params: TorrentAddParams, result: TorrentAddResult },
  "torrent.list": { server: "core", params: TorrentListParams, result: TorrentListResult },
  "torrent.get": { server: "core", params: TorrentJobIdParams, result: TorrentJobByIdResult },
  "torrent.pause": { server: "core", params: TorrentJobIdParams, result: TorrentJobByIdResult },
  "torrent.resume": { server: "core", params: TorrentJobIdParams, result: TorrentJobByIdResult },
  "torrent.cancel": { server: "core", params: TorrentJobIdParams, result: TorrentJobByIdResult },
  "torrent.remove": { server: "core", params: TorrentRemoveParams, result: TorrentRemoveResult },
  // ---- core (v1.9, Phase 14): browser history + bookmarks (storage v8) ----
  /** Record one settled main-frame http(s) visit (fire-and-forget from main). */
  "browser.history.record": { server: "core", params: HistoryRecordParams, result: HistoryRecordResult },
  "browser.history.list": { server: "core", params: HistoryListParams, result: HistoryListResult },
  "browser.history.delete": { server: "core", params: HistoryDeleteParams, result: HistoryDeleteResult },
  "browser.history.clear": { server: "core", params: HistoryClearParams, result: HistoryClearResult },
  "browser.bookmark.create": { server: "core", params: BookmarkCreateParams, result: BookmarkCreateResult },
  "browser.bookmark.list": { server: "core", params: BookmarkListParams, result: BookmarkListResult },
  "browser.bookmark.getByUrl": { server: "core", params: BookmarkGetByUrlParams, result: BookmarkGetByUrlResult },
  "browser.bookmark.update": { server: "core", params: BookmarkUpdateParams, result: BookmarkUpdateResult },
  "browser.bookmark.remove": { server: "core", params: BookmarkRemoveParams, result: BookmarkRemoveResult },
  // ---- core (v1.10, Phase 15): scheduler jobs + automation ----
  "scheduler.list": { server: "core", params: SchedulerListParams, result: SchedulerListResult },
  /** `startAt` may be in the past — catch-up semantics (fires at the next tick). */
  "scheduler.create": { server: "core", params: SchedulerCreateParams, result: SchedulerCreateResult },
  "scheduler.update": { server: "core", params: SchedulerUpdateParams, result: SchedulerUpdateResult },
  "scheduler.remove": { server: "core", params: SchedulerJobIdParams, result: SchedulerRemoveResult },
  /** Fire immediately; the outcome is recorded on the row, the schedule is untouched. */
  "scheduler.runNow": { server: "core", params: SchedulerJobIdParams, result: SchedulerRunNowResult },
  /** Main → core only (never registered on the renderer router), like `download.setPolicy`. */
  "scheduler.setClock": {
    server: "core",
    params: SchedulerSetClockParams,
    result: SchedulerSetClockResult,
  },
  // ---- main (Electron main process) ----
  // v1.9 (Phase 14): downloads library reveal/open — paths come from core job rows only.
  "app.revealEntry": { server: "main", params: RevealEntryParams, result: RevealEntryResult },
  "browser.tab.create": { server: "main", params: TabCreateParams, result: TabCreateResult },
  "browser.tab.close": { server: "main", params: TabIdParams, result: TabCloseResult },
  "browser.tab.activate": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.navigate": { server: "main", params: TabNavigateParams, result: TabResult },
  "browser.tab.back": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.forward": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.reload": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.setMuted": { server: "main", params: TabMuteParams, result: TabResult },
  /** v1.4: move a tab onto a proxy profile (or back to direct); recreates the view. */
  "browser.tab.setProxy": { server: "main", params: TabSetProxyParams, result: TabSetProxyResult },
  "browser.tab.list": { server: "main", params: TabListParams, result: TabListResult },
  /**
   * Renderer reports the content-area rect where browser tabs render (WebContentsView is an
   * overlay above the shell UI, so geometry comes from the layout that owns the hole).
   * Zero width/height hides the overlay (shell views other than Browse).
   */
  "browser.setViewportBounds": {
    server: "main",
    params: z.object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(0),
      height: z.number().int().min(0),
    }),
    result: z.object({ applied: z.literal(true) }),
  },
  "settings.get": { server: "main", params: SettingsGetParams, result: SettingsGetResult },
  "settings.setAll": { server: "main", params: SettingsSetAllParams, result: SettingsSetAllResult },
  // ---- main (v1.11, Phase 16): native directory picker (settings-completion deferral) ----
  /** Opens the OS folder dialog; `path: null` = the user canceled. */
  "app.pickDirectory": {
    server: "main",
    params: z.object({}),
    result: z.object({ path: z.string().min(1).nullable() }),
  },
  // ---- main (v1.4, Phase 9): proxy profile management (passwords redacted on results) ----
  "proxy.list": { server: "main", params: ProxyListParams, result: ProxyListResult },
  "proxy.create": { server: "main", params: ProxyCreateParams, result: ProxyCreateResult },
  "proxy.update": { server: "main", params: ProxyUpdateParams, result: ProxyUpdateResult },
  "proxy.remove": { server: "main", params: ProxyRemoveParams, result: ProxyRemoveResult },
  // ---- main (v1.5, Phase 10): bundled media toolkit management ----
  "toolkit.getStatus": { server: "main", params: ToolkitGetStatusParams, result: ToolkitGetStatusResult },
  "toolkit.ensureAll": { server: "main", params: ToolkitEnsureAllParams, result: ToolkitEnsureAllResult },
  "toolkit.ensure": { server: "main", params: ToolkitEnsureParams, result: ToolkitEnsureResult },
  "toolkit.cancel": { server: "main", params: ToolkitCancelParams, result: ToolkitCancelResult },
  // ---- main (v1.13, Phase 18): auto-update channel ----
  "update.getState": { server: "main", params: UpdateGetStateParams, result: UpdateGetStateResult },
  /** Manual check (Settings page); background checks fire without this method. */
  "update.check": { server: "main", params: UpdateCheckParams, result: UpdateCheckResult },
  /** Consent point: downloads a found update. */
  "update.download": { server: "main", params: UpdateDownloadParams, result: UpdateDownloadResult },
  /** Consent point: quits and installs a downloaded update (teardown runs first). */
  "update.install": { server: "main", params: UpdateInstallParams, result: UpdateInstallResult },
  // ---- main (v1.14, Phase 20): diagnostics — health report, log tail, log export ----
  "diagnostics.getHealthReport": {
    server: "main",
    params: DiagnosticsGetHealthReportParams,
    result: DiagnosticsGetHealthReportResult,
  },
  "diagnostics.getRecentLogs": {
    server: "main",
    params: DiagnosticsGetRecentLogsParams,
    result: DiagnosticsGetRecentLogsResult,
  },
  "diagnostics.exportLogs": {
    server: "main",
    params: DiagnosticsExportLogsParams,
    result: DiagnosticsExportLogsResult,
  },
  // ---- core (v1.14, Phase 20): storage + process health snapshot ----
  "diagnostics.health": { server: "core", params: DiagnosticsHealthParams, result: DiagnosticsHealthResult },
} satisfies Record<string, { server: "main" | "core" } & Partial<MethodEntry>>;

export type MethodName = keyof typeof METHODS;
export type CoreMethodName = {
  [K in MethodName]: (typeof METHODS)[K]["server"] extends "core" ? K : never;
}[MethodName];
export type MainMethodName = {
  [K in MethodName]: (typeof METHODS)[K]["server"] extends "main" ? K : never;
}[MethodName];

export type MethodParams<M extends MethodName> =
  (typeof METHODS)[M] extends { params: z.ZodType<infer P> } ? P : undefined;

export type MethodResult<M extends MethodName> =
  (typeof METHODS)[M] extends { result: z.ZodType<infer R> } ? R : unknown;
