import type { UnidmBridge, MethodName, MethodParams, MethodResult } from "@unidm/contracts";
import { METHODS, EVENTS, UniDmError } from "@unidm/contracts";
import type { z } from "zod";

/**
 * Renderer-side bridge access. Compile-time method typing via the contracts registries plus
 * runtime re-validation of every result/event payload (defense in depth: main already
 * validates; the renderer never surfaces a payload it did not schema-check).
 */

declare global {
  interface Window {
    unidm: UnidmBridge;
  }
}

export type EventPayload<E extends keyof typeof EVENTS> = z.infer<(typeof EVENTS)[E]["payload"]>;

export function getBridge(): UnidmBridge {
  const bridge = typeof window !== "undefined" ? window.unidm : undefined;
  if (!bridge) {
    throw new UniDmError("internal_error", "UniDM bridge is unavailable (preload not loaded)");
  }
  return bridge;
}

/**
 * Typed RPC with runtime result validation against the contract registry.
 * Every registered method is callable from the renderer: `main`-served methods run in the
 * main process, `core`-served methods are proxied transparently to the Rust core.
 */
export async function rpc<M extends MethodName>(
  method: M,
  ...args: MethodParams<M> extends undefined ? [] : [params: MethodParams<M>]
): Promise<MethodResult<M>> {
  const bridge = getBridge();
  const entry = METHODS[method];
  const rawParams = args[0] as unknown;
  const params = entry?.params ? entry.params.parse(rawParams ?? {}) : rawParams;
  const result = (await bridge.rpc(method, params)) as unknown;
  if (entry?.result) return entry.result.parse(result) as MethodResult<M>;
  return result as MethodResult<M>;
}

/** Typed event subscription with runtime payload validation; invalid payloads are dropped. */
export function onEvent<E extends keyof typeof EVENTS>(
  event: E,
  cb: (payload: EventPayload<E>) => void,
): () => void {
  const bridge = getBridge();
  const entry = EVENTS[event];
  return bridge.onEvent(event, (raw) => {
    const parsed = entry.payload.safeParse(raw);
    if (parsed.success) cb(parsed.data as EventPayload<E>);
  });
}
