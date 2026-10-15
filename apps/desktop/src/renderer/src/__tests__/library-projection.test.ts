import { describe, expect, it } from "vitest";
import {
  basename,
  filterLibrary,
  fromDownload,
  fromMedia,
  fromTorrent,
  mergeLibrary,
  type LibraryEntry,
} from "../app/library-projection.js";
import type { DownloadJob, MediaJob, TorrentJob } from "@syntaxdm/contracts";

/**
 * Phase 14 — the downloads library projection: one merged, filterable view over the three
 * authoritative job domains. Pure functions; no state of their own.
 */

const download = (patch: Partial<DownloadJob> = {}): DownloadJob => ({
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0D",
  url: "https://example.com/files/report.zip",
  destinationDir: "/home/user/Downloads",
  destinationPath: "/home/user/Downloads/report.zip",
  filename: null,
  status: "completed",
  totalBytes: 1000,
  receivedBytes: 1000,
  etag: null,
  lastModified: null,
  contentType: null,
  speedBps: null,
  etaSeconds: null,
  errorCode: null,
  segmentCount: null,
  checksumActual: null,
  checksumVerified: null,
  recoveryCount: null,
  reboundAt: null,
  queuePosition: null,
  proxyProfileId: null,
  createdAt: 1735689600000,
  updatedAt: 1735689600000,
  ...patch,
});

const media = (patch: Partial<MediaJob> = {}): MediaJob => ({
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0M",
  sourceUrl: "https://example.com/watch/abc",
  title: "Sample Video",
  thumbnailUrl: null,
  videoFormatId: "137",
  audioFormatId: "140",
  subtitles: [],
  container: "mkv",
  destinationDir: "/home/user/Downloads",
  destinationPath: "/home/user/Downloads/Sample Video.mkv",
  workDir: null,
  status: "muxing",
  totalBytes: 2000,
  receivedBytes: 1500,
  speedBps: null,
  etaSeconds: null,
  errorCode: null,
  proxyProfileId: null,
  createdAt: 1735689600000,
  updatedAt: 1735689700000,
  ...patch,
});

const torrent = (patch: Partial<TorrentJob> = {}): TorrentJob => ({
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0X",
  name: "Sample Torrent",
  status: "downloading",
  sourceKind: "torrent",
  infoHash: "0123456789abcdef0123456789abcdef01234567",
  destinationDir: "/home/user/Downloads",
  totalBytes: 262144,
  receivedBytes: 131072,
  uploadedBytes: 0,
  downloadSpeedBps: 0,
  uploadSpeedBps: 0,
  peers: 0,
  seeds: 0,
  etaSeconds: null,
  numPieces: 4,
  pieceLength: 65536,
  files: [],
  errorCode: null,
  proxyProfileId: null,
  createdAt: 1735689600000,
  updatedAt: 1735689800000,
  ...patch,
});

describe("basename", () => {
  it("handles POSIX and Windows separators", () => {
    expect(basename("/home/u/Downloads/file.zip")).toBe("file.zip");
    expect(basename("C:\\Users\\u\\Downloads\\file.zip")).toBe("file.zip");
    expect(basename("file.zip")).toBe("file.zip");
  });
});

describe("fromDownload / fromMedia / fromTorrent", () => {
  it("download: filename beats path basename beats URL segment; files are never deletable", () => {
    const e = fromDownload(download());
    expect(e.title).toBe("report.zip");
    expect(e.path).toBe("/home/user/Downloads/report.zip");
    expect(e.canDeleteFiles).toBe(false);
    const byUrl = fromDownload(download({ destinationPath: null }));
    expect(byUrl.title).toBe("report.zip"); // URL segment
    expect(byUrl.path).toBeNull();
    const explicit = fromDownload(download({ filename: "custom.bin" }));
    expect(explicit.title).toBe("custom.bin");
  });

  it("media: title beats filename beats path basename; files are deletable", () => {
    const e = fromMedia(media());
    expect(e.title).toBe("Sample Video");
    expect(e.canDeleteFiles).toBe(true);
    const untitled = fromMedia(media({ title: null, destinationPath: "/d/movie.mkv" }));
    expect(untitled.title).toBe("movie.mkv");
  });

  it("torrent: name required for a path; unresolved metadata shows path null and honest label", () => {
    const e = fromTorrent(torrent());
    expect(e.title).toBe("Sample Torrent");
    expect(e.path).toBe("/home/user/Downloads\\Sample Torrent");
    expect(e.canDeleteFiles).toBe(true);
    const fresh = fromTorrent(torrent({ name: null, infoHash: null }));
    expect(fresh.title).toBe("Torrent");
    expect(fresh.path).toBeNull();
  });
});

describe("mergeLibrary", () => {
  it("merges all three domains newest-first with a stable id tiebreak", () => {
    const merged = mergeLibrary([download()], [media()], [torrent()]);
    expect(merged.map((e) => e.id)).toEqual([
      "01JD8W3G5XQ9V4M2K7PZ6N8S0X", // updatedAt 1735689800000
      "01JD8W3G5XQ9V4M2K7PZ6N8S0M", // 1735689700000
      "01JD8W3G5XQ9V4M2K7PZ6N8S0D", // 1735689600000
    ]);
  });

  it("kind badges are per-domain and filterable", () => {
    const merged = mergeLibrary([download()], [media()], [torrent()]);
    expect(merged.map((e) => e.kind)).toEqual(["torrent", "media", "download"]);
  });
});

describe("filterLibrary", () => {
  const entries: LibraryEntry[] = mergeLibrary(
    [
      download({ status: "downloading", updatedAt: 1 }),
      download({ id: "01JD8W3G5XQ9V4M2K7PZ6N8S0E", status: "completed", filename: "done.zip", updatedAt: 2 }),
    ],
    [media({ status: "failed", errorCode: "media_mux_failed", updatedAt: 3 })],
    [torrent({ status: "seeding", name: "Linux ISO", updatedAt: 4 })],
  );

  it("kind filter", () => {
    expect(filterLibrary(entries, { kind: "download" }).map((e) => e.kind)).toEqual([
      "download",
      "download",
    ]);
    expect(filterLibrary(entries, { kind: "torrent" })).toHaveLength(1);
    expect(filterLibrary(entries, { kind: "all" })).toHaveLength(4);
  });

  it("status groups map every domain's lifecycle", () => {
    expect(filterLibrary(entries, { status: "active" }).map((e) => e.status)).toEqual([
      "seeding",
      "downloading",
    ]);
    expect(filterLibrary(entries, { status: "completed" }).map((e) => e.status)).toEqual([
      "completed",
    ]);
    expect(filterLibrary(entries, { status: "stopped" }).map((e) => e.status)).toEqual([
      "failed",
    ]);
  });

  it("query matches title and path, case-insensitively", () => {
    expect(filterLibrary(entries, { query: "linux" })).toHaveLength(1);
    expect(filterLibrary(entries, { query: "DONE" })).toHaveLength(1);
    // Both download rows carry /…/report.zip paths, so the path matcher hits both
    // (the completed row's title is done.zip — the path column is real match space).
    expect(filterLibrary(entries, { query: "report" })).toHaveLength(2);
    expect(filterLibrary(entries, { query: "no-such-thing" })).toHaveLength(0);
  });

  it("filters compose", () => {
    const out = filterLibrary(entries, { kind: "download", status: "completed" });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("done.zip");
  });
});
