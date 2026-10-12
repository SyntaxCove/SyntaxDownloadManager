import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserDataStore } from "../stores/browser-data.js";
import type { Bookmark, HistoryEntry } from "@unidm/contracts";

/**
 * Phase 14 — browser data store against a stubbed preload bridge: history
 * load/search/delete/clear and the bookmark star lifecycle (getByUrl → create/remove).
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];

const historyEntry = (patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0H",
  url: "https://example.com/articles/unidm",
  title: "UniDM release notes",
  faviconUrl: null,
  visitedAt: 1735689600000,
  ...patch,
});

const bookmark = (patch: Partial<Bookmark> = {}): Bookmark => ({
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0B",
  url: "https://example.com/articles/unidm",
  title: "UniDM release notes",
  position: 0,
  createdAt: 1735689600000,
  updatedAt: 1735689600000,
  ...patch,
});

let bookmarksTable: Bookmark[] = [];

function rpcResult(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "browser.history.list":
      return {
        entries: useBrowserDataStore
          .getState()
          .history.filter((e) =>
            p.query ? e.title?.toLowerCase().includes(String(p.query)) : true,
          ),
      };
    case "browser.history.delete":
      return { deleted: true };
    case "browser.history.clear":
      return { cleared: 1 };
    case "browser.bookmark.list":
      return { bookmarks: bookmarksTable };
    case "browser.bookmark.getByUrl":
      return {
        bookmark: bookmarksTable.find((b) => b.url === p.url) ?? null,
      };
    case "browser.bookmark.create": {
      const created = bookmark({
        url: String(p.url),
        title: String(p.title),
        id: "01JD8W3G5XQ9V4M2K7PZ6N8S0C",
      });
      bookmarksTable.push(created);
      return { bookmark: created };
    }
    case "browser.bookmark.remove":
      bookmarksTable = bookmarksTable.filter((b) => b.id !== p.id);
      return { removed: true };
    default:
      return {};
  }
}

beforeEach(() => {
  calls.length = 0;
  bookmarksTable = [];
  useBrowserDataStore.setState({
    history: [],
    historyQuery: "",
    historyLoaded: false,
    historyError: null,
    bookmarks: [],
    bookmarksLoaded: false,
    bookmarksError: null,
  });
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve(rpcResult(method, params));
      },
      onEvent: () => () => undefined,
      emit: () => undefined,
    },
  };
});

describe("browser data store — history", () => {
  it("loadHistory sends the trimmed query with the page size and lands entries", async () => {
    useBrowserDataStore.setState({
      history: [historyEntry()],
      historyQuery: "  uni  ",
    });
    await useBrowserDataStore.getState().loadHistory();
    const call = calls.find((c) => c.method === "browser.history.list");
    expect(call?.params).toEqual({ query: "uni", limit: 200 });
    expect(useBrowserDataStore.getState().historyLoaded).toBe(true);
  });

  it("deleteHistoryEntry removes the row locally after the core confirms", async () => {
    useBrowserDataStore.setState({ history: [historyEntry()] });
    await useBrowserDataStore.getState().deleteHistoryEntry("01JD8W3G5XQ9V4M2K7PZ6N8S0H");
    expect(useBrowserDataStore.getState().history).toHaveLength(0);
    expect(calls).toContainEqual({
      method: "browser.history.delete",
      params: { id: "01JD8W3G5XQ9V4M2K7PZ6N8S0H" },
    });
  });

  it("clearHistory forwards the before cutoff when given", async () => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await useBrowserDataStore.getState().clearHistory(cutoff);
    const clear = calls.find((c) => c.method === "browser.history.clear");
    expect(clear?.params).toEqual({ before: cutoff });
    // A reload follows the clear.
    expect(calls.some((c) => c.method === "browser.history.list")).toBe(true);
  });
});

describe("browser data store — bookmark star", () => {
  it("toggleStar creates when absent and removes when present", async () => {
    const added = await useBrowserDataStore
      .getState()
      .toggleStar("https://example.com/x", "X");
    expect(added).toBe(true);
    expect(bookmarksTable).toHaveLength(1);

    const removed = await useBrowserDataStore
      .getState()
      .toggleStar("https://example.com/x", "X");
    expect(removed).toBe(false);
    expect(bookmarksTable).toHaveLength(0);
  });

  it("isBookmarked reflects the core's answer", async () => {
    expect(await useBrowserDataStore.getState().isBookmarked("https://example.com/x")).toBe(false);
    bookmarksTable.push(bookmark({ url: "https://example.com/x" }));
    expect(await useBrowserDataStore.getState().isBookmarked("https://example.com/x")).toBe(true);
  });

  it("updateBookmark swaps the local row for the authoritative one", async () => {
    bookmarksTable.push(bookmark());
    useBrowserDataStore.setState({ bookmarks: [...bookmarksTable] });
    (globalThis as Record<string, unknown>).window = {
      unidm: {
        rpc: (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "browser.bookmark.update") {
            const p = params as { id: string; title: string };
            return Promise.resolve({
              bookmark: bookmark({ id: p.id, title: p.title, updatedAt: 999 }),
            });
          }
          return Promise.resolve(rpcResult(method, params));
        },
        onEvent: () => () => undefined,
        emit: () => undefined,
      },
    };
    await useBrowserDataStore.getState().updateBookmark("01JD8W3G5XQ9V4M2K7PZ6N8S0B", "Renamed");
    const rows = useBrowserDataStore.getState().bookmarks;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Renamed");
    expect(rows[0]?.updatedAt).toBe(999);
  });

  it("removeBookmark drops the row locally", async () => {
    useBrowserDataStore.setState({ bookmarks: [bookmark()] });
    await useBrowserDataStore.getState().removeBookmark("01JD8W3G5XQ9V4M2K7PZ6N8S0B");
    expect(useBrowserDataStore.getState().bookmarks).toHaveLength(0);
  });
});
