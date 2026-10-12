import { create } from "zustand";
import type { TorrentJob } from "@unidm/contracts";
import { onEvent, rpc } from "../bridge.js";
import { describeError } from "./settings.js";

/**
 * Torrent store — Phase 13. The jobs are mirrors of the core's SQLite rows: the renderer
 * never owns torrent state. `torrent.updated` events are authoritative snapshots;
 * `torrent.progress` events patch live fields (throttled ~500 ms by the core).
 */

interface TorrentState {
  jobs: TorrentJob[];
  jobsLoaded: boolean;
  /** Add-form inputs. */
  magnetUri: string;
  setMagnetUri: (value: string) => void;
  addError: string | null;
  loadJobs: () => Promise<void>;
  addTorrent: (params: {
    destinationDir: string;
    magnetUri?: string;
    torrentFileB64?: string;
    proxyProfileId?: string | null;
  }) => Promise<boolean>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string, deleteFiles: boolean) => Promise<void>;
  upsertJob: (job: TorrentJob) => void;
  removeLocal: (id: string) => void;
  patchProgress: (p: {
    jobId: string;
    receivedBytes: number;
    totalBytes: number | null;
    downloadSpeedBps: number;
    uploadSpeedBps: number;
    peers: number;
    seeds: number;
    etaSeconds: number | null;
  }) => void;
}

function byId(jobs: TorrentJob[], id: string): TorrentJob | undefined {
  return jobs.find((j) => j.id === id);
}

export const useTorrentStore = create<TorrentState>((set, get) => ({
  jobs: [],
  jobsLoaded: false,
  magnetUri: "",
  addError: null,

  setMagnetUri: (value) => set({ magnetUri: value }),

  loadJobs: async () => {
    const result = await rpc("torrent.list", {});
    set({ jobs: result.jobs, jobsLoaded: true });
  },

  addTorrent: async ({ destinationDir, magnetUri, torrentFileB64, proxyProfileId }) => {
    // The magnet URI comes from the caller or from the store's form state; a chosen
    // .torrent file always wins over any magnet text.
    const source = magnetUri ?? get().magnetUri;
    const trimmed = source.trim();
    if (!trimmed && !torrentFileB64) {
      set({ addError: "paste a magnet URI or choose a .torrent file" });
      return false;
    }
    set({ addError: null });
    try {
      const result = await rpc("torrent.add", {
        destinationDir,
        ...(torrentFileB64 ? { torrentFileB64 } : { magnetUri: trimmed }),
        ...(proxyProfileId ? { proxyProfileId } : {}),
      });
      get().upsertJob(result.job);
      set({ magnetUri: "" });
      return true;
    } catch (err) {
      set({ addError: describeError(err) });
      return false;
    }
  },

  pause: async (id) => {
    try {
      const result = await rpc("torrent.pause", { id });
      if (result.job) get().upsertJob(result.job);
    } catch (err) {
      set({ addError: describeError(err) });
    }
  },

  resume: async (id) => {
    try {
      const result = await rpc("torrent.resume", { id });
      if (result.job) get().upsertJob(result.job);
    } catch (err) {
      set({ addError: describeError(err) });
    }
  },

  cancel: async (id) => {
    try {
      const result = await rpc("torrent.cancel", { id });
      if (result.job) get().upsertJob(result.job);
    } catch (err) {
      set({ addError: describeError(err) });
    }
  },

  remove: async (id, deleteFiles) => {
    try {
      await rpc("torrent.remove", { id, deleteFiles });
      get().removeLocal(id);
    } catch (err) {
      set({ addError: describeError(err) });
    }
  },

  upsertJob: (job) =>
    set((state) => {
      const exists = byId(state.jobs, job.id);
      return {
        jobs: exists
          ? state.jobs.map((j) => (j.id === job.id ? job : j))
          : [job, ...state.jobs],
      };
    }),

  removeLocal: (id) =>
    set((state) => ({ jobs: state.jobs.filter((j) => j.id !== id) })),

  patchProgress: (p) =>
    set((state) => ({
      jobs: state.jobs.map((j) => {
        if (j.id !== p.jobId) return j;
        // The authoritative snapshot (torrent.updated) always wins over the throttled
        // progress patch for status/name/error; live fields patch in place.
        return {
          ...j,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes ?? j.totalBytes,
          downloadSpeedBps: p.downloadSpeedBps,
          uploadSpeedBps: p.uploadSpeedBps,
          peers: p.peers,
          seeds: p.seeds,
          etaSeconds: p.etaSeconds,
        };
      }),
    })),
}));

/** Wire the core's torrent events once per renderer session. Returns the unsubscribe. */
export function subscribeTorrentEvents(): () => void {
  const offProgress = onEvent("torrent.progress", (p) => {
    useTorrentStore.getState().patchProgress(p);
  });
  const offUpdated = onEvent("torrent.updated", ({ job }) => {
    useTorrentStore.getState().upsertJob(job);
  });
  return () => {
    offProgress();
    offUpdated();
  };
}
