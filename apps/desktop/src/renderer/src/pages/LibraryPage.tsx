import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Tab,
  TabList,
  TabValue,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ArrowDownloadRegular,
  BookmarkRegular,
  DeleteRegular,
  DismissRegular,
  FolderRegular,
  HistoryRegular,
  OpenRegular,
  VideoClipMultipleRegular,
  ArrowSquareDownRegular,
} from "@fluentui/react-icons";
import type { LibraryEntryKind } from "@unidm/contracts";
import { useDownloadsStore } from "../stores/downloads.js";
import { useMediaStore } from "../stores/media.js";
import { useTorrentStore } from "../stores/torrent.js";
import { useBrowserDataStore } from "../stores/browser-data.js";
import { createTab } from "../stores/browser.js";
import { rpc } from "../bridge.js";
import { describeError } from "../stores/settings.js";
import {
  filterLibrary,
  mergeLibrary,
  type LibraryEntry,
  type LibraryKindFilter,
  type LibraryStatusFilter,
} from "../app/library-projection.js";
import { formatBytes } from "./DownloadsPage.js";

/**
 * Library (Phase 14): downloads library + browser history + bookmarks.
 *
 * Files tab — a projection over the three live job stores (no state of its own). Reveal
 * and open go through `app.revealEntry`, which resolves paths in main from core job rows
 * only. Delete semantics are per-kind and honest: HTTP downloads remove the entry only
 * (the finished file stays on disk), media/torrents can also delete their artifacts.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "900px" },
  toolbar: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" },
  search: { flex: "1 1 220px", minWidth: "180px" },
  entry: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  badge: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
    minWidth: "70px",
  },
  main: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  actions: { display: "flex", gap: "4px", marginLeft: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
  day: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    marginTop: "8px",
  },
});

const KIND_LABEL: Record<LibraryEntryKind, string> = {
  download: "Download",
  media: "Media",
  torrent: "Torrent",
};

const KIND_ICON: Record<LibraryEntryKind, ReactNode> = {
  download: <ArrowDownloadRegular />,
  media: <VideoClipMultipleRegular />,
  torrent: <ArrowSquareDownRegular />,
};

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  probing: "Connecting",
  downloading: "Downloading",
  extracting: "Extracting",
  muxing: "Muxing",
  metadata: "Fetching metadata",
  seeding: "Seeding",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function LibraryPage(): ReactNode {
  const styles = useStyles();
  const [tab, setTab] = useState<TabValue>("files");

  return (
    <div className={styles.page}>
      <TabList selectedValue={tab} onTabSelect={(_e, data) => setTab(data.value)}>
        <Tab value="files" icon={<ArrowDownloadRegular />}>
          Files
        </Tab>
        <Tab value="history" icon={<HistoryRegular />}>
          History
        </Tab>
        <Tab value="bookmarks" icon={<BookmarkRegular />}>
          Bookmarks
        </Tab>
      </TabList>
      {tab === "files" ? <FilesTab /> : null}
      {tab === "history" ? <HistoryTab /> : null}
      {tab === "bookmarks" ? <BookmarksTab /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- Files (downloads library)

function FilesTab(): ReactNode {
  const styles = useStyles();
  const downloads = useDownloadsStore((s) => s.jobs);
  const media = useMediaStore((s) => s.jobs);
  const torrents = useTorrentStore((s) => s.jobs);
  const loaded = useDownloadsStore((s) => s.loaded);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LibraryKindFilter>("all");
  const [status, setStatus] = useState<LibraryStatusFilter>("all");
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => mergeLibrary(downloads, media, torrents), [downloads, media, torrents]);
  const visible = useMemo(
    () => filterLibrary(entries, { query, kind, status }),
    [entries, query, kind, status],
  );

  const reveal = async (entry: LibraryEntry, mode: "folder" | "open"): Promise<void> => {
    setError(null);
    try {
      await rpc("app.revealEntry", { kind: entry.kind, id: entry.id, mode });
    } catch (err) {
      setError(describeError(err));
    }
  };

  const removeEntry = async (entry: LibraryEntry, deleteFiles: boolean): Promise<void> => {
    setError(null);
    try {
      if (entry.kind === "download") {
        if (deleteFiles) throw new Error("HTTP download entries keep the finished file on disk");
        await useDownloadsStore.getState().remove(entry.id, false);
      } else if (entry.kind === "media") {
        await useMediaStore.getState().remove(entry.id, deleteFiles);
      } else {
        await useTorrentStore.getState().remove(entry.id, deleteFiles);
      }
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          placeholder="Search files"
          value={query}
          onChange={(_e, data) => setQuery(data.value)}
          contentAfter={<DismissRegular style={{ opacity: query ? 1 : 0.3 }} />}
        />
        <Dropdown
          value={kind === "all" ? "All types" : KIND_LABEL[kind as LibraryEntryKind]}
          selectedOptions={[kind]}
          onOptionSelect={(_e, data) => setKind((data.optionValue as LibraryKindFilter) ?? "all")}
        >
          <Option value="all">All types</Option>
          <Option value="download">Download</Option>
          <Option value="media">Media</Option>
          <Option value="torrent">Torrent</Option>
        </Dropdown>
        <Dropdown
          value={
            status === "all"
              ? "All statuses"
              : status === "active"
                ? "Active"
                : status === "completed"
                  ? "Completed"
                  : "Stopped"
          }
          selectedOptions={[status]}
          onOptionSelect={(_e, data) => setStatus((data.optionValue as LibraryStatusFilter) ?? "all")}
        >
          <Option value="all">All statuses</Option>
          <Option value="active">Active</Option>
          <Option value="completed">Completed</Option>
          <Option value="stopped">Stopped</Option>
        </Dropdown>
      </div>

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? (
        <Text className={styles.empty}>Loading…</Text>
      ) : visible.length === 0 ? (
        <Text className={styles.empty}>
          {entries.length === 0
            ? "Nothing downloaded yet — files appear here across Downloads, Media and Torrents."
            : "No files match the current filters."}
        </Text>
      ) : (
        visible.map((entry) => (
          <div key={`${entry.kind}-${entry.id}`} className={styles.entry}>
            <span className={styles.badge}>
              {KIND_ICON[entry.kind]} {KIND_LABEL[entry.kind]}
            </span>
            <div className={styles.main}>
              <span className={styles.title} title={entry.title}>
                {entry.title}
              </span>
              <span className={styles.meta}>
                {STATUS_LABEL[entry.status] ?? entry.status}
                {entry.totalBytes !== null ? ` · ${formatBytes(entry.totalBytes)}` : ""}
                {` · ${formatDate(entry.updatedAt)}`}
                {entry.path === null ? " · path pending" : ""}
                {entry.errorCode ? ` · ${entry.errorCode}` : ""}
              </span>
            </div>
            <div className={styles.actions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<FolderRegular />}
                title="Show in folder"
                disabled={entry.path === null}
                onClick={() => void reveal(entry, "folder")}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<OpenRegular />}
                title="Open"
                disabled={entry.path === null}
                onClick={() => void reveal(entry, "open")}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                title={
                  entry.canDeleteFiles
                    ? "Delete entry and files"
                    : "Remove entry (finished file stays on disk)"
                }
                onClick={() => void removeEntry(entry, entry.canDeleteFiles)}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ------------------------------------------------------------------------ History

function HistoryTab(): ReactNode {
  const styles = useStyles();
  const history = useBrowserDataStore((s) => s.history);
  const historyQuery = useBrowserDataStore((s) => s.historyQuery);
  const setHistoryQuery = useBrowserDataStore((s) => s.setHistoryQuery);
  const loadHistory = useBrowserDataStore((s) => s.loadHistory);
  const loaded = useBrowserDataStore((s) => s.historyLoaded);
  const storeError = useBrowserDataStore((s) => s.historyError);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    }
  };

  // Group newest-first rows by calendar day.
  const groups = useMemo(() => {
    const out: Array<{ label: string; rows: typeof history }> = [];
    for (const row of history) {
      const label = dayLabel(row.visitedAt);
      const last = out.at(-1);
      if (last && last.label === label) last.rows.push(row);
      else out.push({ label, rows: [row] });
    }
    return out;
  }, [history]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          placeholder="Search history"
          value={historyQuery}
          onChange={(_e, data) => {
            setHistoryQuery(data.value);
            void loadHistory();
          }}
          contentAfter={<ArrowClockwiseRegular style={{ opacity: 0.5 }} />}
        />
        <Button
          appearance="subtle"
          onClick={() =>
            void act(async () => {
              const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
              await useBrowserDataStore.getState().clearHistory(cutoff);
            })
          }
        >
          Clear older than 30 days
        </Button>
        <Button
          appearance="subtle"
          icon={<DeleteRegular />}
          onClick={() =>
            void act(() => useBrowserDataStore.getState().clearHistory())
          }
        >
          Clear all
        </Button>
      </div>

      {error || storeError ? (
        <MessageBar intent="error">
          <MessageBarBody>{error ?? storeError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? (
        <Text className={styles.empty}>Loading…</Text>
      ) : groups.length === 0 ? (
        <Text className={styles.empty}>No history yet — pages you visit in Browse appear here.</Text>
      ) : (
        groups.map((group) => (
          <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <Text className={styles.day}>{group.label}</Text>
            {group.rows.map((row) => (
              <div key={row.id} className={styles.entry}>
                <div className={styles.main}>
                  <span className={styles.title}>{row.title ?? row.url}</span>
                  <span className={styles.meta}>
                    {formatTime(row.visitedAt)} · {row.url}
                  </span>
                </div>
                <div className={styles.actions}>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<OpenRegular />}
                    title="Open in a new tab"
                    onClick={() => void act(() => createTab(row.url))}
                  />
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<DismissRegular />}
                    title="Remove entry"
                    onClick={() =>
                      void act(() => useBrowserDataStore.getState().deleteHistoryEntry(row.id))
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// ------------------------------------------------------------------------ Bookmarks

function BookmarksTab(): ReactNode {
  const styles = useStyles();
  const bookmarks = useBrowserDataStore((s) => s.bookmarks);
  const loaded = useBrowserDataStore((s) => s.bookmarksLoaded);
  const loadBookmarks = useBrowserDataStore((s) => s.loadBookmarks);
  const storeError = useBrowserDataStore((s) => s.bookmarksError);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {error || storeError ? (
        <MessageBar intent="error">
          <MessageBarBody>{error ?? storeError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? (
        <Text className={styles.empty}>Loading…</Text>
      ) : bookmarks.length === 0 ? (
        <Text className={styles.empty}>
          No bookmarks yet — star a page in the Browse address bar to keep it here.
        </Text>
      ) : (
        bookmarks.map((bookmark) => (
          <div key={bookmark.id} className={styles.entry}>
            <div className={styles.main}>
              <span className={styles.title}>{bookmark.title}</span>
              <span className={styles.meta}>{bookmark.url}</span>
            </div>
            <div className={styles.actions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<OpenRegular />}
                title="Open in a new tab"
                onClick={() => void act(() => createTab(bookmark.url))}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<BookmarkRegular />}
                title="Rename"
                onClick={() => setRenaming({ id: bookmark.id, title: bookmark.title })}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                title="Remove bookmark"
                onClick={() => void act(() => useBrowserDataStore.getState().removeBookmark(bookmark.id))}
              />
            </div>
          </div>
        ))
      )}

      <Dialog
        open={renaming !== null}
        onOpenChange={(_e, data) => {
          if (!data.open) setRenaming(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rename bookmark</DialogTitle>
            <DialogContent>
              <Input
                value={renaming?.title ?? ""}
                onChange={(_e, data) =>
                  setRenaming((r) => (r ? { ...r, title: data.value } : r))
                }
                style={{ width: "100%" }}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={!renaming || renaming.title.trim().length === 0}
                onClick={() => {
                  if (!renaming) return;
                  const { id, title } = renaming;
                  setRenaming(null);
                  void act(() => useBrowserDataStore.getState().updateBookmark(id, title.trim()));
                }}
              >
                Save
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
