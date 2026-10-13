import { z } from "zod";
import { DownloadProgress, DownloadJob } from "../domain/download.js";
import { TabUpdatedEvent, TabClosedEvent } from "../domain/browser.js";
import { SettingsChangedEvent } from "../domain/settings.js";
import { ToolkitToolStatus } from "../domain/toolkit.js";
import { MediaProgress, MediaJob } from "../domain/media.js";
import { TorrentProgress, TorrentJob } from "../domain/torrent.js";
import { SchedulerUpdatedEvent } from "../domain/scheduler.js";

/**
 * Event registry: event name → payload schema. Sources: core→main over stdio, main→renderer
 * over Electron `webContents.send` (channel === event name).
 */

export interface EventEntry {
  readonly payload: z.ZodType<unknown>;
  /** Where the event originates. */
  readonly source: "core" | "main";
}

export const EVENTS = {
  // core → main
  "download.progress": { source: "core", payload: DownloadProgress },
  "download.updated": { source: "core", payload: z.object({ job: DownloadJob }) },
  "core.ready": {
    source: "core",
    payload: z.object({
      contractVersion: z.string().min(1),
      protocolVersion: z.number().int(),
    }),
  },
  /** Supervisor lifecycle broadcasts (main → renderer). */
  "core.state": {
    source: "main",
    payload: z.object({
      status: z.enum(["starting", "ready", "restarting", "unavailable"]),
    }),
  },
  // main → renderer
  "browser.tab.updated": { source: "main", payload: TabUpdatedEvent },
  "browser.tab.closed": { source: "main", payload: TabClosedEvent },
  "settings.changed": { source: "main", payload: SettingsChangedEvent },
  /** v1.5 (Phase 10): toolkit fetch/verify/activate progress (throttled; state changes immediate). */
  "toolkit.progress": { source: "main", payload: ToolkitToolStatus },
  // v1.7 (Phase 12): media pipeline progress (throttled ~500ms) + authoritative snapshots.
  "media.progress": { source: "core", payload: MediaProgress },
  "media.updated": { source: "core", payload: z.object({ job: MediaJob }) },
  // v1.8 (Phase 13): torrent engine progress (throttled ~500ms) + authoritative snapshots.
  "torrent.progress": { source: "core", payload: TorrentProgress },
  "torrent.updated": { source: "core", payload: z.object({ job: TorrentJob }) },
  // v1.10 (Phase 15): scheduler — authoritative snapshot whenever a job row changes
  // (create / update / fire with outcome / clock recompute).
  "scheduler.updated": { source: "core", payload: SchedulerUpdatedEvent },
} satisfies Record<string, EventEntry>;

export type EventName = keyof typeof EVENTS;

/**
 * Events the renderer can subscribe to: every `main`-sourced event, plus every `core` event the
 * supervisor forwards (core events are validated on receipt by main, then re-validated by the
 * renderer bridge — defense in depth).
 */
export type RendererEventName = EventName;
