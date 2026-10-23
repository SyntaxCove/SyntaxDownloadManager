import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserMediaStore, subscribeBrowserMediaEvents } from "../stores/browser-media.js";
import type { BrowserMediaItem, DownloadJob, MediaJob } from "@syntaxdm/contracts";

/**
 * Phase 33 — browser-media store against a stubbed preload bridge: the authoritative
 * per-tab snapshot mirror, the exact `browser.media.*` wire params for scan/clear/
 * download, pending-flag bookkeeping, and the tab-close cleanup.
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];

const itemFixture = (patch: Partial<BrowserMediaItem> = {}): BrowserMediaItem => ({
  id: "video:https://cdn.example.com/clip.mp4",
  tabId: "01JTAB00000000000000000001",
  url: "https://cdn.example.com/clip.mp4",
  kind: "video",
  mimeType: "video/mp4",
  byteSize: 1234,
  filename: "clip.mp4",
  origin: "network",
  detectedAt: 1_700_000_000_000,
  ...patch,
});

let eventHandlers = new Map<string, (payload: unknown) => void>();

/** Valid wire shapes — the bridge parses results against the contracts before the store sees them. */
const downloadJobFixture: DownloadJob = {
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T",
  url: "https://cdn.example.com/clip.mp4",
  destinationDir: "/tmp",
  destinationPath: null,
  status: "queued",
  totalBytes: null,
  receivedBytes: 0,
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
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as DownloadJob;

const mediaJobFixture: MediaJob = {
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0V",
  sourceUrl: "https://x/index.m3u8",
  title: null,
  thumbnailUrl: null,
  videoFormatId: null,
  audioFormatId: "0",
  subtitles: [],
  container: "mkv",
  destinationDir: "/tmp",
  destinationPath: null,
  workDir: null,
  status: "queued",
  totalBytes: null,
  receivedBytes: 0,
  speedBps: null,
  etaSeconds: null,
  errorCode: null,
  proxyProfileId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as MediaJob;

function installBridge(overrides?: {
  downloadResult?: unknown;
  downloadError?: unknown;
  scanResult?: { items: BrowserMediaItem[] };
}): void {
  (globalThis as Record<string, unknown>).window = {
    syntaxdm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "browser.media.download") {
          if (overrides?.downloadError) return Promise.reject(overrides.downloadError);
          return Promise.resolve(
            overrides?.downloadResult ?? { kind: "file", job: downloadJobFixture },
          );
        }
        if (method === "browser.media.scan") {
          return Promise.resolve(overrides?.scanResult ?? { items: [itemFixture()] });
        }
        if (method === "browser.media.clear") return Promise.resolve({ cleared: true });
        return Promise.resolve({});
      },
      onEvent: (name: string, cb: (payload: unknown) => void) => {
        eventHandlers.set(name, cb);
        return () => eventHandlers.delete(name);
      },
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  eventHandlers = new Map();
  useBrowserMediaStore.setState({ byTab: {}, panelOpen: false, pending: {} });
  installBridge();
});

describe("browser-media store (Phase 33)", () => {
  it("mirrors the authoritative per-tab snapshot and replaces it wholesale", () => {
    subscribeBrowserMediaEvents();
    const tabId = "01JTAB00000000000000000001";
    const a = itemFixture();
    eventHandlers.get("browser.media.updated")!({ tabId, items: [a] });
    expect(useBrowserMediaStore.getState().byTab[tabId]).toEqual([a]);

    // a navigation clears main-side; the empty snapshot replaces the mirror
    eventHandlers.get("browser.media.updated")!({ tabId, items: [] });
    expect(useBrowserMediaStore.getState().byTab[tabId]).toEqual([]);
  });

  it("drops the mirror when the tab closes", () => {
    subscribeBrowserMediaEvents();
    const tabId = "01JTAB00000000000000000001";
    eventHandlers.get("browser.media.updated")!({ tabId, items: [itemFixture()] });
    expect(useBrowserMediaStore.getState().byTab[tabId]).toHaveLength(1);
    eventHandlers.get("browser.tab.closed")!({ id: tabId });
    expect(useBrowserMediaStore.getState().byTab[tabId]).toBeUndefined();
  });

  it("scan and clear hit their exact methods and refresh the mirror", async () => {
    const tabId = "01JTAB00000000000000000001";
    await useBrowserMediaStore.getState().scan(tabId);
    expect(calls[0]).toEqual({ method: "browser.media.scan", params: { tabId } });
    expect(useBrowserMediaStore.getState().byTab[tabId]).toHaveLength(1);

    await useBrowserMediaStore.getState().clear(tabId);
    expect(calls[1]).toEqual({ method: "browser.media.clear", params: { tabId } });
    expect(useBrowserMediaStore.getState().byTab[tabId]).toEqual([]);
  });

  it("download sends tabId + itemId, reports success, and clears the pending flag", async () => {
    const tabId = "01JTAB00000000000000000001";
    const item = itemFixture();
    await useBrowserMediaStore.getState().download(tabId, item);
    expect(calls[0]).toEqual({
      method: "browser.media.download",
      params: { tabId, itemId: item.id },
    });
    expect(useBrowserMediaStore.getState().pending[item.id]).toBeUndefined();
  });

  it("a double click is swallowed while the first download is in flight", async () => {
    let release!: (v: unknown) => void;
    installBridge({
      downloadResult: new Promise((resolve) => {
        release = resolve;
      }),
    });
    const tabId = "01JTAB00000000000000000001";
    const item = itemFixture();
    const first = useBrowserMediaStore.getState().download(tabId, item);
    await new Promise((r) => setTimeout(r, 0));
    expect(useBrowserMediaStore.getState().pending[item.id]).toBe(true);
    // second click while pending → no second RPC
    void useBrowserMediaStore.getState().download(tabId, item).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.method === "browser.media.download")).toHaveLength(1);
    release({ kind: "file", job: downloadJobFixture });
    await first;
    expect(useBrowserMediaStore.getState().pending[item.id]).toBeUndefined();
  });

  it("a failed download fires the error toast path, rethrows, and clears pending", async () => {
    installBridge({ downloadError: { code: "media_extract_failed", message: "no formats" } });
    const tabId = "01JTAB00000000000000000001";
    const item = itemFixture();
    await expect(useBrowserMediaStore.getState().download(tabId, item)).rejects.toMatchObject({
      code: "media_extract_failed",
    });
    expect(useBrowserMediaStore.getState().pending[item.id]).toBeUndefined();
  });
});
