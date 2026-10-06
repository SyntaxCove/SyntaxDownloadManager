import { z } from "zod";
import { DownloadProgress, DownloadJob } from "../domain/download.js";
import { TabUpdatedEvent, TabClosedEvent } from "../domain/browser.js";
import { SettingsChangedEvent } from "../domain/settings.js";

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
} satisfies Record<string, EventEntry>;

export type EventName = keyof typeof EVENTS;

/**
 * Events the renderer can subscribe to: every `main`-sourced event, plus every `core` event the
 * supervisor forwards (core events are validated on receipt by main, then re-validated by the
 * renderer bridge — defense in depth).
 */
export type RendererEventName = EventName;
