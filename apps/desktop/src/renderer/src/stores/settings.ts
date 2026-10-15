import { create } from "zustand";
import type { AppSettings } from "@syntaxdm/contracts";
import { onEvent, rpc } from "../bridge.js";

/**
 * Settings store — single source of settings state in the renderer.
 * `load()` at startup, optimistic `update()` with rollback, and live sync from other windows
 * via the settings.changed event.
 */

export type SettingsStatus = "loading" | "ready" | "error";

interface SettingsState {
  settings: AppSettings | null;
  status: SettingsStatus;
  /** Last mutation error message for the settings page banner; cleared on next update. */
  error: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<boolean>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  status: "loading",
  error: null,

  load: async () => {
    try {
      const { settings } = await rpc("settings.get", {});
      set({ settings, status: "ready", error: null });
    } catch (err) {
      set({ status: "error", error: describeError(err) });
    }
  },

  update: async (patch) => {
    const previous = get().settings;
    if (previous) set({ settings: { ...previous, ...patch }, error: null }); // optimistic
    try {
      const { settings } = await rpc("settings.setAll", { settings: patch });
      set({ settings, status: "ready" });
      return true;
    } catch (err) {
      set({ settings: previous, error: describeError(err) }); // rollback
      return false;
    }
  },
}));

/** Wired once from main.tsx: keep every window in sync with main-side changes. */
export function subscribeSettingsChanged(): void {
  onEvent("settings.changed", ({ settings }) => {
    useSettingsStore.setState({ settings, status: "ready" });
  });
}

export function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return `${(err as { code: string }).code}: ${(err as { message: string }).message}`;
  }
  return String(err);
}
