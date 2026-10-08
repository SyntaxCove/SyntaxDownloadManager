import { z } from "zod";
import {
  DownloadCreateParams, DownloadCreateResult, DownloadListParams, DownloadListResult,
  JobIdParams, JobByIdResult, DownloadRemoveParams, DownloadRemoveResult,
  DownloadRecoverParams, DownloadRecoverResult, DownloadReplaceUrlParams,
  DownloadReplaceUrlResult, DownloadRetryParams, DownloadRetryResult,
  DownloadQueueMoveParams, DownloadQueueMoveResult, DownloadStartAllParams,
  DownloadStartAllResult, DownloadPauseAllParams, DownloadPauseAllResult,
  DownloadSetSpeedLimitParams, DownloadSetSpeedLimitResult, DownloadSetPolicyParams,
  DownloadSetPolicyResult,
} from "../domain/download.js";
import {
  TabCreateParams, TabCreateResult, TabIdParams, TabResult, TabNavigateParams,
  TabMuteParams, TabCloseResult, TabListParams, TabListResult,
} from "../domain/browser.js";
import {
  SettingsGetParams, SettingsGetResult, SettingsSetAllParams, SettingsSetAllResult,
} from "../domain/settings.js";

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
  // ---- main (Electron main process) ----
  "browser.tab.create": { server: "main", params: TabCreateParams, result: TabCreateResult },
  "browser.tab.close": { server: "main", params: TabIdParams, result: TabCloseResult },
  "browser.tab.activate": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.navigate": { server: "main", params: TabNavigateParams, result: TabResult },
  "browser.tab.back": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.forward": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.reload": { server: "main", params: TabIdParams, result: TabResult },
  "browser.tab.setMuted": { server: "main", params: TabMuteParams, result: TabResult },
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
