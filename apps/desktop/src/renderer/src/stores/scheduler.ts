import { create } from "zustand";
import type { SchedulerJob } from "@unidm/contracts";
import { onEvent, rpc } from "../bridge.js";
import { describeError } from "./settings.js";

/**
 * Scheduler store — Phase 15. The jobs are mirrors of the core's SQLite rows: the
 * renderer never owns schedule state and never computes fire times. `scheduler.updated`
 * events are authoritative snapshots (create / update / fire with outcome / clock
 * recompute) pushed by the core's 1 s tick.
 */

export type SchedulerActionChoice =
  | "download.create"
  | "download.startAll"
  | "download.pauseAll"
  | "media.download"
  | "torrent.add";

export interface SchedulerDraft {
  kind: SchedulerActionChoice;
  payload: Record<string, unknown>;
  /** Local datetime-local string (`YYYY-MM-DDTHH:mm`); converted to epoch on submit. */
  startLocal: string;
  repeat: "none" | "daily" | "weekly";
  enabled: boolean;
}

interface SchedulerState {
  jobs: SchedulerJob[];
  jobsLoaded: boolean;
  error: string | null;
  loadJobs: () => Promise<void>;
  createJob: (draft: SchedulerDraft) => Promise<boolean>;
  updateJob: (
    id: string,
    patch: { startAt?: number; repeat?: "none" | "daily" | "weekly"; enabled?: boolean; payload?: Record<string, unknown> },
  ) => Promise<void>;
  removeJob: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  upsertJob: (job: SchedulerJob) => void;
  removeLocal: (id: string) => void;
  setEnabledLocal: (id: string, enabled: boolean) => void;
}

/** Convert the draft's datetime-local value to epoch ms; null when unusable. */
export function localInputToEpochMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms → the renderer's local datetime-local string (for edit fields). */
export function epochMsToLocalInput(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  jobs: [],
  jobsLoaded: false,
  error: null,

  loadJobs: async () => {
    const result = await rpc("scheduler.list", {});
    set({ jobs: result.jobs, jobsLoaded: true });
  },

  createJob: async (draft) => {
    const startAt = localInputToEpochMs(draft.startLocal);
    if (startAt === null) {
      set({ error: "pick a start date and time" });
      return false;
    }
    set({ error: null });
    try {
      const result = await rpc("scheduler.create", {
        kind: draft.kind,
        payload: draft.payload,
        startAt,
        repeat: draft.repeat,
        enabled: draft.enabled,
      });
      get().upsertJob(result.job);
      return true;
    } catch (err) {
      set({ error: describeError(err) });
      return false;
    }
  },

  updateJob: async (id, patch) => {
    try {
      const result = await rpc("scheduler.update", { id, patch });
      get().upsertJob(result.job);
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  removeJob: async (id) => {
    try {
      await rpc("scheduler.remove", { id });
      get().removeLocal(id);
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  runNow: async (id) => {
    try {
      const result = await rpc("scheduler.runNow", { id });
      get().upsertJob(result.job);
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  upsertJob: (job) =>
    set((state) => ({
      jobs: state.jobs.some((j) => j.id === job.id)
        ? state.jobs.map((j) => (j.id === job.id ? job : j))
        : [job, ...state.jobs],
    })),

  removeLocal: (id) => set((state) => ({ jobs: state.jobs.filter((j) => j.id !== id) })),

  /** Optimistic toggle so the Switch feels instant; the snapshot event confirms it. */
  setEnabledLocal: (id, enabled) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)),
    })),
}));

/** Wire the core's scheduler events once per renderer session. Returns the unsubscribe. */
export function subscribeSchedulerEvents(): () => void {
  return onEvent("scheduler.updated", ({ job }) => {
    useSchedulerStore.getState().upsertJob(job);
  });
}
