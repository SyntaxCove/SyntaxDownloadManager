import { METHODS, type ToolkitPathEntry } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { ToolkitManager } from "../toolkit/manager.js";

/**
 * Toolkit IPC surface (Phase 10) — thin adapter: the renderer asks for status / install /
 * cancel; the manager owns every decision. Status changes and throttled progress leave via
 * the `onStatus` callback (wired in main.ts to the `toolkit.progress` event); every
 * ready-tool change is re-pushed to the Rust core (`toolkit.setPaths`) so later media
 * phases resolve only checksum-proven executables.
 */

export function registerToolkitDomain(
  router: IpcRouter,
  manager: ToolkitManager,
  supervisor: CoreSupervisor,
): void {
  const entry = (method: keyof typeof METHODS) => {
    const e = METHODS[method];
    return {
      paramsSchema: e.params as NonNullable<typeof e.params>,
      resultSchema: e.result as NonNullable<typeof e.result>,
    };
  };

  router.handle("toolkit.getStatus", {
    ...entry("toolkit.getStatus"),
    handler: async () => manager.getStatus(),
  });

  router.handle("toolkit.ensureAll", {
    ...entry("toolkit.ensureAll"),
    handler: async () => ({ started: manager.ensureAll() }),
  });

  router.handle("toolkit.ensure", {
    ...entry("toolkit.ensure"),
    handler: async (params) => {
      const { id } = params as { id: ToolkitPathEntry["id"] };
      return { started: manager.ensure(id) };
    },
  });

  router.handle("toolkit.cancel", {
    ...entry("toolkit.cancel"),
    handler: async (params) => {
      const { id } = params as { id: ToolkitPathEntry["id"] };
      return { canceled: manager.cancel(id) };
    },
  });
}

/** Shared by main.ts: the single main→core toolkit push (verified paths only). */
export function pushToolkitPaths(
  supervisor: CoreSupervisor,
  tools: ToolkitPathEntry[],
): void {
  void supervisor
    .request("toolkit.setPaths", { tools })
    .catch(() => undefined); // core not ready — re-pushed on the ready transition
}
