import { METHODS } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Scheduler IPC surface — thin, validated proxy between the renderer and the Rust core.
 *
 * Phase 15 registered the persistent scheduler's five renderer-facing methods. The core
 * validates again and owns the tick, the firing guard and the outcome recording; main
 * never interprets schedule state. `scheduler.setClock` is NOT registered here — it is a
 * main → core method (like `download.setPolicy`), pushed from main.ts. The core's
 * `scheduler.updated` events reach the renderer through the global core-event forwarding
 * registered by the download domain (no forwarding here).
 */
export function registerSchedulerDomain(router: IpcRouter, supervisor: CoreSupervisor): void {
  const entries = [
    "scheduler.list",
    "scheduler.create",
    "scheduler.update",
    "scheduler.remove",
    "scheduler.runNow",
  ] as const;

  for (const method of entries) {
    const entry = METHODS[method as keyof typeof METHODS];
    router.handle(method, {
      paramsSchema: entry.params,
      resultSchema: entry.result,
      // create/update validate payloads synchronously in the core; runNow awaits the
      // dispatched action (probe-free create, runner-ack bounded waits) — 30 s budget.
      handler: async (params) => supervisor.request(method, params, 30_000),
    });
  }
}
