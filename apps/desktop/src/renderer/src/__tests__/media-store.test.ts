import { beforeEach, describe, expect, it } from "vitest";
import { useMediaStore } from "../stores/media.js";
import type { MediaManifest } from "@unidm/contracts";

/**
 * Phase 11 — media store against a stubbed preload bridge: inspect lifecycle
 * (idle → inspecting → ready / error) and the params actually sent over IPC.
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];

const manifestFixture: MediaManifest = {
  sourceUrl: "https://example.com/watch/abc",
  extractor: "yt-dlp",
  title: "Sample Video",
  durationSeconds: 212.5,
  webpageUrl: "https://example.com/watch/abc",
  thumbnailUrl: null,
  isLive: false,
  videos: [
    {
      formatId: "137",
      container: "mp4",
      extension: "mp4",
      width: 1920,
      height: 1080,
      fps: 30.0,
      vcodec: "avc1.640028",
      acodec: null,
      vbitrateBps: 4500000,
      fileSizeBytes: 118000000,
    },
  ],
  audios: [],
  subtitles: [],
};

let coreError: { code: string; message: string } | null = null;

beforeEach(() => {
  calls.length = 0;
  coreError = null;
  useMediaStore.setState({ phase: "idle", url: "", manifest: null, error: null });
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "media.inspect") {
          if (coreError) return Promise.reject(coreError);
          return Promise.resolve({ manifest: manifestFixture });
        }
        return Promise.resolve({});
      },
      onEvent: () => () => undefined,
      emit: () => undefined,
    },
  };
});

describe("media store (Phase 11)", () => {
  it("inspect sends the trimmed URL through media.inspect and lands on ready", async () => {
    useMediaStore.setState({ url: "  https://example.com/watch/abc  " });
    await useMediaStore.getState().inspect();
    expect(calls[0]?.method).toBe("media.inspect");
    expect(calls[0]?.params).toEqual({ url: "https://example.com/watch/abc" });
    const s = useMediaStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.manifest?.title).toBe("Sample Video");
  });

  it("passes the proxy profile id when one is chosen", async () => {
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    await useMediaStore.getState().inspect("01K33R2VQ7M4X8N6P5T9W1Z3C4");
    expect(calls[0]?.params).toEqual({
      url: "https://example.com/watch/abc",
      proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4",
    });
  });

  it("omits proxyProfileId entirely for direct inspection", async () => {
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    await useMediaStore.getState().inspect(undefined);
    expect(calls[0]?.params).toEqual({ url: "https://example.com/watch/abc" });
  });

  it("classified failures surface as phase=error with the code in the message", async () => {
    coreError = { code: "media_tool_missing", message: "install yt-dlp from Settings" };
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    await useMediaStore.getState().inspect();
    const s = useMediaStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toContain("media_tool_missing");
    expect(s.manifest).toBeNull();
  });

  it("never double-fires while an inspection is in flight", async () => {
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    const first = useMediaStore.getState().inspect();
    const second = useMediaStore.getState().inspect();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
  });

  it("ignores empty URLs without touching the bridge", async () => {
    useMediaStore.setState({ url: "   " });
    await useMediaStore.getState().inspect();
    expect(calls).toHaveLength(0);
    expect(useMediaStore.getState().phase).toBe("idle");
  });
});
