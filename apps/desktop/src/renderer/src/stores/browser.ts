import { create } from "zustand";
import type { BrowserTab } from "@syntaxdm/contracts";
import { onEvent, rpc } from "../bridge.js";

/**
 * Browser store — renderer mirror of main-process tab state. State arrives via events
 * (authoritative), actions are optimistic-free RPC calls (tab creation returns the new tab).
 */

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string | null;
  /** Viewport rect last reported to main (kept so re-activation re-syncs geometry). */
  viewport: { x: number; y: number; width: number; height: number };
  upsertTab: (tab: BrowserTab) => void;
  removeTab: (id: string) => void;
  setActive: (id: string) => void;
  setViewport: (rect: BrowserState["viewport"]) => void;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  viewport: { x: 0, y: 0, width: 0, height: 0 },

  upsertTab: (tab) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tab.id);
      const tabs = idx >= 0 ? s.tabs.map((t) => (t.id === tab.id ? tab : t)) : [...s.tabs, tab];
      return { tabs, activeTabId: tab.id === s.activeTabId || s.activeTabId === null ? tab.id : s.activeTabId };
    }),

  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return { tabs, activeTabId: s.activeTabId === id ? (tabs.at(-1)?.id ?? null) : s.activeTabId };
    }),

  setActive: (id) => set({ activeTabId: id }),
  setViewport: (viewport) => set({ viewport }),
}));

/** Subscribe to main-process tab events; wired once from main.tsx. */
export function subscribeBrowserEvents(): void {
  onEvent("browser.tab.updated", ({ tab }) => useBrowserStore.getState().upsertTab(tab));
  onEvent("browser.tab.closed", ({ id }) => useBrowserStore.getState().removeTab(id));
}

// ---- actions (RPC) ----

export async function createTab(url?: string, proxyProfileId?: string | null): Promise<void> {
  const { tab } = await rpc("browser.tab.create", {
    url,
    activate: true,
    ...(proxyProfileId ? { proxyProfileId } : {}),
  });
  useBrowserStore.getState().upsertTab(tab);
}

/** Phase 9: move a tab onto a proxy profile (or back to direct); main recreates the view. */
export async function setTabProxy(id: string, proxyProfileId: string | null): Promise<void> {
  const { tab } = await rpc("browser.tab.setProxy", { id, proxyProfileId });
  if (tab) useBrowserStore.getState().upsertTab(tab);
}

export async function closeTab(id: string): Promise<void> {
  await rpc("browser.tab.close", { id });
}

export async function activateTab(id: string): Promise<void> {
  useBrowserStore.getState().setActive(id);
  const { tab } = await rpc("browser.tab.activate", { id });
  useBrowserStore.getState().upsertTab(tab);
}

export async function navigateActiveTab(input: string): Promise<void> {
  const id = useBrowserStore.getState().activeTabId;
  if (!id) return;
  const { tab } = await rpc("browser.tab.navigate", { id, url: input });
  useBrowserStore.getState().upsertTab(tab);
}

export async function goBack(): Promise<void> {
  const id = useBrowserStore.getState().activeTabId;
  if (!id) return;
  const { tab } = await rpc("browser.tab.back", { id });
  if (tab) useBrowserStore.getState().upsertTab(tab);
}

export async function goForward(): Promise<void> {
  const id = useBrowserStore.getState().activeTabId;
  if (!id) return;
  const { tab } = await rpc("browser.tab.forward", { id });
  if (tab) useBrowserStore.getState().upsertTab(tab);
}

export async function reloadTab(): Promise<void> {
  const id = useBrowserStore.getState().activeTabId;
  if (!id) return;
  const { tab } = await rpc("browser.tab.reload", { id });
  useBrowserStore.getState().upsertTab(tab);
}

/**
 * Report the browser viewport rect to main; zero-size hides the WebContentsView overlay
 * (used when the shell shows another page). Returns the rpc promise so callers can react.
 */
export async function pushViewportBounds(rect: BrowserState["viewport"]): Promise<void> {
  useBrowserStore.getState().setViewport(rect);
  await rpc("browser.setViewportBounds", rect);
}
