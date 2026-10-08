import { EVENTS, METHODS } from "@unidm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Download domain — thin, validated proxy between the renderer and the Rust core.
 * The router validates params/results against the contracts; the core validates again
 * (defense in depth). Concurrency changes propagate whenever settings change.
 */
export function registerDownloadDomain(router: IpcRouter, supervisor: CoreSupervisor): void {
  type DownloadMethod =
    | "download.create"
    | "download.list"
    | "download.get"
    | "download.pause"
    | "download.resume"
    | "download.cancel"
    | "download.remove"
    | "download.recover"
    | "download.replaceUrl"
    | "download.retry"
    | "download.queueMove"
    | "download.startAll"
    | "download.pauseAll"
    | "download.setSpeedLimit";

  for (const method of [
    "download.create",
    "download.list",
    "download.get",
    "download.pause",
    "download.resume",
    "download.cancel",
    "download.remove",
    "download.recover",
    "download.replaceUrl",
    "download.retry",
    "download.queueMove",
    "download.startAll",
    "download.pauseAll",
    "download.setSpeedLimit",
  ] as const satisfies readonly DownloadMethod[]) {
    const entry = METHODS[method];
    router.handle(method, {
      paramsSchema: entry.params,
      resultSchema: entry.result,
      handler: async (params) => supervisor.request(method, params),
    });
  }

  // Forward core events to the renderer after payload validation (CoreClient already
  // validated; the router validates again on emit).
  supervisor.on("event", (name: string, payload: unknown) => {
    const entry = EVENTS[name as keyof typeof EVENTS];
    if (entry) router.emit(name, entry.payload, payload);
  });
}
