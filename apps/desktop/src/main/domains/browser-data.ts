import { METHODS } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Browser data domain (Phase 14) — thin, validated proxy between the renderer and the
 * Rust core for browser history + bookmarks (persisted in the core's SQLite database,
 * storage v8). The router validates params/results against the contracts; the core
 * validates again (defense in depth).
 */
export function registerBrowserDataDomain(router: IpcRouter, supervisor: CoreSupervisor): void {
  type BrowserDataMethod =
    | "browser.history.record"
    | "browser.history.list"
    | "browser.history.delete"
    | "browser.history.clear"
    | "browser.bookmark.create"
    | "browser.bookmark.list"
    | "browser.bookmark.getByUrl"
    | "browser.bookmark.update"
    | "browser.bookmark.remove";

  for (const method of [
    "browser.history.record",
    "browser.history.list",
    "browser.history.delete",
    "browser.history.clear",
    "browser.bookmark.create",
    "browser.bookmark.list",
    "browser.bookmark.getByUrl",
    "browser.bookmark.update",
    "browser.bookmark.remove",
  ] as const satisfies readonly BrowserDataMethod[]) {
    const entry = METHODS[method];
    router.handle(method, {
      paramsSchema: entry.params,
      resultSchema: entry.result,
      handler: async (params) => supervisor.request(method, params),
    });
  }
}
