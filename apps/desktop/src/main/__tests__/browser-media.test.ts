import { describe, expect, it } from "vitest";
import type { MediaManifest, VideoFormat, AudioFormat } from "@syntaxdm/contracts";
import {
  TabMediaIndex,
  buildMediaItemId,
  classifyMediaResponse,
  filenameFromUrl,
  pickBestFormats,
  parseScanResult,
  titleToFilename,
  buildAuthHeaders,
  MAX_ITEMS_PER_TAB,
  MEDIA_SCAN_SCRIPT,
} from "../domains/browser-media.js";

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("classifyMediaResponse", () => {
  it("detects stream manifests by content-type and by extension", () => {
    expect(classifyMediaResponse("https://x/v.m3u8", "application/vnd.apple.mpegurl")).toEqual({
      kind: "manifest",
      mimeType: "application/vnd.apple.mpegurl",
    });
    // servers that lie with octet-stream are rescued by the extension
    expect(classifyMediaResponse("https://x/v.m3u8", "application/octet-stream")).toEqual({
      kind: "manifest",
      mimeType: "application/octet-stream",
    });
    expect(classifyMediaResponse("https://x/v.mpd", "application/dash+xml")).toMatchObject({
      kind: "manifest",
    });
    expect(classifyMediaResponse("https://x/playlist", "application/x-mpegurl")).toMatchObject({
      kind: "manifest",
    });
  });

  it("detects HLS/DASH segments so they can be withheld once a manifest is known", () => {
    expect(classifyMediaResponse("https://x/seg-1.ts", "video/mp2t")).toMatchObject({ kind: "segment" });
    expect(classifyMediaResponse("https://x/seg-2.m4s", null)).toMatchObject({ kind: "segment" });
    expect(classifyMediaResponse("https://x/seg-3.fmp4", "video/iso.segment")).toMatchObject({
      kind: "segment",
    });
  });

  it("detects direct media by content-type with the extension as backfill", () => {
    expect(classifyMediaResponse("https://x/clip.mp4", "video/mp4")).toEqual({
      kind: "video",
      mimeType: "video/mp4",
    });
    expect(classifyMediaResponse("https://x/track", "audio/mp4")).toEqual({
      kind: "audio",
      mimeType: "audio/mp4",
    });
    expect(classifyMediaResponse("https://x/clip.mp4", "application/octet-stream")).toMatchObject({
      kind: "video",
    });
    expect(classifyMediaResponse("https://x/song.mp3", null)).toMatchObject({ kind: "audio" });
    expect(classifyMediaResponse("https://x/movie.mkv", "application/octet-stream")).toMatchObject({
      kind: "video",
    });
  });

  it("ignores non-media responses entirely", () => {
    expect(classifyMediaResponse("https://x/page", "text/html")).toBeNull();
    expect(classifyMediaResponse("https://x/img.png", "image/png")).toBeNull();
    expect(classifyMediaResponse("https://x/api", "application/json")).toBeNull();
    expect(classifyMediaResponse("https://x/noext", "application/octet-stream")).toBeNull();
    expect(classifyMediaResponse("blob:https://x/abc", "video/mp4")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// filename helpers
// ---------------------------------------------------------------------------

describe("filenameFromUrl", () => {
  it("uses the last path segment, decoded and sanitized", () => {
    expect(filenameFromUrl("https://x/a/b/My%20Video.mp4")).toBe("My Video.mp4");
    // the query string is not part of the URL path
    expect(filenameFromUrl("https://x/a/b/ha:ck?mp4")).toBe("ha_ck");
  });

  it("falls back to media.bin when the path has no usable segment", () => {
    expect(filenameFromUrl("https://x/")).toBe("media.bin");
    expect(filenameFromUrl("not a url")).toBe("media.bin");
  });
});

describe("titleToFilename", () => {
  it("strips illegal characters and bounds the length", () => {
    expect(titleToFilename("My: Video/2024")).toBe("My  Video 2024");
    expect(titleToFilename("   ")).toBeNull();
    expect(titleToFilename("x".repeat(500))!.length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// TabMediaIndex
// ---------------------------------------------------------------------------

const item = (url: string, kind: "video" | "audio" | "manifest" | "segment", detectedAt: number, byteSize: number | null = null) => ({
  url,
  kind,
  mimeType: null,
  byteSize,
  origin: "network" as const,
});

describe("TabMediaIndex", () => {
  it("dedupes observations by kind:url and flags changes", () => {
    const idx = new TabMediaIndex();
    const first = idx.observe("t1", item("https://x/a.mp4", "video", 1, 100), 1);
    expect(first.changed).toBe(true);
    expect(first.items).toHaveLength(1);
    const repeat = idx.observe("t1", item("https://x/a.mp4", "video", 1, 100), 2);
    expect(repeat.changed).toBe(false);
    expect(repeat.items).toHaveLength(1);
  });

  it("fills in a still-unknown byte size on a later sighting", () => {
    const idx = new TabMediaIndex();
    idx.observe("t1", item("https://x/a.mp4", "video", 1, null), 1);
    const second = idx.observe("t1", item("https://x/a.mp4", "video", 1, 500), 2);
    expect(second.changed).toBe(true);
    expect(second.items[0]!.byteSize).toBe(500);
  });

  it("lists newest-first and withholds segments while a manifest exists", () => {
    const idx = new TabMediaIndex();
    idx.observe("t1", item("https://x/s1.ts", "segment", 1), 1);
    idx.observe("t1", item("https://x/s2.ts", "segment", 2), 2);
    // no manifest yet → segments are the honest visible reality
    expect(idx.list("t1")).toHaveLength(2);
    idx.observe("t1", item("https://x/index.m3u8", "manifest", 3), 3);
    const listed = idx.list("t1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.kind).toBe("manifest");
  });

  it("keeps tabs isolated, caps at 100 by dropping the oldest, and clears per tab", () => {
    const idx = new TabMediaIndex();
    idx.observe("t1", item("https://x/only-t1.mp4", "video", 1), 1);
    for (let i = 0; i < MAX_ITEMS_PER_TAB + 5; i++) {
      idx.observe("t2", item(`https://x/f${i}.mp4`, "video", 10 + i), 10 + i);
    }
    expect(idx.list("t1")).toHaveLength(1);
    const t2 = idx.list("t2");
    expect(t2).toHaveLength(MAX_ITEMS_PER_TAB);
    // the five oldest (f0..f4) were dropped, newest survive
    expect(t2.some((i) => i.url.endsWith("f4.mp4"))).toBe(false);
    expect(t2.some((i) => i.url.endsWith("f5.mp4"))).toBe(true);
    expect(t2[0]!.url.endsWith(`${MAX_ITEMS_PER_TAB + 4}.mp4`)).toBe(true);

    expect(idx.clear("t1")).toEqual([]);
    expect(idx.list("t1")).toEqual([]);
    expect(idx.get("t1", buildMediaItemId("video", "https://x/only-t1.mp4"))).toBeNull();
  });

  it("get() finds even a withheld segment by id (the list hides it, the index keeps it)", () => {
    const idx = new TabMediaIndex();
    idx.observe("t1", item("https://x/s1.ts", "segment", 1), 1);
    idx.observe("t1", item("https://x/i.m3u8", "manifest", 2), 2);
    expect(idx.list("t1")).toHaveLength(1);
    expect(idx.get("t1", buildMediaItemId("segment", "https://x/s1.ts"))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// one-click format picking
// ---------------------------------------------------------------------------

const video = (id: string, height: number | null, bitrate: number | null, acodec: string | null = null): VideoFormat => ({
  formatId: id,
  container: "mp4",
  extension: "mp4",
  width: null,
  height,
  fps: null,
  vcodec: "avc1",
  acodec,
  vbitrateBps: bitrate,
  fileSizeBytes: null,
});
const audio = (id: string, bitrate: number | null): AudioFormat => ({
  formatId: id,
  container: "m4a",
  extension: "m4a",
  acodec: "mp4a",
  abitrateBps: bitrate,
  sampleRateHz: null,
  channels: null,
  fileSizeBytes: null,
});
const manifest = (videos: VideoFormat[], audios: AudioFormat[]): MediaManifest => ({
  sourceUrl: "https://x/watch/1",
  extractor: "yt-dlp",
  title: "T",
  durationSeconds: null,
  webpageUrl: "https://x/watch/1",
  thumbnailUrl: null,
  isLive: false,
  videos,
  audios,
  subtitles: [],
});

describe("pickBestFormats", () => {
  it("picks the tallest video and the highest-bitrate audio", () => {
    const picked = pickBestFormats(
      manifest(
        [video("360", 360, 1_000_000), video("1080", 1080, 4_000_000), video("720", 720, 2_000_000)],
        [audio("64k", 64_000), audio("128k", 128_000)],
      ),
    );
    expect(picked).toEqual({ videoFormatId: "1080", audioFormatId: "128k" });
  });

  it("handles audio-only and video-only manifests", () => {
    expect(pickBestFormats(manifest([], [audio("128k", 128_000)]))).toEqual({ audioFormatId: "128k" });
    expect(pickBestFormats(manifest([video("1080", 1080, 4_000_000)], []))).toEqual({
      videoFormatId: "1080",
    });
  });

  it("returns null when the manifest offers nothing downloadable", () => {
    expect(pickBestFormats(manifest([], []))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// untrusted scan-result parsing
// ---------------------------------------------------------------------------

describe("parseScanResult", () => {
  it("accepts well-formed findings and drops everything else", () => {
    const raw = [
      { url: "https://x/a.mp4", kind: "video", mimeType: null },
      { url: "blob:https://x/1", kind: "video", mimeType: null }, // non-http(s)
      { url: "https://x/b.mp3", kind: "surprise", mimeType: null }, // bad kind
      { url: 42, kind: "audio", mimeType: null }, // bad url
      null,
      { url: `https://x/${"x".repeat(3000)}.mp4`, kind: "video", mimeType: null }, // too long
      { url: "https://x/c.m4a", kind: "audio", mimeType: "audio/mp4" },
    ];
    const findings = parseScanResult(raw);
    expect(findings).toEqual([
      { url: "https://x/a.mp4", kind: "video", mimeType: null },
      { url: "https://x/c.m4a", kind: "audio", mimeType: "audio/mp4" },
    ]);
  });

  it("caps the entries and rejects non-array input", () => {
    const flood = Array.from({ length: 60 }, (_, i) => ({
      url: `https://x/${i}.mp4`,
      kind: "video",
      mimeType: null,
    }));
    expect(parseScanResult(flood)).toHaveLength(50);
    expect(parseScanResult("nope")).toEqual([]);
    expect(parseScanResult(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scan script sanity (the string that runs inside pages)
// ---------------------------------------------------------------------------

describe("MEDIA_SCAN_SCRIPT", () => {
  it("is read-only: it never assigns into the document and never calls network/bridge APIs", () => {
    expect(MEDIA_SCAN_SCRIPT).not.toMatch(/\bdocument\.(?:createElement|write|body\.innerHTML)/);
    expect(MEDIA_SCAN_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|require|process\./);
    expect(MEDIA_SCAN_SCRIPT).toContain("querySelectorAll(\"video,audio\")");
  });
});

// ---------------------------------------------------------------------------
// credential assembly (fake session at the exact port boundary used)
// ---------------------------------------------------------------------------

function fakeSession(cookies: Array<{ name: string; value: string; path?: string }>) {
  return {
    getUserAgent: () => "SyntaxDM-UA/1.2",
    cookies: {
      get: async (_opts: { url: string }) => cookies,
    },
  } as unknown as Electron.Session;
}

describe("buildAuthHeaders", () => {
  it("assembles UA, Referer and the path-sorted Cookie header", async () => {
    const headers = await buildAuthHeaders(
      fakeSession([
        { name: "wide", value: "1", path: "/" },
        { name: "deep", value: "2", path: "/a/b/c" },
        { name: "mid", value: "3", path: "/a" },
      ]),
      "https://site.com/a/b/c/video.m3u8",
      "https://site.com/a/b/c/page",
    );
    expect(headers["User-Agent"]).toBe("SyntaxDM-UA/1.2");
    expect(headers["Referer"]).toBe("https://site.com/a/b/c/page");
    expect(headers["Cookie"]).toBe("deep=2; mid=3; wide=1");
  });

  it("drops a non-http referer, survives cookie-jar failures, and bounds the header size", async () => {
    const noReferer = await buildAuthHeaders(fakeSession([]), "https://x/v.mp4", "about:blank");
    expect(noReferer["Referer"]).toBeUndefined();
    expect(noReferer["Cookie"]).toBeUndefined();

    const broken = {
      getUserAgent: () => "UA",
      cookies: { get: async () => { throw new Error("jar locked"); } },
    } as unknown as Electron.Session;
    expect((await buildAuthHeaders(broken, "https://x/v.mp4", "https://x/"))["User-Agent"]).toBe("UA");

    const huge = Array.from({ length: 400 }, (_, i) => ({
      name: `c${i}`,
      value: "v".repeat(40),
      path: "/",
    }));
    const bounded = await buildAuthHeaders(fakeSession(huge), "https://x/v.mp4", "https://x/");
    expect(bounded["Cookie"]!.length).toBeLessThan(7_600);
  });
});
