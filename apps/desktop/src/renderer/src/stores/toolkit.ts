import { create } from "zustand";
import type { ToolkitStatusResult, ToolkitToolStatus } from "@unidm/contracts";
import { onEvent, rpc } from "../bridge.js";

/**
 * Toolkit store (Phase 10) — status snapshot + live updates from `toolkit.progress`.
 * The renderer is read-mostly: it triggers installs/cancels and renders state; every
 * lifecycle decision stays in main.
 */

interface ToolkitState {
  status: ToolkitStatusResult | null;
  loaded: boolean;
  load: () => Promise<void>;
  ensure: (id: ToolkitToolStatus["id"]) => Promise<void>;
  ensureAll: () => Promise<void>;
  cancel: (id: ToolkitToolStatus["id"]) => Promise<void>;
}

export const useToolkitStore = create<ToolkitState>((set, get) => ({
  status: null,
  loaded: false,

  load: async () => {
    const status = await rpc("toolkit.getStatus", {});
    set({ status, loaded: true });
  },

  ensure: async (id) => {
    await rpc("toolkit.ensure", { id });
    // The ensure call already flipped local state in main; refresh the snapshot so the
    // queued tool shows up as `fetching` even before the first progress event.
    await get().load();
  },

  ensureAll: async () => {
    await rpc("toolkit.ensureAll", {});
    await get().load();
  },

  cancel: async (id) => {
    await rpc("toolkit.cancel", { id });
    await get().load();
  },
}));

/** Wired once from main.tsx: live toolkit state without polling. */
export function subscribeToolkitProgress(): void {
  onEvent("toolkit.progress", (tool) => {
    setTool(tool);
  });
}

function setTool(tool: ToolkitToolStatus): void {
  const { status } = useToolkitStore.getState();
  if (!status) return;
  useToolkitStore.setState({
    status: {
      ...status,
      tools: status.tools.some((t) => t.id === tool.id)
        ? status.tools.map((t) => (t.id === tool.id ? tool : t))
        : [...status.tools, tool],
    },
  });
}
