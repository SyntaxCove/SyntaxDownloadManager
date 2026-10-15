import { create } from "zustand";
import type { Bookmark, HistoryEntry } from "@syntaxdm/contracts";
import { rpc } from "../bridge.js";
import { describeError } from "./settings.js";

/**
 * Browser data store (Phase 14) — browser history + bookmarks, persisted in the Rust
 * core's database and consumed through validated queries. No events by design: the
 * Library page refetches on activation; the address-bar star re-checks on URL change.
 */

const HISTORY_PAGE_SIZE = 200;

interface BrowserDataState {
  // history
  history: HistoryEntry[];
  historyQuery: string;
  historyLoaded: boolean;
  historyError: string | null;
  setHistoryQuery: (query: string) => void;
  loadHistory: () => Promise<void>;
  deleteHistoryEntry: (id: string) => Promise<void>;
  clearHistory: (before?: number) => Promise<number>;

  // bookmarks
  bookmarks: Bookmark[];
  bookmarksLoaded: boolean;
  bookmarksError: string | null;
  loadBookmarks: () => Promise<void>;
  /** The star: returns true when the URL is now bookmarked, false when removed. */
  toggleStar: (url: string, title: string) => Promise<boolean>;
  isBookmarked: (url: string) => Promise<boolean>;
  updateBookmark: (id: string, title: string) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;
}

export const useBrowserDataStore = create<BrowserDataState>((set, get) => ({
  history: [],
  historyQuery: "",
  historyLoaded: false,
  historyError: null,

  setHistoryQuery: (query) => set({ historyQuery: query }),

  loadHistory: async () => {
    const query = get().historyQuery.trim();
    try {
      const { entries } = await rpc("browser.history.list", {
        ...(query ? { query } : {}),
        limit: HISTORY_PAGE_SIZE,
      });
      set({ history: entries, historyLoaded: true, historyError: null });
    } catch (err) {
      set({ historyError: describeError(err), historyLoaded: true });
    }
  },

  deleteHistoryEntry: async (id) => {
    await rpc("browser.history.delete", { id });
    set((s) => ({ history: s.history.filter((e) => e.id !== id) }));
  },

  clearHistory: async (before) => {
    const { cleared } = await rpc("browser.history.clear", before === undefined ? {} : { before });
    await get().loadHistory();
    return cleared;
  },

  bookmarks: [],
  bookmarksLoaded: false,
  bookmarksError: null,

  loadBookmarks: async () => {
    try {
      const { bookmarks } = await rpc("browser.bookmark.list", {});
      set({ bookmarks, bookmarksLoaded: true, bookmarksError: null });
    } catch (err) {
      set({ bookmarksError: describeError(err), bookmarksLoaded: true });
    }
  },

  toggleStar: async (url, title) => {
    const { bookmark } = await rpc("browser.bookmark.getByUrl", { url });
    if (bookmark) {
      await rpc("browser.bookmark.remove", { id: bookmark.id });
      set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== bookmark.id) }));
      return false;
    }
    const created = (await rpc("browser.bookmark.create", { url, title })).bookmark;
    set((s) => ({ bookmarks: [...s.bookmarks, created] }));
    return true;
  },

  isBookmarked: async (url) => {
    const { bookmark } = await rpc("browser.bookmark.getByUrl", { url });
    return bookmark !== null;
  },

  updateBookmark: async (id, title) => {
    const { bookmark } = await rpc("browser.bookmark.update", { id, title });
    set((s) => ({ bookmarks: s.bookmarks.map((b) => (b.id === id ? bookmark : b)) }));
  },

  removeBookmark: async (id) => {
    await rpc("browser.bookmark.remove", { id });
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
  },
}));
