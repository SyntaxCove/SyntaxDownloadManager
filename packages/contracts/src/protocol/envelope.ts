import { z } from "zod";
import { PROTOCOL_VERSION } from "../version.js";
import { ContractError } from "../errors.js";

/**
 * Wire envelopes shared by the Electron IPC boundary and the Electron↔core stdio channel.
 * Every message is one JSON object; over stdio, one per line (JSONL).
 *
 *   → RequestEnvelope  { v, id, method, params? }
 *   ← SuccessEnvelope  { v, id, ok: true, result }
 *   ← ErrorEnvelope    { v, id, ok: false, error }
 *   ← EventEnvelope    { v, event, payload }   (no id; core→main and main→renderer only)
 */

const V = z.literal(PROTOCOL_VERSION);

export const RequestEnvelope = z.object({
  v: V,
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

export const SuccessEnvelope = z.object({
  v: V,
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
});
export type SuccessEnvelope = z.infer<typeof SuccessEnvelope>;

export const ErrorEnvelope = z.object({
  v: V,
  id: z.string().min(1),
  ok: z.literal(false),
  error: ContractError,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const ResponseEnvelope = z.discriminatedUnion("ok", [SuccessEnvelope, ErrorEnvelope]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;

export const EventEnvelope = z.object({
  v: V,
  event: z.string().min(1),
  payload: z.unknown().optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const AnyMessage = z.union([RequestEnvelope, ResponseEnvelope, EventEnvelope]);

export function makeRequest(id: string, method: string, params?: unknown): RequestEnvelope {
  return params === undefined ? { v: PROTOCOL_VERSION, id, method } : { v: PROTOCOL_VERSION, id, method, params };
}

export function makeSuccess(id: string, result: unknown): SuccessEnvelope {
  return { v: PROTOCOL_VERSION, id, ok: true, result };
}

export function makeError(id: string, error: ContractError): ErrorEnvelope {
  return { v: PROTOCOL_VERSION, id, ok: false, error };
}

export function makeEvent(event: string, payload?: unknown): EventEnvelope {
  return payload === undefined
    ? { v: PROTOCOL_VERSION, event }
    : { v: PROTOCOL_VERSION, event, payload };
}
