import type { ContractError } from "@syntaxdm/contracts";
import {
  RequestEnvelope, SuccessEnvelope, ErrorEnvelope, EventEnvelope,
  makeSuccess, makeError, makeEvent,
  SyntaxDmError,
} from "@syntaxdm/contracts";
import type { z } from "zod";

/**
 * Transport-agnostic RPC router shared by the Electron IPC boundary (Phase 2) and the
 * Electron↔core stdio channel (Phase 5). Pure logic — no Electron imports — so it is fully
 * unit-testable in a headless environment.
 *
 * Guarantees (data integrity > security first):
 *  - every incoming request envelope is schema-validated before dispatch;
 *  - every handler's params/result pass through the registered zod schemas;
 *  - a handler throwing is always converted to a typed ErrorEnvelope, never a crash;
 *  - outbound event payloads are validated before leaving the process.
 */

export interface RpcContext {
  /** Identity of the requesting frame when applicable (Electron webContents id). */
  readonly senderId?: number;
}

export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown>;

export interface RegisteredHandler {
  readonly handler: RpcHandler;
  readonly paramsSchema?: z.ZodType<unknown>;
  readonly resultSchema?: z.ZodType<unknown>;
}

/** Outbound sink: Electron `webContents.send`, a stdio writer, a test double, … */
export interface MessageSink {
  send(message: unknown): void;
}

export class IpcRouter {
  private readonly handlers = new Map<string, RegisteredHandler>();
  /** Event consumers (e.g. the Electron bridge forwards validated events to renderer windows). */
  private readonly eventListeners = new Set<(event: string, payload: unknown) => void>();

  constructor(private readonly log?: (msg: string) => void) {}

  /**
   * Register a method handler. `paramsSchema`/`resultSchema` enforce the contract at runtime;
   * omit them only for methods with no parameters or free-form results (none today).
   */
  handle(method: string, entry: RegisteredHandler): this {
    if (this.handlers.has(method)) {
      throw new SyntaxDmError("internal_error", `method registered twice: ${method}`);
    }
    this.handlers.set(method, entry);
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /** Subscribe to validated outbound events. Returns an unsubscribe function. */
  onEvent(listener: (event: string, payload: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Validate + emit an event to all listeners. Invalid payloads are a programming error:
   * they are logged and dropped rather than propagated to consumers (never trust partial data).
   */
  emit(event: string, payloadSchema: z.ZodType<unknown> | undefined, payload: unknown): void {
    let validated = payload;
    if (payloadSchema) {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success) {
        this.log?.(`[ipc] dropped invalid event payload for ${event}: ${parsed.error.message}`);
        return;
      }
      validated = parsed.data;
    }
    const envelope = makeEvent(event, validated);
    if (!EventEnvelope.safeParse(envelope).success) {
      this.log?.(`[ipc] dropped unserializable event envelope for ${event}`);
      return;
    }
    for (const listener of this.eventListeners) listener(event, validated);
  }

  /**
   * Dispatch one raw incoming message (already JSON-parsed by the transport).
   * Always resolves — failures are reported as ErrorEnvelope through the sink.
   */
  async dispatch(raw: unknown, ctx: RpcContext, sink: MessageSink): Promise<void> {
    const request = RequestEnvelope.safeParse(raw);
    if (!request.success) {
      sink.send(
        makeError(unknownId(raw), {
          code: "parse_error",
          message: "malformed request envelope",
          data: request.error.flatten(),
        }),
      );
      return;
    }
    const { id, method, params } = request.data;
    const registered = this.handlers.get(method);
    if (!registered) {
      sink.send(makeError(id, { code: "method_not_found", message: `unknown method: ${method}` }));
      return;
    }
    try {
      let validatedParams: unknown = undefined;
      if (registered.paramsSchema) {
        const parsed = registered.paramsSchema.safeParse(params ?? {});
        if (!parsed.success) {
          throw new SyntaxDmError("invalid_params", "params failed contract validation", {
            issues: parsed.error.issues,
          });
        }
        validatedParams = parsed.data;
      }
      const rawResult = await registered.handler(validatedParams, ctx);
      if (registered.resultSchema) {
        const parsed = registered.resultSchema.safeParse(rawResult);
        if (!parsed.success) {
          throw new SyntaxDmError("internal_error", "handler result failed contract validation", {
            issues: parsed.error.issues,
          });
        }
        sink.send(makeSuccess(id, parsed.data));
        return;
      }
      sink.send(makeSuccess(id, rawResult));
    } catch (err) {
      sink.send(makeError(id, toContractError(err)));
    }
  }

  /**
   * Convenience for transports that want a response value back instead of the sink pattern
   * (e.g. Electron ipcMain.handle). Mirrors `dispatch` semantics exactly.
   */
  async handleRequest(raw: unknown, ctx: RpcContext): Promise<SuccessEnvelope | ErrorEnvelope> {
    let captured: SuccessEnvelope | ErrorEnvelope | undefined;
    await this.dispatch(raw, ctx, { send: (m) => (captured = m as SuccessEnvelope | ErrorEnvelope) });
    if (!captured) {
      // Defensive: dispatch always sends exactly once for a parsed envelope.
      captured = makeError(unknownId(raw), { code: "internal_error", message: "no response produced" });
    }
    return captured;
  }
}

function unknownId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "unknown";
}

export function toContractError(err: unknown): ContractError {
  const e = SyntaxDmError.from(err);
  return { code: e.code, message: e.message, data: e.data };
}

// Re-exported for transports that need to serialize envelopes without importing internals.
export { SuccessEnvelope, ErrorEnvelope };
