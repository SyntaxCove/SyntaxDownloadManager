import { describe, expect, it, vi } from "vitest";
import {
  METHODS, MediaInspectResult, ErrorEnvelope, SuccessEnvelope, UniDmError,
  makeRequest, newUlid, type MediaManifest,
} from "@unidm/contracts";
import { registerMediaDomain } from "../domains/media.js";
import { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 11 — media domain: a validated forwarder to the Rust core. Params must reach the
 * core untouched, results must pass the contract schema, and the request budget must exceed
 * the core's own 90 s inspection timeout. (File fixtures are loaded through import.meta in
 * ESM-only suites; main tests compile to CJS, so the manifest is inlined here.)
 */

const manifestFixture: MediaManifest = {
  sourceUrl: "https://example.com/watch/abc",
  extractor: "yt-dlp",
  title: "Sample Video",
  durationSeconds: 212.5,
  webpageUrl: "https://example.com/watch/abc",
  thumbnailUrl: "https://example.com/thumbs/abc.jpg",
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

function makeRouterWithFakeCore(
  coreResponse: () => Promise<unknown>,
): { router: IpcRouter; supervisor: CoreSupervisor } {
  const router = new IpcRouter((msg) => console.log(msg));
  const supervisor = {
    request: vi.fn(coreResponse),
  } as unknown as CoreSupervisor;
  registerMediaDomain(router, supervisor);
  return { router, supervisor };
}

describe("media domain (Phase 11)", () => {
  it("media.inspect is a core-served method with valid schemas", () => {
    const entry = METHODS["media.inspect"];
    expect(entry.server).toBe("core");
    expect(
      entry.params!.safeParse({ url: "https://example.com/watch/abc" }).success,
    ).toBe(true);
  });

  it("forwards params untouched and returns a validated manifest", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      manifest: manifestFixture,
    }));
    const res = await router.handleRequest(
      makeRequest(newUlid(), "media.inspect", {
        url: "https://example.com/watch/abc",
      }),
      {},
    );
    const ok = res as SuccessEnvelope;
    expect(ok.ok).toBe(true);
    expect(MediaInspectResult.parse(ok.result).manifest.title).toBe("Sample Video");
    expect(supervisor.request).toHaveBeenCalledWith(
      "media.inspect",
      { url: "https://example.com/watch/abc" },
      120_000,
    );
  });

  it("rejects junk params at the boundary before the core is touched", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      manifest: manifestFixture,
    }));
    const res = await router.handleRequest(
      makeRequest(newUlid(), "media.inspect", { url: 42 }),
      {},
    );
    const err = res as ErrorEnvelope;
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("invalid_params");
    expect(supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects results that drift from the contract (missing isLive)", async () => {
    const bad: Record<string, unknown> = { ...manifestFixture };
    delete bad.isLive;
    const { router } = makeRouterWithFakeCore(async () => ({ manifest: bad }));
    const res = await router.handleRequest(
      makeRequest(newUlid(), "media.inspect", { url: "https://example.com/watch/abc" }),
      {},
    );
    expect((res as ErrorEnvelope).error.code).toBe("internal_error");
  });

  it("propagates classified core errors untouched", async () => {
    const { router } = makeRouterWithFakeCore(async () => {
      // Classified wire errors arrive at the router as UniDmError instances (CoreClient
      // constructs them from the envelope) — the code must survive the forward.
      throw new UniDmError("media_tool_missing", "no yt-dlp");
    });
    const res = await router.handleRequest(
      makeRequest(newUlid(), "media.inspect", { url: "https://example.com/watch/abc" }),
      {},
    );
    const err = res as ErrorEnvelope;
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("media_tool_missing");
  });
});
