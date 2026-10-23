import { z } from "zod";
import { Ulid } from "../ids.js";
import { DownloadJob } from "./download.js";
import { MediaJob } from "./media.js";

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
  /** v1.4 (Phase 9): proxy profile this tab routes through; null = direct (always serialized). */
  proxyProfileId: z.string().nullable(),
  /** Epoch ms of tab creation. */
  createdAt: z.number().int().nonnegative(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

export const TabCreateParams = z.object({
  url: z.string().optional(),
  activate: z.boolean().optional().default(true),
  /** v1.4: proxy profile for this tab; omitted/null = the default direct session. */
  proxyProfileId: Ulid.nullish(),
});
export const TabCreateResult = z.object({ tab: BrowserTab });

export const TabIdParams = z.object({ id: Ulid });
export const TabNavigateParams = z.object({ id: Ulid, url: z.string().min(1) });
export const TabMuteParams = z.object({ id: Ulid, muted: z.boolean() });
export const TabResult = z.object({ tab: BrowserTab });
export const TabCloseResult = z.object({ closed: z.literal(true) });
export const TabListParams = z.object({});
export const TabListResult = z.object({ tabs: z.array(BrowserTab) });

/**
 * v1.4 (Phase 9): move a tab onto a proxy profile (or back to direct). The underlying
 * WebContentsView is recreated on the target partition at the current URL — that tab's
 * back/forward history resets; cookies/storage stay scoped to each profile partition.
 */
export const TabSetProxyParams = z.object({ id: Ulid, proxyProfileId: Ulid.nullable() });
export const TabSetProxyResult = z.object({ tab: BrowserTab });

/** Emitted whenever any tab property changes (title, url, loading, audio, nav state). */
export const TabUpdatedEvent = z.object({ tab: BrowserTab });
export const TabClosedEvent = z.object({ id: Ulid });

// ---- v1.18 (Phase 33): media detected while browsing ----

export const BrowserMediaKind = z.enum(["video", "audio", "manifest", "segment"]);
export type BrowserMediaKind = z.infer<typeof BrowserMediaKind>;

/** How the item was found: a network response the player fetched, or a DOM media element. */
export const BrowserMediaOrigin = z.enum(["network", "dom"]);
export type BrowserMediaOrigin = z.infer<typeof BrowserMediaOrigin>;

/**
 * One media resource detected in a browsing tab. `id` is deterministic
 * (`<kind>:<url>`), so repeated observations of the same URL collapse naturally and the
 * renderer can key rows by it. `segment` rows are withheld by the main process while any
 * manifest is known for the tab (HLS/DASH playback would otherwise flood the list).
 */
export const BrowserMediaItem = z.object({
  id: z.string().min(1).max(2100),
  tabId: Ulid,
  url: z.url({ protocol: /^https?$/ }).max(2048),
  kind: BrowserMediaKind,
  mimeType: z.string().min(1).nullable(),
  /** Response Content-Length when known; null otherwise (DOM scans never know it). */
  byteSize: z.number().int().nonnegative().nullable(),
  /** Download-ready filename derived from the URL at detection time. */
  filename: z.string().min(1).max(512),
  origin: BrowserMediaOrigin,
  detectedAt: z.number().int().nonnegative(),
});
export type BrowserMediaItem = z.infer<typeof BrowserMediaItem>;

const BROWSER_MEDIA_ITEMS_MAX = 100;

/** Authoritative per-tab snapshot: the renderer replaces its mirror wholesale. */
export const BrowserMediaSnapshotEvent = z.object({
  tabId: Ulid,
  items: z.array(BrowserMediaItem).max(BROWSER_MEDIA_ITEMS_MAX),
});
export type BrowserMediaSnapshotEvent = z.infer<typeof BrowserMediaSnapshotEvent>;

export const BrowserMediaListParams = z.object({ tabId: Ulid });
export const BrowserMediaListResult = z.object({
  items: z.array(BrowserMediaItem).max(BROWSER_MEDIA_ITEMS_MAX),
});

/** Re-run the DOM scan now and return the merged per-tab list. */
export const BrowserMediaScanParams = z.object({ tabId: Ulid });
export const BrowserMediaScanResult = z.object({
  items: z.array(BrowserMediaItem).max(BROWSER_MEDIA_ITEMS_MAX),
});

export const BrowserMediaClearParams = z.object({ tabId: Ulid });
export const BrowserMediaClearResult = z.object({ cleared: z.literal(true) });

/**
 * One-click download of a detected item, orchestrated by main (which owns the browsing
 * session's cookies — the renderer never sees them): direct media goes to the resumable
 * HTTP engine, stream manifests go through the yt-dlp media pipeline with auto-picked
 * best formats.
 */
export const BrowserMediaDownloadParams = z.object({
  tabId: Ulid,
  itemId: z.string().min(1).max(2100),
});
export const BrowserMediaDownloadResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), job: DownloadJob }),
  z.object({ kind: z.literal("stream"), job: MediaJob }),
]);
export type BrowserMediaDownloadResult = z.infer<typeof BrowserMediaDownloadResult>;
