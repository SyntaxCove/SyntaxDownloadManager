import { beforeEach, describe, expect, it } from "vitest";
import { useTorrentStore, subscribeTorrentEvents } from "../stores/torrent.js";
import type { TorrentJob } from "@unidm/contracts";

/**
 * Phase 13 — torrent store against a stubbed preload bridge: the add lifecycle
 * (exactly-one-source, trimmed magnet, proxy passthrough), the job lifecycle
 * (pause/resume/cancel/remove), and the event model (authoritative `torrent.updated`
 * snapshots + throttled `torrent.progress` patches).
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];
let coreError: { code: string; message: string } | null = null;

const jobFixture = (patch: Partial<TorrentJob> = {}): TorrentJob => ({
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
  ...patch,
});

function rpcResult(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "torrent.list":
      return { jobs: useTorrentStore.getState().jobs };
    case "torrent.add":
      return { job: jobFixture({ status: "queued" }) };
    case "torrent.pause":
      return { job: jobFixture({ status: "paused" }) };
    case "torrent.resume":
    case "torrent.cancel":
      return { job: jobFixture({ status: "queued" }) };
    case "torrent.remove":
      useTorrentStore.setState({
        jobs: useTorrentStore.getState().jobs.filter((j) => j.id !== String(p.id)),
      });
      return { removed: true };
    default:
      return {};
  }
}

beforeEach(() => {
  calls.length = 0;
  coreError = null;
  useTorrentStore.setState({
    jobs: [],
    jobsLoaded: false,
    magnetUri: "",
    addError: null,
  });
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (coreError) return Promise.reject(coreError);
        return Promise.resolve(rpcResult(method, params));
      },
      onEvent: () => () => undefined,
      emit: () => undefined,
    },
  };
});

describe("torrent store (Phase 13)", () => {
  it("add requires a source: empty form refuses without touching the bridge", async () => {
    const ok = await useTorrentStore
      .getState()
      .addTorrent({ destinationDir: "/d", magnetUri: "  " });
    expect(ok).toBe(false);
    expect(useTorrentStore.getState().addError).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("add sends the trimmed magnet and lands the returned job", async () => {
    useTorrentStore.setState({ magnetUri: "  magnet:?xt=urn:btih:" + "a".repeat(40) + "  " });
    const ok = await useTorrentStore
      .getState()
      .addTorrent({ destinationDir: "/home/user/Downloads" });
    expect(ok).toBe(true);
    expect(calls[0]?.method).toBe("torrent.add");
    expect(calls[0]?.params).toEqual({
      destinationDir: "/home/user/Downloads",
      magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40),
    });
    expect(useTorrentStore.getState().jobs).toHaveLength(1);
    expect(useTorrentStore.getState().magnetUri).toBe(""); // form resets after success
  });

  it("add prefers the torrent file and passes the proxy profile id", async () => {
    useTorrentStore.setState({ magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40) });
    const ok = await useTorrentStore.getState().addTorrent({
      destinationDir: "/d",
      magnetUri: "magnet:?xt=urn:btih:" + "b".repeat(40),
      torrentFileB64: "ZGVmYXVsdA==",
      proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4",
    });
    void ok;
    expect(ok).toBe(true);
    expect(calls[0]?.params).toEqual({
      destinationDir: "/d",
      torrentFileB64: "ZGVmYXVsdA==",
      proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4",
    });
  });

  it("classified core failures surface in addError with the code", async () => {
    coreError = { code: "torrent_invalid_metainfo", message: "bad bencode" };
    const ok = await useTorrentStore
      .getState()
      .addTorrent({ destinationDir: "/d", magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40) });
    expect(ok).toBe(false);
    expect(useTorrentStore.getState().addError).toContain("torrent_invalid_metainfo");
  });

  it("pause/resume/cancel return authoritative snapshots into the store", async () => {
    useTorrentStore.setState({ jobs: [jobFixture()] });
    await useTorrentStore.getState().pause("01JD8W3G5XQ9V4M2K7PZ6N8S0X");
    expect(useTorrentStore.getState().jobs[0]?.status).toBe("paused");
    await useTorrentStore.getState().resume("01JD8W3G5XQ9V4M2K7PZ6N8S0X");
    expect(useTorrentStore.getState().jobs[0]?.status).toBe("queued");
    await useTorrentStore.getState().cancel("01JD8W3G5XQ9V4M2K7PZ6N8S0X");
    expect(useTorrentStore.getState().jobs[0]?.status).toBe("queued");
  });

  it("remove with deleteFiles forwards the flag and drops the local row", async () => {
    useTorrentStore.setState({ jobs: [jobFixture()] });
    await useTorrentStore.getState().remove("01JD8W3G5XQ9V4M2K7PZ6N8S0X", true);
    expect(calls[0]?.method).toBe("torrent.remove");
    expect(calls[0]?.params).toEqual({
      id: "01JD8W3G5XQ9V4M2K7PZ6N8S0X",
      deleteFiles: true,
    });
    expect(useTorrentStore.getState().jobs).toHaveLength(0);
  });

  it("torrent.updated events replace the job; torrent.progress patches live fields", () => {
    const unsubscribe = subscribeTorrentEvents();
    // The bridge stub routes events through window.unidm (delivery itself is covered by
    // the bridge layer), so here we exercise the store reducers directly.
    useTorrentStore.getState().upsertJob(jobFixture({ status: "downloading" }));
    useTorrentStore.getState().upsertJob(
      jobFixture({ status: "seeding", receivedBytes: 262144 }),
    );
    expect(useTorrentStore.getState().jobs[0]?.status).toBe("seeding");
    useTorrentStore.getState().patchProgress({
      jobId: "01JD8W3G5XQ9V4M2K7PZ6N8S0X",
      receivedBytes: 131072,
      totalBytes: 262144,
      downloadSpeedBps: 4096,
      uploadSpeedBps: 512,
      peers: 3,
      seeds: 1,
      etaSeconds: 32,
    });
    const patched = useTorrentStore.getState().jobs[0];
    expect(patched?.downloadSpeedBps).toBe(4096);
    expect(patched?.peers).toBe(3);
    expect(patched?.status).toBe("seeding"); // progress patches never touch status
    unsubscribe();
  });

  it("upsert inserts unknown jobs at the head (new-first ordering)", () => {
    useTorrentStore.setState({ jobs: [jobFixture()] });
    useTorrentStore.getState().upsertJob(
      jobFixture({ id: "01JD8W3G5XQ9V4M2K7PZ6N8S0W", name: "Second" }),
    );
    const jobs = useTorrentStore.getState().jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.name).toBe("Second");
  });
});
