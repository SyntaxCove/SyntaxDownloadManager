import { create } from "zustand";
import type { DownloadJob } from "@unidm/contracts";
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
  create: (url: string, destinationDir: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string, deletePartialFile: boolean) => Promise<void>;
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

  create: async (url, destinationDir) => {
    const { job } = await rpc("download.create", { url, destinationDir, overwrite: false });
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
}));

/** Wired once from main.tsx. */
export function subscribeDownloadEvents(): void {
  onEvent("download.updated", ({ job }) => useDownloadsStore.getState().upsertJob(job));
  onEvent("download.progress", (p) => useDownloadsStore.getState().patchProgress(p));
  onEvent("core.state", ({ status }) => useDownloadsStore.getState().setCore(status));
}
