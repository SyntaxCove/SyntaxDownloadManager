import { create } from "zustand";
import type { MediaContainer, MediaJob, MediaManifest, MediaSubtitleSelection } from "@unidm/contracts";
import { onEvent, rpc } from "../bridge.js";
import { describeError } from "./settings.js";

/**
 * Media store — Phase 11 inspection lifecycle + Phase 12 persistent media jobs.
 *
 * `media.updated` events are authoritative snapshots; `media.progress` events patch live
 * fields (throttled ~500ms by the core). The jobs are mirrors of the core's SQLite rows —
 * the renderer never owns job state.
 */

export type MediaInspectPhase = "idle" | "inspecting" | "ready" | "error";

export interface MediaSelection {
  videoFormatId: string | null;
  audioFormatId: string | null;
  subtitles: MediaSubtitleSelection[];
  container: MediaContainer;
}

interface MediaState {
  // inspection (Phase 11)
  phase: MediaInspectPhase;
  url: string;
  manifest: MediaManifest | null;
  /** Classified error message (code + text) from the last failed inspect. */
  error: string | null;
  setUrl: (url: string) => void;
  inspect: (proxyProfileId?: string) => Promise<void>;
  reset: () => void;

  // pipeline jobs (Phase 12)
  jobs: MediaJob[];
  jobsLoaded: boolean;
  selection: MediaSelection;
  setSelection: (patch: Partial<MediaSelection>) => void;
  resetSelection: () => void;
  loadJobs: () => Promise<void>;
  download: (params: {
    url: string;
    destinationDir: string;
    proxyProfileId?: string | null;
    filename?: string;
  }) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string, deleteFiles: boolean) => Promise<void>;
  upsertJob: (job: MediaJob) => void;
  patchProgress: (p: {
    jobId: string;
    phase: string;
    receivedBytes: number;
    totalBytes: number | null;
    speedBps: number;
    etaSeconds: number | null;
  }) => void;
}

export const useMediaStore = create<MediaState>((set, get) => ({
  phase: "idle",
  url: "",
  manifest: null,
  error: null,

  setUrl: (url) => set({ url }),

  inspect: async (proxyProfileId) => {
    const { url, phase } = get();
    if (phase === "inspecting") return;
    const trimmed = url.trim();
    if (!trimmed) return;
    set({ phase: "inspecting", error: null, manifest: null });
    try {
      const result = await rpc("media.inspect", {
        url: trimmed,
        ...(proxyProfileId ? { proxyProfileId } : {}),
      });
      set({ phase: "ready", manifest: result.manifest });
    } catch (err) {
      set({ phase: "error", error: describeError(err) });
    }
  },

  reset: () => set({ phase: "idle", manifest: null, error: null }),

  jobs: [],
  jobsLoaded: false,
  selection: { videoFormatId: null, audioFormatId: null, subtitles: [], container: "mkv" },

  setSelection: (patch) => set((s) => ({ selection: { ...s.selection, ...patch } })),

  resetSelection: () =>
    set({ selection: { videoFormatId: null, audioFormatId: null, subtitles: [], container: "mkv" } }),

  loadJobs: async () => {
    const { jobs } = await rpc("media.list", {});
    set({ jobs, jobsLoaded: true });
  },

  download: async ({ url, destinationDir, proxyProfileId, filename }) => {
    const { selection } = get();
    await rpc("media.download", {
      url,
      destinationDir,
      ...(selection.videoFormatId ? { videoFormatId: selection.videoFormatId } : {}),
      ...(selection.audioFormatId ? { audioFormatId: selection.audioFormatId } : {}),
      ...(selection.subtitles.length > 0 ? { subtitles: selection.subtitles } : {}),
      container: selection.container,
      ...(filename ? { filename } : {}),
      ...(proxyProfileId ? { proxyProfileId } : {}),
    });
    await get().loadJobs();
  },

  pause: async (id) => {
    const { job } = await rpc("media.pause", { id });
    if (job) get().upsertJob(job);
  },

  resume: async (id) => {
    const { job } = await rpc("media.resume", { id });
    if (job) get().upsertJob(job);
  },

  cancel: async (id) => {
    const { job } = await rpc("media.cancel", { id });
    if (job) get().upsertJob(job);
  },

  remove: async (id, deleteFiles) => {
    await rpc("media.remove", { id, deleteFiles });
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },

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
          ? {
              ...j,
              receivedBytes: p.receivedBytes,
              totalBytes: p.totalBytes ?? j.totalBytes,
              speedBps: p.speedBps,
              etaSeconds: p.etaSeconds,
            }
          : j,
      ),
    })),
}));

/** Wired once from main.tsx (the bridge is unavailable at module import time in tests). */
export function subscribeMediaEvents(): void {
  onEvent("media.updated", ({ job }) => {
    useMediaStore.getState().upsertJob(job);
  });
  onEvent("media.progress", (p) => {
    useMediaStore.getState().patchProgress(p);
  });
}
