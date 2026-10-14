import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadJob, MediaJob, TorrentJob } from "@unidm/contracts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_CONCURRENT_TOASTS,
  TOAST_TIMEOUT_MS,
  publishToast,
  resetToastBudgetForTests,
  subscribeStatusToasts,
  subscribeToasts,
  toastBudgetForTests,
} from "../app/toasts.js";
import type { ToastInput } from "../app/toasts.js";

/**
 * Phase 17 — renderer toasts: the bus (publish/subscribe/concurrency cap), the status
 * wiring over the preload bridge (same transition rules as main, shared classifier), and
 * the core-state mapping. The ToastHost component itself is Fluent UI; its inputs are
 * exactly these bus payloads.
 */

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../../../packages/contracts/fixtures/domain.json"), "utf8"),
) as { mediaJob: MediaJob; torrentJob: TorrentJob; downloadJob?: DownloadJob };

const downloadJob = (id: string, status: string, path: string | null = null): DownloadJob => ({
  id,
  url: "https://example.com/f.bin",
  destinationDir: "/tmp",
  destinationPath: path,
  status: status as DownloadJob["status"],
  totalBytes: 10,
  receivedBytes: 10,
  etag: null,
  lastModified: null,
  contentType: null,
  speedBps: null,
  etaSeconds: null,
  errorCode: status === "failed" ? "network_error" : null,
  segmentCount: null,
  checksumActual: null,
  checksumVerified: null,
  recoveryCount: null,
  reboundAt: null,
  queuePosition: null,
  proxyProfileId: null,
  createdAt: 1735689600000,
  updatedAt: 1735689600000,
});

type EventSink = (payload: unknown) => void;

const handlers = new Map<string, EventSink>();

function emit(event: string, payload: unknown): void {
  const cb = handlers.get(event);
  if (!cb) throw new Error(`no handler registered for ${event}`);
  cb(payload);
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  resetToastBudgetForTests();
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: () => Promise.resolve({}),
      onEvent: (name: string, cb: EventSink) => {
        handlers.set(name, cb);
        return () => handlers.delete(name);
      },
      emit: () => undefined,
    },
  };
  subscribeStatusToasts();
});

afterEach(() => {
  vi.useRealTimers();
});

function collect(): ToastInput[] {
  const seen: ToastInput[] = [];
  subscribeToasts((t) => seen.push(t));
  return seen;
}

describe("status toast wiring (Phase 17)", () => {
  it("download completion toasts once with the basename; failure carries the error code", () => {
    const seen = collect();
    const id = "01JD8W3G5XQ9V4M2K7PZ6N8S0T";
    emit("download.updated", { job: downloadJob(id, "downloading") });
    emit("download.updated", { job: downloadJob(id, "completed", "/home/u/Files/archive.zip") });
    expect(seen).toEqual([
      { id: seen[0]!.id, title: "Download completed", body: "archive.zip", intent: "success" },
    ]);
    emit("download.updated", { job: downloadJob(id, "completed", "/home/u/Files/archive.zip") });
    expect(seen).toHaveLength(1);

    const other = "01JD8W3G5XQ9V4M2K7PZ6N8S0W";
    emit("download.updated", { job: downloadJob(other, "downloading") });
    emit("download.updated", { job: downloadJob(other, "failed") });
    expect(seen[1]).toMatchObject({
      title: "Download failed",
      body: "f.bin — network_error",
      intent: "error",
    });
  });

  it("media and torrent toasts mirror main-side titles (shared classifier)", () => {
    const seen = collect();
    const mediaId = "01JD8W3G5XQ9V4M2K7PZ6N8S0V";
    emit("media.updated", { job: { ...fixture.mediaJob, id: mediaId, status: "muxing" } });
    emit("media.updated", { job: { ...fixture.mediaJob, id: mediaId, status: "completed" } });
    expect(seen[0]).toMatchObject({ title: "Media ready", body: "Sample Video", intent: "success" });

    const torrentId = "01JD8W3G5XQ9V4M2K7PZ6N8S0X";
    emit("torrent.updated", { job: { ...fixture.torrentJob, id: torrentId, status: "downloading" } });
    emit("torrent.updated", { job: { ...fixture.torrentJob, id: torrentId, status: "seeding" } });
    expect(seen[1]).toMatchObject({ title: "Torrent finished", body: "Sample Torrent", intent: "success" });
    emit("torrent.updated", { job: { ...fixture.torrentJob, id: torrentId, status: "completed" } });
    expect(seen).toHaveLength(2);
  });

  it("core state: boot stays silent; restarting/unavailable toast exactly once", () => {
    const seen = collect();
    emit("core.state", { status: "starting" });
    emit("core.state", { status: "ready" });
    expect(seen).toEqual([]);
    emit("core.state", { status: "restarting" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ intent: "info", title: "Download engine restarting" });
    emit("core.state", { status: "ready" });
    expect(seen).toHaveLength(1);
    emit("core.state", { status: "unavailable" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ intent: "error", title: "Download engine unavailable" });
    emit("core.state", { status: "unavailable" });
    expect(seen).toHaveLength(2);
  });
});

describe("toast bus budget (Phase 17)", () => {
  it("publishes to subscribers and releases slots after the intent timeout", () => {
    const seen = collect();
    publishToast({ title: "a", body: "b", intent: "success" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toMatch(/^t-/);
    expect(toastBudgetForTests()).toBe(1);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS.success + 1);
    expect(toastBudgetForTests()).toBe(0);
  });

  it("drops success/info over the concurrency cap but always passes failures", () => {
    const seen = collect();
    for (let i = 0; i < MAX_CONCURRENT_TOASTS; i += 1) {
      publishToast({ title: `s${i}`, body: "", intent: "success" });
    }
    expect(seen).toHaveLength(MAX_CONCURRENT_TOASTS);
    publishToast({ title: "info-dropped", body: "", intent: "info" });
    expect(seen).toHaveLength(MAX_CONCURRENT_TOASTS);
    publishToast({ title: "err-passes", body: "", intent: "error" });
    expect(seen).toHaveLength(MAX_CONCURRENT_TOASTS + 1);
    expect(seen.at(-1)).toMatchObject({ title: "err-passes", intent: "error" });
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS.error + 1);
    publishToast({ title: "after-drain", body: "", intent: "success" });
    expect(seen).toHaveLength(MAX_CONCURRENT_TOASTS + 2);
  });

  it("unsubscribing stops delivery", () => {
    const seen: ToastInput[] = [];
    const unsubscribe = subscribeToasts((t) => seen.push(t));
    publishToast({ title: "one", body: "", intent: "info" });
    unsubscribe();
    publishToast({ title: "two", body: "", intent: "info" });
    expect(seen.map((t) => t.title)).toEqual(["one"]);
  });
});
