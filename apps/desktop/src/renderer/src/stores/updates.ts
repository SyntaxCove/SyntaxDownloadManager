import { create } from "zustand";
import type { UpdateState } from "@unidm/contracts";
import { onEvent, rpc } from "../bridge.js";

/**
 * Update store (Phase 18) — a dumb mirror of main's updater snapshot. Every lifecycle
 * decision lives in the main-process controller; the renderer triggers consent points
 * (check / download / install) and renders state. `update.state` carries the FULL
 * UpdateState on every transition (progress throttled main-side), so there is no
 * client-side transition logic to keep in sync.
 */

interface UpdateStoreState {
  state: UpdateState | null;
  loaded: boolean;
  load: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  state: null,
  loaded: false,

  load: async () => {
    const { state } = await rpc("update.getState", {});
    set({ state, loaded: true });
  },

  check: async () => {
    await rpc("update.check", {});
    // started=false cases re-emit the snapshot main-side; pull it either way so the
    // precondition failure (e.g. unavailable) is visible without waiting for the event.
    await get().load();
  },

  download: async () => {
    await rpc("update.download", {});
    await get().load();
  },

  install: async () => {
    await rpc("update.install", {});
    // On acceptance the app quits; if the precondition failed, the refreshed snapshot
    // carries the classified error instead.
    await get().load();
  },
}));

/** Wired once from main.tsx: live updater state without polling. */
export function subscribeUpdateState(): void {
  onEvent("update.state", (payload) => {
    useUpdateStore.setState({ state: payload as UpdateState, loaded: true });
  });
}
