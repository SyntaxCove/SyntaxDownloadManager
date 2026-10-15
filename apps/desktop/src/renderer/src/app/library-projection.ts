import type { DownloadJob, MediaJob, TorrentJob } from "@syntaxdm/contracts";

/**
 * Downloads library projection (Phase 14) — one merged, filterable view over the three
 * authoritative job domains the renderer already mirrors live. Pure and unit-tested; the
 * Library page owns no job state of its own.
 *
 * Rows are the live mirrors of core rows — this module never invents state: a job whose
 * artifact path has not resolved yet shows honestly with path = null and its reveal
 * actions disabled (the reveal method would fail with entry_path_unavailable).
 */

export type LibraryEntryKind = "download" | "media" | "torrent";

export interface LibraryEntry {
  kind: LibraryEntryKind;
  id: string;
  title: string;
  /** Absolute artifact path once resolved (null = probe/mux/metadata has not placed it). */
  path: string | null;
  totalBytes: number | null;
  receivedBytes: number;
  status: string;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  /** Whether this domain's remove(deleteFiles) actually deletes artifacts from disk. */
  canDeleteFiles: boolean;
}

export type LibraryKindFilter = "all" | LibraryEntryKind;
export type LibraryStatusFilter = "all" | "active" | "completed" | "stopped";

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "probing",
  "downloading",
  "extracting",
  "muxing",
  "metadata",
  "seeding",
]);

const POSIX_OR_WIN_SEPARATOR = /[/\\]/;

/** Windows-safe basename (the renderer cannot import node:path). */
export function basename(p: string): string {
  const parts = p.split(POSIX_OR_WIN_SEPARATOR);
  return parts[parts.length - 1] || p;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last ?? parsed.hostname);
  } catch {
    return url;
  }
}

export function fromDownload(job: DownloadJob): LibraryEntry {
  return {
    kind: "download",
    id: job.id,
    title:
      job.filename ??
      (job.destinationPath ? basename(job.destinationPath) : titleFromUrl(job.url)),
    path: job.destinationPath,
    totalBytes: job.totalBytes,
    receivedBytes: job.receivedBytes,
    status: job.status,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    // download.remove deletes the row (+ optional .part sidecar) — never the finished file.
    canDeleteFiles: false,
  };
}

export function fromMedia(job: MediaJob): LibraryEntry {
  return {
    kind: "media",
    id: job.id,
    title:
      job.title ??
      job.filename ??
      (job.destinationPath ? basename(job.destinationPath) : titleFromUrl(job.sourceUrl)),
    path: job.destinationPath,
    totalBytes: job.totalBytes,
    receivedBytes: job.receivedBytes,
    status: job.status,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    canDeleteFiles: true,
  };
}

export function fromTorrent(job: TorrentJob): LibraryEntry {
  return {
    kind: "torrent",
    id: job.id,
    // The wire shape carries no source URI — before metadata resolves the job honestly
    // has no display name; the info hash (when known) is the least-wrong label.
    title: job.name ?? (job.infoHash ? `Magnet ${job.infoHash.slice(0, 12)}…` : "Torrent"),
    path: job.name ? `${job.destinationDir.replace(/[\\/]$/, "")}\\${job.name}` : null,
    totalBytes: job.totalBytes,
    receivedBytes: job.receivedBytes,
    status: job.status,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    canDeleteFiles: true,
  };
}

/** Newest-first merged library. */
export function mergeLibrary(
  downloads: DownloadJob[],
  media: MediaJob[],
  torrents: TorrentJob[],
): LibraryEntry[] {
  return [
    ...downloads.map(fromDownload),
    ...media.map(fromMedia),
    ...torrents.map(fromTorrent),
  ].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function filterLibrary(
  entries: LibraryEntry[],
  filter: { query?: string; kind?: LibraryKindFilter; status?: LibraryStatusFilter },
): LibraryEntry[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (filter.kind && filter.kind !== "all" && entry.kind !== filter.kind) return false;
    if (filter.status && filter.status !== "all") {
      if (filter.status === "completed" && entry.status !== "completed") return false;
      if (filter.status === "active" && !ACTIVE_STATUSES.has(entry.status)) return false;
      if (
        filter.status === "stopped" &&
        (entry.status === "completed" || ACTIVE_STATUSES.has(entry.status))
      ) {
        return false;
      }
    }
    if (query) {
      const haystack = `${entry.title}\n${entry.path ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
