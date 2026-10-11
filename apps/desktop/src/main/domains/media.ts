import { METHODS } from "@unidm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Media IPC surface — thin, validated proxy between the renderer and the Rust core.
 *
 * Phase 11 registered `media.inspect`; Phase 12 adds the persistent pipeline methods
 * (`media.download/list/get/pause/resume/cancel/remove`). The router validates params and
 * results against the contracts; the core validates again and enforces its own security
 * posture (fail-closed tool/proxy resolution, http(s)-only URLs, argv hygiene). The core's
 * `media.progress` / `media.updated` events reach the renderer through the global core-event
 * forwarding registered by the download domain.
 */
export function registerMediaDomain(router: IpcRouter, supervisor: CoreSupervisor): void {
  const entries = [
    "media.inspect",
    "media.download",
    "media.list",
    "media.get",
    "media.pause",
    "media.resume",
    "media.cancel",
    "media.remove",
  ] as const;

  for (const method of entries) {
    const entry = METHODS[method];
    router.handle(method, {
      paramsSchema: entry.params,
      resultSchema: entry.result,
      // `media.inspect` can legitimately run tens of seconds on slow sites (the core
      // enforces its own 90 s budget); every other media method returns promptly.
      handler: async (params) =>
        supervisor.request(method, params, method === "media.inspect" ? 120_000 : 30_000),
    });
  }
}
