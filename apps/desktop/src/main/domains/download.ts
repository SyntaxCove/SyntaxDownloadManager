import { EVENTS, METHODS } from "@syntaxdm/contracts";
import type { DownloadCreateParams } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { SettingsStore } from "./settings.js";

/**
 * Download domain — thin, validated proxy between the renderer and the Rust core.
 * The router validates params/results against the contracts; the core validates again
 * (defense in depth). Concurrency changes propagate whenever settings change.
 *
 * Phase 16: `download.create` is the one method that is more than a passthrough — main
 * injects the settings-level default proxy (`defaultProxyProfileId`) into requests that
 * OMIT `proxyProfileId`. An explicit `null` stays "direct", an explicit profile id passes
 * through verbatim. The core never learns settings; a run whose profile is missing from
 * the runtime map keeps the Phase 9 fail-closed pause (`proxy_profile_not_found`).
 */

/**
 * Merge the app-level default proxy into an already-validated create request.
 * Exported for tests: injection keys off the ABSENCE of `proxyProfileId` (the zod schema
 * is `Ulid.nullish()`, so omitted and null are distinguishable here, before the wire).
 */
export function applyDefaultProxy(
  params: DownloadCreateParams,
  defaultProxyProfileId: string | null,
): DownloadCreateParams {
  if (params.proxyProfileId !== undefined) return params;
  if (defaultProxyProfileId === null) return params;
  return { ...params, proxyProfileId: defaultProxyProfileId };
}

export function registerDownloadDomain(
  router: IpcRouter,
  supervisor: CoreSupervisor,
  settingsStore: SettingsStore,
): void {
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
    | "download.setSpeedLimit"
    | "download.setProxy";

  for (const method of [
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
    "download.setProxy",
  ] as const satisfies readonly DownloadMethod[]) {
    const entry = METHODS[method];
    router.handle(method, {
      paramsSchema: entry.params,
      resultSchema: entry.result,
      handler: async (params) => supervisor.request(method, params),
    });
  }

  // download.create: validate → inject the app-level default proxy → proxy to the core.
  const createEntry = METHODS["download.create"];
  router.handle("download.create", {
    paramsSchema: createEntry.params,
    resultSchema: createEntry.result,
    handler: async (raw) => {
      const params = raw as DownloadCreateParams; // schema-validated by the router above
      const withProxy = applyDefaultProxy(params, settingsStore.settings.defaultProxyProfileId);
      return supervisor.request("download.create", withProxy);
    },
  });

  // Forward core events to the renderer after payload validation (CoreClient already
  // validated; the router validates again on emit). This listener covers EVERY core
  // event in the registry — including the media pipeline's `media.progress`/`media.updated`
  // (v1.7, Phase 12) — so the media domain needs no forwarding of its own.
  supervisor.on("event", (name: string, payload: unknown) => {
    const entry = EVENTS[name as keyof typeof EVENTS];
    if (entry) router.emit(name, entry.payload, payload);
  });
}
