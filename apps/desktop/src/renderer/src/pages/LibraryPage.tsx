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
import type { LibraryEntryKind } from "@syntaxdm/contracts";
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
import { useI18n } from "../i18n/context.js";
import { formatBytes, formatDate, formatTime } from "../i18n/format.js";

/**
 * Library (Phase 14): downloads library + browser history + bookmarks.
 *
 * Files tab — a projection over the three live job stores (no state of its own). Reveal
 * and open go through `app.revealEntry`, which resolves paths in main from core job rows
 * only. Delete semantics are per-kind and honest: HTTP downloads remove the entry only
 * (the finished file stays on disk), media/torrents can also delete their artifacts.
 * Phase 21: localized strings; icon-only row actions gained accessible names.
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
  actions: { display: "flex", gap: "4px", marginInlineStart: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
  day: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    marginTop: "8px",
  },
});

const KIND_KEYS: Record<LibraryEntryKind, string> = {
  download: "library.kind.download",
  media: "library.kind.media",
  torrent: "library.kind.torrent",
};

const KIND_ICON: Record<LibraryEntryKind, ReactNode> = {
  download: <ArrowDownloadRegular />,
  media: <VideoClipMultipleRegular />,
  torrent: <ArrowSquareDownRegular />,
};

const STATUS_KEYS: Record<string, string> = {
  queued: "library.status.queued",
  probing: "library.status.probing",
  downloading: "library.status.downloading",
  extracting: "library.status.extracting",
  muxing: "library.status.muxing",
  metadata: "library.status.metadata",
  seeding: "library.status.seeding",
  paused: "library.status.paused",
  completed: "library.status.completed",
  failed: "library.status.failed",
  canceled: "library.status.canceled",
};

export function LibraryPage(): ReactNode {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabValue>("files");

  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_e, data) => setTab(data.value)}>
        <Tab value="files" icon={<ArrowDownloadRegular />}>
          {t("library.tab.files")}
        </Tab>
        <Tab value="history" icon={<HistoryRegular />}>
          {t("library.tab.history")}
        </Tab>
        <Tab value="bookmarks" icon={<BookmarkRegular />}>
          {t("library.tab.bookmarks")}
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
  const { t } = useI18n();
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
        if (deleteFiles) throw new Error(t("library.error.httpKeepFile"));
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
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", paddingTop: "12px" }}>
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          placeholder={t("library.searchFiles")}
          value={query}
          onChange={(_e, data) => setQuery(data.value)}
          aria-label={t("library.searchFiles")}
          contentAfter={<DismissRegular aria-hidden="true" style={{ opacity: query ? 1 : 0.3 }} />}
        />
        <Dropdown
          value={kind === "all" ? t("library.filter.allTypes") : t(KIND_KEYS[kind as LibraryEntryKind])}
          selectedOptions={[kind]}
          onOptionSelect={(_e, data) => setKind((data.optionValue as LibraryKindFilter) ?? "all")}
        >
          <Option value="all">{t("library.filter.allTypes")}</Option>
          <Option value="download">{t("library.kind.download")}</Option>
          <Option value="media">{t("library.kind.media")}</Option>
          <Option value="torrent">{t("library.kind.torrent")}</Option>
        </Dropdown>
        <Dropdown
          value={
            status === "all"
              ? t("library.filter.allStatuses")
              : status === "active"
                ? t("library.filter.active")
                : status === "completed"
                  ? t("library.filter.completed")
                  : t("library.filter.stopped")
          }
          selectedOptions={[status]}
          onOptionSelect={(_e, data) => setStatus((data.optionValue as LibraryStatusFilter) ?? "all")}
        >
          <Option value="all">{t("library.filter.allStatuses")}</Option>
          <Option value="active">{t("library.filter.active")}</Option>
          <Option value="completed">{t("library.filter.completed")}</Option>
          <Option value="stopped">{t("library.filter.stopped")}</Option>
        </Dropdown>
      </div>

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? (
        <Text className={styles.empty}>{t("library.loading")}</Text>
      ) : visible.length === 0 ? (
        <Text className={styles.empty}>
          {entries.length === 0 ? t("library.emptyAll") : t("library.emptyFiltered")}
        </Text>
      ) : (
        visible.map((entry) => {
          const statusKey: string | undefined = STATUS_KEYS[entry.status];
          return (
            <div key={`${entry.kind}-${entry.id}`} className={styles.entry}>
              <span className={styles.badge}>
                {KIND_ICON[entry.kind]} {t(KIND_KEYS[entry.kind])}
              </span>
              <div className={styles.main}>
                <span className={styles.title} title={entry.title}>
                  {entry.title}
                </span>
                <span className={styles.meta}>
                  {statusKey ? t(statusKey) : entry.status}
                  {entry.totalBytes !== null ? ` · ${formatBytes(entry.totalBytes, t.lang)}` : ""}
                  {` · ${formatDate(entry.updatedAt, t.lang)}`}
                  {entry.path === null ? ` · ${t("library.pathPending")}` : ""}
                  {entry.errorCode ? ` · ${entry.errorCode}` : ""}
                </span>
              </div>
              <div className={styles.actions}>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<FolderRegular />}
                  aria-label={t("library.action.showInFolder")}
                  title={t("library.action.showInFolder")}
                  disabled={entry.path === null}
                  onClick={() => void reveal(entry, "folder")}
                />
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<OpenRegular />}
                  aria-label={t("library.action.open")}
                  title={t("library.action.open")}
                  disabled={entry.path === null}
                  onClick={() => void reveal(entry, "open")}
                />
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<DeleteRegular />}
                  aria-label={
                    entry.canDeleteFiles ? t("library.action.deleteWithFiles") : t("library.action.removeEntryOnly")
                  }
                  title={
                    entry.canDeleteFiles ? t("library.action.deleteWithFiles") : t("library.action.removeEntryOnly")
                  }
                  onClick={() => void removeEntry(entry, entry.canDeleteFiles)}
                />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ------------------------------------------------------------------------ History

function HistoryTab(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
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
      const label = dayLabel(row.visitedAt, t.lang, t);
      const last = out.at(-1);
      if (last && last.label === label) last.rows.push(row);
      else out.push({ label, rows: [row] });
    }
    return out;
  }, [history, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", paddingTop: "12px" }}>
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          placeholder={t("library.history.search")}
          value={historyQuery}
          onChange={(_e, data) => {
            setHistoryQuery(data.value);
            void loadHistory();
          }}
          aria-label={t("library.history.search")}
          contentAfter={<ArrowClockwiseRegular aria-hidden="true" style={{ opacity: 0.5 }} />}
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
          {t("library.history.clear30")}
        </Button>
        <Button
          appearance="subtle"
          icon={<DeleteRegular />}
          onClick={() =>
            void act(() => useBrowserDataStore.getState().clearHistory())
          }
        >
          {t("library.history.clearAll")}
        </Button>
      </div>

      {error || storeError ? (
        <MessageBar intent="error">
          <MessageBarBody>{error ?? storeError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? (
        <Text className={styles.empty}>{t("library.loading")}</Text>
      ) : groups.length === 0 ? (
        <Text className={styles.empty}>{t("library.history.empty")}</Text>
      ) : (
        groups.map((group) => (
          <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <Text className={styles.day}>{group.label}</Text>
            {group.rows.map((row) => (
              <div key={row.id} className={styles.entry}>
                <div className={styles.main}>
                  <span className={styles.title}>{row.title ?? row.url}</span>
                  <span className={styles.meta}>
                    {formatTime(row.visitedAt, t.lang)} · {row.url}
                  </span>
                </div>
                <div className={styles.actions}>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<OpenRegular />}
                    aria-label={t("library.bookmarks.openInTab")}
                    title={t("library.bookmarks.openInTab")}
                    onClick={() => void act(() => createTab(row.url))}
                  />
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<DismissRegular />}
                    aria-label={t("library.history.removeEntry")}
                    title={t("library.history.removeEntry")}
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
  const { t } = useI18n();
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
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", paddingTop: "12px" }}>
      {error || storeError ? (
        <MessageBar intent="error">
          <MessageBarBody>{error ?? storeError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? (
        <Text className={styles.empty}>{t("library.loading")}</Text>
      ) : bookmarks.length === 0 ? (
        <Text className={styles.empty}>{t("library.bookmarks.empty")}</Text>
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
                aria-label={t("library.bookmarks.openInTab")}
                title={t("library.bookmarks.openInTab")}
                onClick={() => void act(() => createTab(bookmark.url))}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<BookmarkRegular />}
                aria-label={t("library.bookmarks.rename")}
                title={t("library.bookmarks.rename")}
                onClick={() => setRenaming({ id: bookmark.id, title: bookmark.title })}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                aria-label={t("library.bookmarks.remove")}
                title={t("library.bookmarks.remove")}
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
            <DialogTitle>{t("library.bookmarks.renameTitle")}</DialogTitle>
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
                {t("common.cancel")}
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
                {t("common.save")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function dayLabel(ms: number, lang: "en" | "fa", t: (key: string) => string): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return t("library.today");
  if (sameDay(d, yesterday)) return t("library.yesterday");
  return formatDate(ms, lang);
}
