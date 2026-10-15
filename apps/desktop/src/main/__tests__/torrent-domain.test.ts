import { describe, expect, it, vi } from "vitest";
import {
  METHODS,
  TorrentAddResult,
  ErrorEnvelope,
  SuccessEnvelope,
  SyntaxDmError,
  makeRequest,
  newUlid,
  type TorrentJob,
} from "@syntaxdm/contracts";
import { registerTorrentDomain } from "../domains/torrent.js";
import { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 13 — torrent domain: a validated forwarder to the Rust core. Params must reach
 * the core untouched, results must pass the contract schema, and the exactly-one-source
 * rule must fire at the boundary before the core is touched.
 */

const torrentJobFixture: TorrentJob = {
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0X",
  name: "Sample Torrent",
  status: "queued",
  sourceKind: "torrent",
  infoHash: "0123456789abcdef0123456789abcdef01234567",
  destinationDir: "/home/user/Downloads",
  totalBytes: 262144,
  receivedBytes: 0,
  uploadedBytes: 0,
  downloadSpeedBps: 0,
  uploadSpeedBps: 0,
  peers: 0,
  seeds: 0,
  etaSeconds: null,
  numPieces: 4,
  pieceLength: 65536,
  files: [{ path: "Sample Torrent/sample.txt", size: 262144, offset: 0 }],
  errorCode: null,
  proxyProfileId: null,
  createdAt: 1735689600000,
  updatedAt: 1735689600000,
};

function makeRouterWithFakeCore(
  coreResponse: () => Promise<unknown>,
): { router: IpcRouter; supervisor: CoreSupervisor } {
  const router = new IpcRouter((msg) => console.log(msg));
  const supervisor = {
    request: vi.fn(coreResponse),
  } as unknown as CoreSupervisor;
  registerTorrentDomain(router, supervisor);
  return { router, supervisor };
}

describe("torrent domain (Phase 13)", () => {
  it("all seven methods are core-served with valid schemas", () => {
    for (const m of [
      "torrent.add",
      "torrent.list",
      "torrent.get",
      "torrent.pause",
      "torrent.resume",
      "torrent.cancel",
      "torrent.remove",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
    }
  });

  it("forwards torrent.add params untouched and validates the result", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      job: torrentJobFixture,
    }));
    const params = {
      torrentFileB64: "ZGVmYXVsdA==",
      destinationDir: "/home/user/Downloads",
    };
    const res = await router.handleRequest(
      makeRequest(newUlid(), "torrent.add", params),
      {},
    );
    const ok = res as SuccessEnvelope;
    expect(ok.ok).toBe(true);
    expect(TorrentAddResult.parse(ok.result).job.name).toBe("Sample Torrent");
    expect(supervisor.request).toHaveBeenCalledWith("torrent.add", params, 30_000);
  });

  it("enforces exactly-one-source before the core is touched", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      job: torrentJobFixture,
    }));
    const res = await router.handleRequest(
      makeRequest(newUlid(), "torrent.add", {
        magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40),
        torrentFileB64: "ZGVmYXVsdA==",
        destinationDir: "/home/user/Downloads",
      }),
      {},
    );
    const err = res as ErrorEnvelope;
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("invalid_params");
    expect(supervisor.request).not.toHaveBeenCalled();
  });

  it("forwards lifecycle methods with their params", async () => {
    const { router, supervisor } = makeRouterWithFakeCore(async () => ({
      job: { ...torrentJobFixture, status: "paused" },
    }));
    const id = newUlid();
    await router.handleRequest(makeRequest(newUlid(), "torrent.pause", { id }), {});
    expect(supervisor.request).toHaveBeenCalledWith("torrent.pause", { id }, 30_000);
  });

  it("propagates classified core errors untouched", async () => {
    const { router } = makeRouterWithFakeCore(async () => {
      throw new SyntaxDmError("torrent_invalid_metainfo", "bad bencode");
    });
    const res = await router.handleRequest(
      makeRequest(newUlid(), "torrent.add", {
        torrentFileB64: "!!!!",
        destinationDir: "/home/user/Downloads",
      }),
      {},
    );
    const err = res as ErrorEnvelope;
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("torrent_invalid_metainfo");
  });
});
