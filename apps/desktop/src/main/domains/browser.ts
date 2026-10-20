import type { BrowserWindow } from "electron";
import { EVENTS, METHODS, SyntaxDmError, type BrowserTab } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import { TabManager, type ProxyResolver } from "./tab-manager.js";
import type { RecordedVisit } from "./history-recorder.js";
import { normalizeUrlInput } from "./url-input.js";

/**
 * Browser domain registration. All tab mutations happen in the main process; the renderer
 * owns layout (it reports the viewport rect) and receives tab state exclusively through
 * browser.tab.updated / browser.tab.closed events — no polling.
 *
 * Phase 9: `proxyContext` validates profile ids and resolves proxy sessions. Requests
 * naming an unknown profile are refused (fail-closed) instead of silently going direct.
 */
export function registerBrowserDomain(
  router: IpcRouter,
  getWindow: () => BrowserWindow | undefined,
  proxyContext?: { resolveProxy: ProxyResolver; hasProfile: (id: string) => boolean },
  visitSink?: (visit: RecordedVisit & { tabId: string }) => void,
): TabManager {
  const resolver: ProxyResolver = proxyContext?.resolveProxy ?? (async () => null);
  const manager = new TabManager(getWindow, {
    onUpdated: (tab) => router.emit("browser.tab.updated", EVENTS["browser.tab.updated"].payload, { tab }),
    onClosed: (id) => router.emit("browser.tab.closed", EVENTS["browser.tab.closed"].payload, { id }),
    onVisited: (visit) => visitSink?.(visit),
  }, resolver);

  const assertProfile = (id: string | null | undefined): void => {
    if (id && !(proxyContext?.hasProfile(id) ?? false)) {
      throw new SyntaxDmError("proxy_profile_not_found", `proxy profile ${id} not found`);
    }
  };

  const resultJob = (tab: BrowserTab | null) => {
    if (!tab) throw Object.assign(new Error("tab not found"), { code: "invalid_state" });
    return { tab };
  };

  router.handle("browser.tab.create", {
    paramsSchema: METHODS["browser.tab.create"].params,
    resultSchema: METHODS["browser.tab.create"].result,
    handler: async (params) => {
      const p = params as { url?: string; activate?: boolean; proxyProfileId?: string | null };
      assertProfile(p.proxyProfileId);
      const requested = p.url ? normalizeUrlInput(p.url) : { url: "about:blank" as const, kind: "url" as const };
      if (p.url && requested.url === null) {
        throw Object.assign(new Error("url rejected by browser policy"), { code: "url_invalid" });
      }
      return { tab: await manager.create({ url: requested.url ?? undefined, activate: p.activate, proxyProfileId: p.proxyProfileId }) };
    },
  });

  router.handle("browser.tab.close", {
    paramsSchema: METHODS["browser.tab.close"].params,
    resultSchema: METHODS["browser.tab.close"].result,
    handler: async (params) => {
      const { id } = params as { id: string };
      if (!manager.close(id)) throw Object.assign(new Error("tab not found"), { code: "invalid_state" });
      return { closed: true };
    },
  });

  router.handle("browser.tab.activate", {
    paramsSchema: METHODS["browser.tab.activate"].params,
    resultSchema: METHODS["browser.tab.activate"].result,
    handler: async (params) => {
      const { id } = params as { id: string };
      return resultJob(manager.activate(id));
    },
  });

  router.handle("browser.tab.navigate", {
    paramsSchema: METHODS["browser.tab.navigate"].params,
    resultSchema: METHODS["browser.tab.navigate"].result,
    handler: async (params) => {
      const { id, url } = params as { id: string; url: string };
      const normalized = normalizeUrlInput(url);
      if (normalized.url === null) {
        throw Object.assign(new Error("url rejected by browser policy"), { code: "url_invalid" });
      }
      return resultJob(manager.navigate(id, normalized.url));
    },
  });

  router.handle("browser.tab.back", {
    paramsSchema: METHODS["browser.tab.back"].params,
    resultSchema: METHODS["browser.tab.back"].result,
    handler: async (params) => resultJob(manager.back((params as { id: string }).id)),
  });

  router.handle("browser.tab.forward", {
    paramsSchema: METHODS["browser.tab.forward"].params,
    resultSchema: METHODS["browser.tab.forward"].result,
    handler: async (params) => resultJob(manager.forward((params as { id: string }).id)),
  });

  router.handle("browser.tab.reload", {
    paramsSchema: METHODS["browser.tab.reload"].params,
    resultSchema: METHODS["browser.tab.reload"].result,
    handler: async (params) => resultJob(manager.reload((params as { id: string }).id)),
  });

  router.handle("browser.tab.setMuted", {
    paramsSchema: METHODS["browser.tab.setMuted"].params,
    resultSchema: METHODS["browser.tab.setMuted"].result,
    handler: async (params) => {
      const { id, muted } = params as { id: string; muted: boolean };
      return resultJob(manager.setMuted(id, muted));
    },
  });

  router.handle("browser.tab.setProxy", {
    paramsSchema: METHODS["browser.tab.setProxy"].params,
    resultSchema: METHODS["browser.tab.setProxy"].result,
    handler: async (params) => {
      const { id, proxyProfileId } = params as { id: string; proxyProfileId: string | null };
      assertProfile(proxyProfileId);
      const tab = await manager.setProxy(id, proxyProfileId);
      return resultJob(tab);
    },
  });

  router.handle("browser.tab.list", {
    paramsSchema: METHODS["browser.tab.list"].params,
    resultSchema: METHODS["browser.tab.list"].result,
    handler: async () => ({ tabs: manager.list() }),
  });

  router.handle("browser.setViewportBounds", {
    paramsSchema: METHODS["browser.setViewportBounds"].params,
    resultSchema: METHODS["browser.setViewportBounds"].result,
    handler: async (params) => {
      manager.setViewportBounds(params as { x: number; y: number; width: number; height: number });
      return { applied: true };
    },
  });

  // Post-1.0: the effective user agent for the Settings page (custom override or the
  // captured Electron default). Read-only — writes go through settings.setAll.
  router.handle("browser.getUserAgent", {
    paramsSchema: METHODS["browser.getUserAgent"].params,
    resultSchema: METHODS["browser.getUserAgent"].result,
    handler: async () => manager.getUserAgent(),
  });

  return manager;
}
