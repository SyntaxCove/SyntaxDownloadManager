import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import {
  EVENTS,
  UniDmError,
  makeRequest,
  type ContractError,
  type EventName,
} from "@unidm/contracts";
import type { z } from "zod";

/**
 * CoreClient — JSONL framing over the core's stdio streams.
 *  - requests carry a ULID-ish id and are resolved/rejected by matching response envelopes;
 *  - requests time out (default 30s) → `timeout` UniDmError;
 *  - events are validated against the contracts event registry before dispatch;
 *  - malformed lines are logged and skipped (the protocol is line-delimited JSON).
 */

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: UniDmError) => void;
  timer: NodeJS.Timeout;
}

export type CoreEventHandler = (event: EventName, payload: unknown) => void;

export class CoreClient extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly defaultTimeoutMs = 30_000,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    super();
    const lines = createInterface({ input });
    lines.on("line", (line) => this.onLine(line));
    lines.on("close", () => {
      this.closed = true;
      this.rejectAll(new UniDmError("core_unavailable", "core stream closed"));
      this.emit("closed");
    });
  }

  /** Send a request and await the matching response envelope. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new UniDmError("core_unavailable", "core is not running"));
    }
    const id = `r-${Date.now().toString(36)}-${this.pending.size}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UniDmError("timeout", `core request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      const envelope = makeRequest(id, method, params);
      this.output.write(JSON.stringify(envelope) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new UniDmError("core_unavailable", `write failed: ${err.message}`));
        }
      });
    });
  }

  rejectAll(err: UniDmError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  get inflight(): number {
    return this.pending.size;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.log(`[core] dropping unparseable line: ${trimmed.slice(0, 120)}`);
      return;
    }

    if (typeof message.event === "string") {
      const name = message.event as EventName;
      const entry = EVENTS[name];
      const payload = message.payload;
      if (entry) {
        const parsed = (entry.payload as z.ZodType<unknown>).safeParse(payload);
        if (!parsed.success) {
          this.log(`[core] invalid payload for event ${name}: ${parsed.error.message}`);
          return;
        }
        this.emit("event", name, parsed.data);
      } else {
        // Unknown event names are forwarded opaquely — additive protocol evolution.
        this.emit("event", name, payload);
      }
      return;
    }

    if (typeof message.id === "string" && typeof message.ok === "boolean") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.log(`[core] response for unknown id ${message.id}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const err = message.error as ContractError | undefined;
        pending.reject(new UniDmError(err?.code ?? "internal_error", err?.message ?? "core error", err?.data));
      }
      return;
    }

    this.log(`[core] dropping unrecognized message: ${trimmed.slice(0, 120)}`);
  }
}
