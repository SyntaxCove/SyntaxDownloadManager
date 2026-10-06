import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Browser domain — implemented in Phase 4 by the main-process TabManager (WebContentsView).
 */

export const BrowserTabStatus = z.enum(["loading", "loaded", "crashed", "frozen"]);
export type BrowserTabStatus = z.infer<typeof BrowserTabStatus>;

export const BrowserTab = z.object({
  id: Ulid,
  title: z.string(),
  url: z.string(),
  faviconUrl: z.string().nullable(),
  status: BrowserTabStatus,
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  isAudioMuted: z.boolean(),
  isAudible: z.boolean(),
  /** Epoch ms of tab creation. */
  createdAt: z.number().int().nonnegative(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

export const TabCreateParams = z.object({
  url: z.string().optional(),
  activate: z.boolean().optional().default(true),
});
export const TabCreateResult = z.object({ tab: BrowserTab });

export const TabIdParams = z.object({ id: Ulid });
export const TabNavigateParams = z.object({ id: Ulid, url: z.string().min(1) });
export const TabMuteParams = z.object({ id: Ulid, muted: z.boolean() });
export const TabResult = z.object({ tab: BrowserTab });
export const TabCloseResult = z.object({ closed: z.literal(true) });
export const TabListParams = z.object({});
export const TabListResult = z.object({ tabs: z.array(BrowserTab) });

/** Emitted whenever any tab property changes (title, url, loading, audio, nav state). */
export const TabUpdatedEvent = z.object({ tab: BrowserTab });
export const TabClosedEvent = z.object({ id: Ulid });
