import { contextBridge, ipcRenderer } from "electron";
import { RPC_CHANNEL, EVENT_CHANNEL } from "../main/ipc/electron-rpc.js";
import type { RequestEnvelope, SuccessEnvelope, ErrorEnvelope, EventEnvelope } from "@unidm/contracts";

/**
 * The ONLY surface the renderer gets. Sandboxed preload (CJS bundle): it may require nothing
 * beyond `electron`, so @unidm/contracts is bundled in at build time.
 *
 * Exposed API (window.unidm):
 *   rpc(method, params)  → validates the response envelope shape, throws ContractError-shaped
 *                          Error on { ok: false }.
 *   onEvent(name, cb)    → subscribes to validated main→renderer events; returns unsubscribe.
 */

export interface UnidmBridge {
  rpc(method: string, params?: unknown): Promise<unknown>;
  onEvent(name: string, cb: (payload: unknown) => void): () => void;
}

const envelopeListeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on(EVENT_CHANNEL, (_event, raw: unknown) => {
  const env = raw as Partial<EventEnvelope> | undefined;
  if (!env || env.v !== 1 || typeof env.event !== "string") return;
  const listeners = envelopeListeners.get(env.event);
  if (!listeners) return;
  for (const cb of listeners) cb(env.payload);
});

const bridge: UnidmBridge = {
  async rpc(method: string, params?: unknown): Promise<unknown> {
    const request: RequestEnvelope = { v: 1, id: nextId(), method, params };
    const response = (await ipcRenderer.invoke(RPC_CHANNEL, request)) as
      | SuccessEnvelope
      | ErrorEnvelope
      | undefined;
    if (!response || response.v !== 1 || response.id !== request.id) {
      throw { code: "internal_error", message: "malformed IPC response" };
    }
    if (response.ok) return response.result;
    throw response.error;
  },
  onEvent(name: string, cb: (payload: unknown) => void): () => void {
    let set = envelopeListeners.get(name);
    if (!set) {
      set = new Set();
      envelopeListeners.set(name, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) envelopeListeners.delete(name);
    };
  },
};

contextBridge.exposeInMainWorld("unidm", bridge);

// ids in the sandboxed preload: crypto.randomUUID is available in the isolated world.
let counter = 0;
function nextId(): string {
  counter = (counter + 1) % 0xffffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
