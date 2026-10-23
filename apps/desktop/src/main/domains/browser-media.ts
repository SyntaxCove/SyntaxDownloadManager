import { EVENTS, METHODS, SyntaxDmError } from "@syntaxdm/contracts";
import type {
  BrowserMediaItem,
  BrowserMediaKind,
  MediaManifest,
  MediaJob,
} from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { TabManager } from "./tab-manager.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { SettingsStore } from "./settings.js";
import { applyDefaultProxy } from "./download.js";
import { attachBrowserDownloadHandling, type BrowserDownloadDeps } from "./browser-downloads.js";

/**
 * Phase 33 (F-2) — in-browser media detection + one-click download.
 *
 * Detection is MAIN-SIDE only, preserving the Phase 23 posture (no preload on third-party
 * content, no Node in web content):
 *  1. Network sniffing — `session.webRequest.onHeadersReceived` passively classifies every
 *     response on the browser sessions (media content-types / extensions → video | audio |
 *     manifest | segment). Preload fetches and actual playback both travel this path, which
 *     is what makes multi-server players detectable on every server the user switches to.
 *  2. DOM scan — a STATIC, READ-ONLY `executeJavaScript` snippet lists <video>/<audio>/<source>
 *     sources. It runs on demand (`browser.media.scan`), when the user opens the panel, and
 *     debounced after `media-started-playing` (the moment a player switches servers). The
 *     script carries no bridge and gains nothing; its RESULT is untrusted page data and is
 *     strictly validated (http(s) URLs, known kinds, hard caps) before it can enter the index.
 *
 * Findings live in a per-tab TabMediaIndex (deduped by kind+url, capped at 100, segments
 * withheld while any manifest is known for the tab so HLS/DASH playback collapses to the
 * manifest the user should click). Every mutation emits an authoritative per-tab snapshot
 * (`browser.media.updated`) — the renderer never polls.
 *
 * Credentials: `browser.media.download` is orchestrated entirely in main — the tab's own
 * session (per-proxy partitions included) supplies User-Agent (respects the settings
 * override), Referer (page URL) and Cookie (most-specific path first, httpOnly included).
 * Cookies never enter the renderer and are never logged.
 */

// ---------------------------------------------------------------------------
// pure classification (unit-tested)
// ---------------------------------------------------------------------------

const MANIFEST_MIMES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/dash+xml",
]);
const MANIFEST_EXTS = new Set(["m3u8", "mpd", "m3u"]);
const SEGMENT_MIMES = new Set(["video/mp2t", "video/iso.segment", "audio/iso.segment"]);
const SEGMENT_EXTS = new Set(["ts", "m4s", "fmp4", "seg"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "3gp", "ogv"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "wma"]);

export interface MediaClassification {
  kind: BrowserMediaKind;
  mimeType: string | null;
}

/** Extension of a URL path, lowercase, without query/hash (empty when none). */
export function urlExtension(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).at(-1) ?? "";
    const dot = last.lastIndexOf(".");
    if (dot <= 0 || dot === last.length - 1) return "";
    return last.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Classify one response as detected media (or null). Content-type wins, extension
 * backfills for servers that lie with application/octet-stream. Non-http(s) URLs are
 * refused defensively (the webRequest filter already narrows to http(s)).
 */
export function classifyMediaResponse(url: string, contentType: string | null): MediaClassification | null {
  if (!/^https?:\/\//i.test(url)) return null;
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = urlExtension(url);
  if (MANIFEST_MIMES.has(mime) || MANIFEST_EXTS.has(ext)) {
    return { kind: "manifest", mimeType: mime !== "" ? mime : null };
  }
  if (SEGMENT_MIMES.has(mime) || SEGMENT_EXTS.has(ext)) {
    return { kind: "segment", mimeType: mime !== "" ? mime : null };
  }
  if (mime.startsWith("video/") && !mime.includes("mp2t")) {
    return { kind: "video", mimeType: mime };
  }
  if (mime.startsWith("audio/")) {
    return { kind: "audio", mimeType: mime };
  }
  if (VIDEO_EXTS.has(ext)) return { kind: "video", mimeType: mime !== "" ? mime : null };
  if (AUDIO_EXTS.has(ext)) return { kind: "audio", mimeType: mime !== "" ? mime : null };
  return null;
}

/** Download-ready filename from a media URL: decoded last path segment, Windows-safe. */
export function filenameFromUrl(url: string): string {
  const sanitize = (name: string): string =>
    name.replace(/[\r\n]+/g, " ").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 200);
  try {
    const parsed = new URL(url);
    const segment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (segment && segment.trim() !== "") return sanitize(segment);
  } catch {
    // unreachable for validated http(s) URLs — kept total anyway
  }
  return "media.bin";
}

export function buildMediaItemId(kind: BrowserMediaKind, url: string): string {
  return `${kind}:${url}`;
}

/** Per-tab cap — bounded memory and a bounded wire payload (mirrors the zod max(100)). */
export const MAX_ITEMS_PER_TAB = 100;

interface ObserveInput {
  url: string;
  kind: BrowserMediaKind;
  mimeType: string | null;
  byteSize: number | null;
  origin: "network" | "dom";
}

/**
 * Deduplicating, bounded per-tab index of detected media. Duplicate observations collapse
 * by id (kind:url); a repeated network sighting only updates a still-unknown byte size.
 * `list()` withholds segments while any manifest is known for the tab (HLS/DASH flood
 * control) and sorts newest-first.
 */
export class TabMediaIndex {
  private readonly tabs = new Map<string, Map<string, BrowserMediaItem>>();

  observe(tabId: string, input: ObserveInput, now: number): { items: BrowserMediaItem[]; changed: boolean } {
    let map = this.tabs.get(tabId);
    if (!map) {
      map = new Map();
      this.tabs.set(tabId, map);
    }
    const id = buildMediaItemId(input.kind, input.url);
    const existing = map.get(id);
    if (existing) {
      if (existing.byteSize === null && input.byteSize !== null) {
        map.set(id, { ...existing, byteSize: input.byteSize });
        return { items: this.list(tabId), changed: true };
      }
      return { items: this.list(tabId), changed: false };
    }
    map.set(id, {
      id,
      tabId,
      url: input.url,
      kind: input.kind,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      filename: filenameFromUrl(input.url),
      origin: input.origin,
      detectedAt: now,
    });
    this.trim(map);
    return { items: this.list(tabId), changed: true };
  }

  list(tabId: string): BrowserMediaItem[] {
    const map = this.tabs.get(tabId);
    if (!map) return [];
    const manifestSeen = [...map.values()].some((item) => item.kind === "manifest");
    return [...map.values()]
      .filter((item) => !(manifestSeen && item.kind === "segment"))
      .sort((a, b) => b.detectedAt - a.detectedAt);
  }

  get(tabId: string, itemId: string): BrowserMediaItem | null {
    return this.tabs.get(tabId)?.get(itemId) ?? null;
  }

  clear(tabId: string): BrowserMediaItem[] {
    this.tabs.delete(tabId);
    return [];
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId);
  }

  private trim(map: Map<string, BrowserMediaItem>): void {
    while (map.size > MAX_ITEMS_PER_TAB) {
      let oldest: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, item] of map) {
        if (item.detectedAt < oldestAt) {
          oldestAt = item.detectedAt;
          oldest = id;
        }
      }
      if (oldest === null) break;
      map.delete(oldest);
    }
  }
}

/**
 * Auto-pick the best format pair for a one-click stream download: best video by
 * (height, then bitrate), best audio by bitrate; audio-only manifests download audio
 * only; progressive-only manifests download the single embedded-audio video.
 */
export function pickBestFormats(
  manifest: MediaManifest,
): { videoFormatId?: string; audioFormatId?: string } | null {
  const bestVideo = [...manifest.videos].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.vbitrateBps ?? 0) - (a.vbitrateBps ?? 0),
  )[0];
  const bestAudio = [...manifest.audios].sort(
    (a, b) => (b.abitrateBps ?? 0) - (a.abitrateBps ?? 0),
  )[0];
  if (!bestVideo && !bestAudio) return null;
  if (!bestVideo) return { audioFormatId: bestAudio!.formatId };
  const picked: { videoFormatId?: string; audioFormatId?: string } = {
    videoFormatId: bestVideo.formatId,
  };
  if (bestAudio) picked.audioFormatId = bestAudio.formatId;
  return picked;
}

/**
 * The in-page scan script — a static, read-only snapshot of media elements. No bridge,
 * no Node, nothing mutable: it only reads `src`/`currentSrc` attributes. The RESULT is
 * page-controlled data and is validated by `parseScanResult` before use.
 */
export const MEDIA_SCAN_SCRIPT = `(() => {
  const found = [];
  const seen = new Set();
  const push = (url, kind, mimeType) => {
    if (typeof url === "string" && /^https?:\\/\\//i.test(url) && url.length <= 2048 && !seen.has(url)) {
      seen.add(url);
      found.push({ url: url, kind: kind, mimeType: mimeType });
    }
  };
  for (const el of document.querySelectorAll("video,audio")) {
    const src = el.currentSrc || el.src || "";
    if (src) push(src, el.tagName === "VIDEO" ? "video" : "audio", null);
  }
  for (const el of document.querySelectorAll("video source,audio source")) {
    const src = el.src || "";
    if (src) {
      const parent = el.parentElement ? el.parentElement.tagName : "AUDIO";
      push(src, parent === "VIDEO" ? "video" : "audio", el.getAttribute("type"));
    }
  }
  return found;
})()`;

export interface ScanFinding {
  url: string;
  kind: "video" | "audio";
  mimeType: string | null;
}

/** Validate the untrusted page-provided scan result (hard caps, strict shapes). */
export function parseScanResult(raw: unknown): ScanFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanFinding[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { url, kind, mimeType } = entry as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 2048) continue;
    if (kind !== "video" && kind !== "audio") continue;
    if (mimeType !== null && (typeof mimeType !== "string" || mimeType.length > 255)) continue;
    out.push({ url, kind, mimeType: typeof mimeType === "string" ? mimeType : null });
  }
  return out;
}

/** Sanitize a manifest title into a base filename (or null when nothing usable remains). */
export function titleToFilename(title: string): string | null {
  const cleaned = title.replace(/[\r\n]+/g, " ").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 120);
  return cleaned !== "" ? cleaned : null;
}

/**
 * The credential bundle for a tab-context download: effective session UA (settings
 * override respected), the page URL as Referer, and the session's cookies as one
 * Cookie header (most-specific path first; the tail is dropped first at the cap).
 */
export async function buildAuthHeaders(
  ses: Electron.Session,
  url: string,
  referer: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const ua = ses.getUserAgent();
  if (ua && ua.trim() !== "" && ua.length <= 512) headers["User-Agent"] = ua;
  if (/^https?:\/\//i.test(referer)) headers["Referer"] = referer;
  let cookies: Array<{ name: string; value: string; path?: string }>;
  try {
    cookies = await ses.cookies.get({ url });
  } catch {
    cookies = []; // a failed cookie read must not fail the download
  }
  if (cookies.length > 0) {
    const sorted = [...cookies].sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
    const parts: string[] = [];
    let total = 0;
    for (const c of sorted) {
      const part = `${c.name}=${c.value}`;
      if (total + part.length + (parts.length > 0 ? 2 : 0) > 7_500) break;
      parts.push(part);
      total += part.length + (parts.length > 1 ? 2 : 0);
    }
    if (parts.length > 0) headers.Cookie = parts.join("; ");
  }
  return headers;
}

function headerValue(
  headers: Record<string, string[]> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      const v = values.at(0);
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// domain registration (Electron-facing)
// ---------------------------------------------------------------------------

export interface BrowserMediaDeps {
  supervisor: Pick<CoreSupervisor, "request" | "isReady">;
  settings: Pick<SettingsStore, "settings">;
  getDownloadDir(): string;
  logger: {
    info(component: string, msg: string, data?: Record<string, unknown>): void;
    warn(component: string, msg: string, data?: Record<string, unknown>): void;
    error(component: string, msg: string, data?: Record<string, unknown>): void;
  };
  /** OS notifications surface the rare F-1 hand-off failure. */
  notify(title: string, body: string): void;
  now?(): number;
}

const SCAN_TIMEOUT_MS = 5_000;
const PLAY_SCAN_DEBOUNCE_MS = 800;

export function registerBrowserMediaDomain(
  router: IpcRouter,
  manager: TabManager,
  deps: BrowserMediaDeps,
): void {
  const index = new TabMediaIndex();
  const now = () => deps.now?.() ?? Date.now();
  const pendingPlayScans = new Map<string, ReturnType<typeof setTimeout>>();

  const emitSnapshot = (tabId: string, items: BrowserMediaItem[]): void => {
    router.emit("browser.media.updated", EVENTS["browser.media.updated"].payload, { tabId, items });
  };

  const runScan = async (tabId: string): Promise<BrowserMediaItem[]> => {
    const wc = manager.webContentsForTab(tabId);
    if (!wc) return index.list(tabId);
    let raw: unknown = null;
    try {
      raw = await Promise.race([
        wc.executeJavaScript(MEDIA_SCAN_SCRIPT, false) as Promise<unknown>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SCAN_TIMEOUT_MS)),
      ]);
    } catch {
      raw = null; // crashed/loading frame — the network sniffer still covers this tab
    }
    let changed = false;
    const findings = parseScanResult(raw);
    for (const finding of findings) {
      const result = index.observe(
        tabId,
        { url: finding.url, kind: finding.kind, mimeType: finding.mimeType, byteSize: null, origin: "dom" },
        now(),
      );
      changed = changed || result.changed;
    }
    if (changed) deps.logger.info("browser-media", "in-page media scan found new media", {
      tabId,
      count: findings.length,
    });
    return index.list(tabId);
  };

  // ---- session attach: F-1 download interception + F-2 network sniffing ----
  manager.setSessionLifecycleObserver((ses) => {
    const downloadDeps: BrowserDownloadDeps = {
      isCoreReady: () => deps.supervisor.isReady,
      createJob: (params) =>
        deps.supervisor.request("download.create", params, 30_000) as Promise<unknown>,
      getDownloadDir: deps.getDownloadDir,
      logger: deps.logger,
      notify: deps.notify,
      now: deps.now,
    };
    attachBrowserDownloadHandling(ses, downloadDeps);

    // Passive media sniffing. The listener NEVER modifies the response — callback({})
    // lets every request proceed unmodified exactly once.
    ses.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      try {
        const classification = classifyMediaResponse(details.url, headerValue(details.responseHeaders, "content-type"));
        if (classification) {
          const tabId =
            details.webContentsId !== undefined ? manager.tabIdForWebContents(details.webContentsId) : null;
          if (tabId) {
            const length = headerValue(details.responseHeaders, "content-length");
            const byteSize = length !== null && /^\d+$/.test(length) ? Number(length) : null;
            const { items, changed } = index.observe(
              tabId,
              {
                url: details.url,
                kind: classification.kind,
                mimeType: classification.mimeType,
                byteSize,
                origin: "network",
              },
              now(),
            );
            if (changed) emitSnapshot(tabId, items);
          }
        }
      } finally {
        callback({});
      }
    });
  });

  // ---- tab activity: navigation clears, playback triggers a debounced DOM scan ----
  manager.setTabActivityObserver((signal) => {
    const timer = pendingPlayScans.get(signal.tabId);
    if (timer) {
      clearTimeout(timer);
      pendingPlayScans.delete(signal.tabId);
    }
    if (signal.type === "pageChanged") {
      const items = index.clear(signal.tabId);
      emitSnapshot(signal.tabId, items);
      return;
    }
    // mediaPlaying — debounce: players fire this per element/segment; one scan suffices.
    const handle = setTimeout(() => {
      pendingPlayScans.delete(signal.tabId);
      void runScan(signal.tabId).then((items) => emitSnapshot(signal.tabId, items)).catch(() => undefined);
    }, PLAY_SCAN_DEBOUNCE_MS);
    pendingPlayScans.set(signal.tabId, handle);
  });

  // ---- tab close: drop the tab's index and any pending scan ----
  router.onEvent((name, payload) => {
    if (name === "browser.tab.closed") {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id === "string") {
        const timer = pendingPlayScans.get(id);
        if (timer) {
          clearTimeout(timer);
          pendingPlayScans.delete(id);
        }
        index.forget(id);
      }
    }
  });

  // ---- IPC surface ----
  router.handle("browser.media.list", {
    paramsSchema: METHODS["browser.media.list"].params,
    resultSchema: METHODS["browser.media.list"].result,
    handler: async (params) => {
      const { tabId } = params as { tabId: string };
      return { items: index.list(tabId) };
    },
  });

  router.handle("browser.media.scan", {
    paramsSchema: METHODS["browser.media.scan"].params,
    resultSchema: METHODS["browser.media.scan"].result,
    handler: async (params) => {
      const { tabId } = params as { tabId: string };
      const items = await runScan(tabId);
      return { items };
    },
  });

  router.handle("browser.media.clear", {
    paramsSchema: METHODS["browser.media.clear"].params,
    resultSchema: METHODS["browser.media.clear"].result,
    handler: async (params) => {
      const { tabId } = params as { tabId: string };
      const items = index.clear(tabId);
      emitSnapshot(tabId, items);
      return { cleared: true };
    },
  });

  router.handle("browser.media.download", {
    paramsSchema: METHODS["browser.media.download"].params,
    resultSchema: METHODS["browser.media.download"].result,
    handler: async (params) => {
      const { tabId, itemId } = params as { tabId: string; itemId: string };
      const item = index.get(tabId, itemId);
      if (!item) {
        throw new SyntaxDmError("invalid_state", "the detected media item no longer exists for this tab");
      }
      const tab = manager.list().find((t) => t.id === tabId) ?? null;
      if (!tab) {
        throw new SyntaxDmError("invalid_state", "the tab does not exist anymore");
      }
      const ses = await manager.sessionForTab(tabId);
      if (!ses) {
        throw new SyntaxDmError("invalid_state", "the tab has no browsing session");
      }
      // Credentials from the tab's own session — cookies never leave main.
      const headers = await buildAuthHeaders(ses, item.url, tab.url);

      if (item.kind === "manifest") {
        const proxyProfileId = tab.proxyProfileId;
        const inspectParams = {
          url: item.url,
          headers,
          ...(proxyProfileId ? { proxyProfileId } : {}),
        };
        const { manifest } = await deps.supervisor.request<{ manifest: MediaManifest }>(
          "media.inspect",
          inspectParams,
          120_000,
        );
        const picked = pickBestFormats(manifest);
        if (!picked) {
          throw new SyntaxDmError("media_extract_failed", "no downloadable video or audio formats were found");
        }
        const baseName = titleToFilename(manifest.title);
        const downloadParams = {
          url: item.url,
          ...picked,
          container: "mkv" as const,
          destinationDir: deps.getDownloadDir(),
          ...(baseName ? { filename: baseName } : {}),
          headers,
          ...(proxyProfileId ? { proxyProfileId } : { proxyProfileId: null }),
        };
        const { job } = await deps.supervisor.request<{ job: MediaJob }>(
          "media.download",
          downloadParams,
          30_000,
        );
        deps.logger.info("browser-media", "stream download started from a detected manifest", {
          tabId,
          filename: baseName ?? item.filename,
          videoFormatId: picked.videoFormatId ?? null,
          audioFormatId: picked.audioFormatId ?? null,
          headerNames: Object.keys(headers).sort(),
        });
        return { kind: "stream" as const, job };
      }

      // Direct media (video/audio/segment): the resumable HTTP engine, same proxy
      // semantics as the Downloads page (tab proxy wins; settings default fills in).
      const createParams = {
        url: item.url,
        destinationDir: deps.getDownloadDir(),
        filename: item.filename,
        overwrite: false,
        headers,
        ...(tab.proxyProfileId
          ? { proxyProfileId: tab.proxyProfileId }
          : {}),
      };
      const withProxy = applyDefaultProxy(createParams, deps.settings.settings.defaultProxyProfileId);
      const { job } = await deps.supervisor.request<{ job: unknown }>(
        "download.create",
        withProxy,
        30_000,
      );
      deps.logger.info("browser-media", "direct media download started", {
        tabId,
        filename: item.filename,
        kind: item.kind,
        headerNames: Object.keys(headers).sort(),
      });
      return { kind: "file" as const, job };
    },
  });
}
