import { METHODS } from "@unidm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Media IPC surface (Phase 11) — thin, validated proxy between the renderer and the Rust
 * core's media inspector. The router validates params/results against the contracts; the
 * core validates again and enforces the security posture (fail-closed tool resolution,
 * http(s)-only URLs, hard timeout, concurrency cap). The media download/merge flow lands
 * with Phase 12 on this same domain.
 */
export function registerMediaDomain(router: IpcRouter, supervisor: CoreSupervisor): void {
  const entry = METHODS["media.inspect"];
  router.handle("media.inspect", {
    paramsSchema: entry.params,
    resultSchema: entry.result,
    // The default IPC timeout is tuned for quick commands; an inspection can legitimately
    // run tens of seconds on slow sites (the core enforces its own 90 s budget).
    handler: async (params) => supervisor.request("media.inspect", params, 120_000),
  });
}
