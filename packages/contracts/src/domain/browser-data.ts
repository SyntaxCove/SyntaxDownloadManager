import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Browser data domain (Phase 14, v1.9) — browser history + bookmarks persisted in the Rust
 * core's SQLite database (storage migration v8). Main records settled main-frame http(s)
 * navigations fire-and-forget; the renderer consumes through validated queries.
 *
 * Wire rules (project-wide): fields declared `.nullable()` are ALWAYS serialized (null);
 * `.nullish()` request-side fields are omitted when absent.
 *
 * Downloads library note: the library view is a renderer-side projection over the three live
 * job domains — the only wire addition it needs is `app.revealEntry` (main), which resolves
 * paths exclusively from core-owned job rows. The renderer never supplies filesystem paths.
 */

/** Zod URL with the same protocol pin the download domain uses (http/https only). */
export const WebUrl = z.url({ protocol: /^https?$/ });
export type WebUrl = z.infer<typeof WebUrl>;

/** One recorded visit of one page. `title`/`faviconUrl` are null when the page did not provide them. */
export const HistoryEntry = z.object({
  id: Ulid,
  url: WebUrl,
  title: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  /** Epoch ms of the (settled) visit. */
  visitedAt: z.number().int().nonnegative(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const HistoryRecordParams = z.object({
  url: WebUrl,
  title: z.string().nullish(),
  faviconUrl: z.string().nullish(),
  /** Defaults to the core's clock when omitted (main normally supplies it). */
  visitedAt: z.number().int().nonnegative().nullish(),
});
export const HistoryRecordResult = z.object({ recorded: z.literal(true) });

export const HistoryListParams = z.object({
  /** Case-insensitive substring match against url and title; omitted = everything. */
  query: z.string().min(1).max(256).nullish(),
  /** Page size, 1..500, default 200. */
  limit: z.number().int().min(1).max(500).nullish(),
  /** Offset into the newest-first ordering. */
  offset: z.number().int().nonnegative().nullish(),
});
export const HistoryListResult = z.object({ entries: z.array(HistoryEntry) });

export const HistoryDeleteParams = z.object({ id: Ulid });
export const HistoryDeleteResult = z.object({ deleted: z.literal(true) });

/** Clear the whole history, or only entries visited strictly before the given epoch ms. */
export const HistoryClearParams = z.object({
  before: z.number().int().nonnegative().nullish(),
});
export const HistoryClearResult = z.object({ cleared: z.number().int().nonnegative() });

/** One bookmark. `position` orders the flat list (creation order; no folders in v1). */
export const Bookmark = z.object({
  id: Ulid,
  url: WebUrl,
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Bookmark = z.infer<typeof Bookmark>;

export const BookmarkCreateParams = z.object({
  url: WebUrl,
  title: z.string().min(1).max(512),
});
export const BookmarkCreateResult = z.object({ bookmark: Bookmark });

export const BookmarkListParams = z.object({});
export const BookmarkListResult = z.object({ bookmarks: z.array(Bookmark) });

/** First bookmark (lowest position) whose URL matches — the address-bar star's source of truth. */
export const BookmarkGetByUrlParams = z.object({ url: WebUrl });
export const BookmarkGetByUrlResult = z.object({ bookmark: Bookmark.nullable() });

export const BookmarkUpdateParams = z.object({
  id: Ulid,
  title: z.string().min(1).max(512).nullish(),
  url: WebUrl.nullish(),
});
export const BookmarkUpdateResult = z.object({ bookmark: Bookmark });

export const BookmarkRemoveParams = z.object({ id: Ulid });
export const BookmarkRemoveResult = z.object({ removed: z.literal(true) });

// ---- Downloads library reveal/open (main-served; paths resolved from core job rows only) ----

/** Which job domain an entry belongs to. */
export const LibraryEntryKind = z.enum(["download", "media", "torrent"]);
export type LibraryEntryKind = z.infer<typeof LibraryEntryKind>;

/**
 * Reveal an artifact in Explorer (`folder`) or open it with the shell default handler
 * (`open`). For torrents the resolved path is the content folder inside `destinationDir`.
 */
export const RevealEntryParams = z.object({
  kind: LibraryEntryKind,
  id: Ulid,
  mode: z.enum(["folder", "open"]),
});
export const RevealEntryResult = z.object({
  /** Absolute path that was revealed/opened (resolved from the job's persisted fields). */
  path: z.string().min(1),
});
export type RevealEntryResult = z.infer<typeof RevealEntryResult>;
