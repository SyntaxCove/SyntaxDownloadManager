import { create } from "zustand";
import type { DownloadJob, QueueDirection } from "@unidm/contracts";
import { onEvent, rpc } from "../bridge.js";

/**
 * Downloads store — mirrors core job state. `download.updated` events are authoritative
 * snapshots; `download.progress` events patch live fields (throttled ~500ms by the core).
 */

export type CoreStatus = "starting" | "ready" | "restarting" | "unavailable" | "unknown";

interface DownloadsState {
  jobs: DownloadJob[];
  core: CoreStatus;
  loaded: boolean;
  load: () => Promise<void>;
  setCore: (status: CoreStatus) => void;
  upsertJob: (job: DownloadJob) => void;
  patchProgress: (p: {
    jobId: string;
    receivedBytes: number;
    totalBytes: number | null;
    speedBps: number;
    etaSeconds: number | null;
  }) => void;
  create: (url: string, destinationDir: string, proxyProfileId?: string | null) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string, deletePartialFile: boolean) => Promise<void>;
  /** Phase 7: re-acquire the source, revalidate the part, rebind and requeue. */
  recover: (id: string) => Promise<void>;
  /** Phase 7: rebind a dead/expired source to a new URL (bytes and journal kept). */
  replaceUrl: (id: string, url: string) => Promise<void>;
  /** Phase 7: requeue a failed/canceled/paused job (re-probe + gap-fill on the next run). */
  retry: (id: string) => Promise<void>;
  /** Phase 8: reorder a queued job within the download queue. */
  queueMove: (id: string, direction: QueueDirection) => Promise<void>;
  /** Phase 8: resume every paused job; returns the count. */
  startAll: () => Promise<number>;
  /** Phase 8: pause every queued/probing/downloading job; returns the count. */
  pauseAll: () => Promise<number>;
  /** Phase 8: per-job bandwidth cap in KiB/s (0 = unlimited). */
  setSpeedLimit: (id: string, kbps: number) => Promise<void>;
  /** Phase 9: change the proxy profile a job routes through (null = direct). */
  setProxy: (id: string, proxyProfileId: string | null) => Promise<void>;
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  jobs: [],
  core: "unknown",
  loaded: false,

  load: async () => {
    const { jobs } = await rpc("download.list", {});
    set({ jobs, loaded: true });
  },

  setCore: (core) => set({ core }),

  upsertJob: (job) =>
    set((s) => {
      const idx = s.jobs.findIndex((j) => j.id === job.id);
      const jobs = idx >= 0 ? s.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...s.jobs];
      return { jobs };
    }),

  patchProgress: (p) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === p.jobId
          ? { ...j, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes ?? j.totalBytes, speedBps: p.speedBps, etaSeconds: p.etaSeconds }
          : j,
      ),
    })),

  create: async (url, destinationDir, proxyProfileId) => {
    const { job } = await rpc("download.create", {
      url,
      destinationDir,
      overwrite: false,
      ...(proxyProfileId ? { proxyProfileId } : {}),
    });
    get().upsertJob(job);
  },
  pause: async (id) => {
    const { job } = await rpc("download.pause", { id });
    if (!job) throw new Error("pause failed: job not found");
    get().upsertJob(job);
  },
  resume: async (id) => {
    const { job } = await rpc("download.resume", { id });
    if (!job) throw new Error("resume failed: job not found");
    get().upsertJob(job);
  },
  cancel: async (id) => {
    const { job } = await rpc("download.cancel", { id });
    if (!job) throw new Error("cancel failed: job not found");
    get().upsertJob(job);
  },
  remove: async (id, deletePartialFile) => {
    await rpc("download.remove", { id, deletePartialFile });
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },
  recover: async (id) => {
    // The outcome (success or classified failure) is carried by the job, not an error.
    const { job } = await rpc("download.recover", { id });
    get().upsertJob(job);
  },
  replaceUrl: async (id, url) => {
    const { job } = await rpc("download.replaceUrl", { id, url });
    get().upsertJob(job);
  },
  retry: async (id) => {
    const { job } = await rpc("download.retry", { id });
    get().upsertJob(job);
  },
  queueMove: async (id, direction) => {
    const { job } = await rpc("download.queueMove", { id, direction });
    get().upsertJob(job);
  },
  startAll: async () => {
    const { started } = await rpc("download.startAll", {});
    await get().load();
    return started;
  },
  pauseAll: async () => {
    const { paused } = await rpc("download.pauseAll", {});
    await get().load();
    return paused;
  },
  setSpeedLimit: async (id, kbps) => {
    const { job } = await rpc("download.setSpeedLimit", { id, kbps });
    get().upsertJob(job);
  },
  setProxy: async (id, proxyProfileId) => {
    const { job } = await rpc("download.setProxy", { id, proxyProfileId });
    get().upsertJob(job);
  },
}));

/** Wired once from main.tsx. */
export function subscribeDownloadEvents(): void {
  onEvent("download.updated", ({ job }) => useDownloadsStore.getState().upsertJob(job));
  onEvent("download.progress", (p) => useDownloadsStore.getState().patchProgress(p));
  onEvent("core.state", ({ status }) => useDownloadsStore.getState().setCore(status));
}

/**
 * Phase 8 display order (stable within a group): active runs first (store order),
 * then the waiting queue in slot order (ties by creation time), then everything else.
 */
export function compareQueueDisplay(a: DownloadJob, b: DownloadJob): number {
  const rank = (j: DownloadJob): 0 | 1 | 2 => {
    if (j.status === "probing" || j.status === "downloading") return 0;
    if (j.status === "queued") return 1;
    return 2;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) {
    const pa = a.queuePosition ?? Number.MAX_SAFE_INTEGER;
    const pb = b.queuePosition ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || a.createdAt - b.createdAt;
  }
  return 0;
}
