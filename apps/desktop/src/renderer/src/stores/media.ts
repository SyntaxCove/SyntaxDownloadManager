import { create } from "zustand";
import type { MediaManifest } from "@unidm/contracts";
import { rpc } from "../bridge.js";
import { describeError } from "./settings.js";

/**
 * Media store (Phase 11) — one inspection at a time from the UI. The Rust core does the
 * work (bundled yt-dlp, fail-closed tool resolution, hard timeout); the store only tracks
 * the request lifecycle and the last manifest. Format-selection download/merge arrives
 * with Phase 12.
 */

export type MediaInspectPhase = "idle" | "inspecting" | "ready" | "error";

interface MediaState {
  phase: MediaInspectPhase;
  url: string;
  manifest: MediaManifest | null;
  /** Classified error message (code + text) from the last failed inspect. */
  error: string | null;
  setUrl: (url: string) => void;
  inspect: (proxyProfileId?: string) => Promise<void>;
  reset: () => void;
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
}));
