import { create } from "zustand";
import type { BrowserMediaItem } from "@syntaxdm/contracts";
import { onEvent, rpc } from "../bridge.js";
import { currentT } from "../i18n/context.js";
import { publishToast } from "../app/toasts.js";
import { describeError } from "./settings.js";

/**
 * Browser-media store — the renderer mirror of main's per-tab media detection
 * (Phase 33). Snapshots arrive authoritative via `browser.media.updated` (full replace
 * per tab); actions are RPC calls. Panel open state and per-item pending flags live
 * here so they survive page switches (BrowsePage unmounts when the shell changes views).
 */

interface BrowserMediaState {
  byTab: Record<string, BrowserMediaItem[]>;
  panelOpen: boolean;
  /** itemId → download in flight (the button disables for the duration). */
  pending: Record<string, boolean>;
  setPanelOpen: (open: boolean) => void;
  upsertSnapshot: (tabId: string, items: BrowserMediaItem[]) => void;
  removeTab: (tabId: string) => void;
  scan: (tabId: string) => Promise<void>;
  clear: (tabId: string) => Promise<void>;
  download: (tabId: string, item: BrowserMediaItem) => Promise<void>;
}

export const useBrowserMediaStore = create<BrowserMediaState>((set, get) => ({
  byTab: {},
  panelOpen: false,
  pending: {},

  setPanelOpen: (open) => set({ panelOpen: open }),

  upsertSnapshot: (tabId, items) =>
    set((s) => ({ byTab: { ...s.byTab, [tabId]: items } })),

  removeTab: (tabId) =>
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      // pending flags are transient (cleared in the download's own finally) — byTab only.
      return { byTab };
    }),

  scan: async (tabId) => {
    const { items } = await rpc("browser.media.scan", { tabId });
    get().upsertSnapshot(tabId, items);
  },

  clear: async (tabId) => {
    await rpc("browser.media.clear", { tabId });
    get().upsertSnapshot(tabId, []);
  },

  download: async (tabId, item) => {
    if (get().pending[item.id]) return;
    set((s) => ({ pending: { ...s.pending, [item.id]: true } }));
    try {
      await rpc("browser.media.download", { tabId, itemId: item.id });
      const t = currentT();
      publishToast({
        intent: "success",
        title: t("browse.mediaDownloadStarted"),
        body: item.filename,
      });
    } catch (err) {
      const t = currentT();
      publishToast({
        intent: "error",
        title: t("browse.mediaDownloadFailed"),
        body: `${item.filename} — ${describeError(err)}`,
      });
      throw err; // callers decide whether to surface more; the toast already fired
    } finally {
      set((s) => {
        const pending = { ...s.pending };
        delete pending[item.id];
        return { pending };
      });
    }
  },
}));

/** Subscribe to main-process media detection events; wired once from main.tsx. */
export function subscribeBrowserMediaEvents(): void {
  onEvent("browser.media.updated", ({ tabId, items }) =>
    useBrowserMediaStore.getState().upsertSnapshot(tabId, items),
  );
  onEvent("browser.tab.closed", ({ id }) => useBrowserMediaStore.getState().removeTab(id));
}
