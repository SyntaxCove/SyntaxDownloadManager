import { METHODS } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Torrent IPC surface — thin, validated proxy between the renderer and the Rust core.
 *
 * Phase 13 registered the native torrent engine's seven methods. The router validates
 * params and results against the contracts; the core validates again and enforces its own
 * security posture (fail-closed proxy resolution, sanitized paths, per-piece verification).
 * The core's `torrent.progress` / `torrent.updated` events reach the renderer through the
 * global core-event forwarding registered by the download domain (no forwarding here).
 */
export function registerTorrentDomain(router: IpcRouter, supervisor: CoreSupervisor): void {
  const entries = [
    "torrent.add",
    "torrent.list",
    "torrent.get",
    "torrent.pause",
    "torrent.resume",
    "torrent.cancel",
    "torrent.remove",
  ] as const;

  for (const method of entries) {
    const entry = METHODS[method as keyof typeof METHODS];
    router.handle(method, {
      paramsSchema: entry.params,
      resultSchema: entry.result,
      // torrent.add decodes + parses the metainfo synchronously in the core (fast);
      // every lifecycle method returns promptly (runner-ack waits are bounded).
      handler: async (params) => supervisor.request(method, params, 30_000),
    });
  }
}
