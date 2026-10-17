import type { LogRecord as LogRecordT, LogLevel as LogLevelT } from "@syntaxdm/contracts";

/**
 * Core stderr → structured log records (Phase 20).
 *
 * The Rust core emits tracing's JSON format on stderr — one JSON object per line:
 *   {"timestamp":"2026-10-15T12:00:00.000000Z","level":"INFO","target":"download_core::engine","message":"..."}
 * (`.flatten_event(true)` merges event fields to the top level.)
 *
 * Anything that is NOT such a JSON object is still captured — panics, `eprintln!` debug
 * output, linker noise — classified as `core-raw` at `error` level so a crash can never
 * silently vanish from the logs. Empty lines are ignored.
 *
 * This consumer ALSO closes a real reliability bug: the supervisor used to create the
 * stderr pipe without ever reading it, so a chatty core could fill the 64 KiB OS pipe
 * buffer and deadlock on write.
 */

const TRACE_LEVELS: Record<string, LogLevelT> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

export const CORE_RAW_COMPONENT = "core-raw";

export function parseCoreStderrLine(line: string, ts: number): LogRecordT | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === "object" && typeof obj.level === "string") {
        const level = TRACE_LEVELS[obj.level.toLowerCase()];
        if (level) {
          const { timestamp, level: _level, target, message, ...rest } = obj;
          void timestamp;
          void _level;
          const targetStr = typeof target === "string" ? target : "";
          const msg =
            typeof message === "string"
              ? message
              : Object.keys(rest).length > 0
                ? JSON.stringify(rest)
                : "";
          // Component: `core:<last target segment>` — bounded by the contract (40 chars).
          const last = targetStr.split("::").pop() ?? "";
          const component = ("core:" + last).slice(0, 40);
          const data = Object.keys(rest).length > 0 ? rest : undefined;
          return {
            ts,
            level,
            component: last ? component : "core",
            msg: msg.slice(0, 2000),
            ...(data !== undefined ? { data } : {}),
          };
        }
      }
    } catch {
      // fall through to raw classification
    }
  }

  return {
    ts,
    level: "error",
    component: CORE_RAW_COMPONENT,
    msg: trimmed.slice(0, 2000),
  };
}

/** Split a stderr chunk into complete lines, keeping the trailing partial in a buffer. */
export class StderrLineSplitter {
  private pending = "";
  private readonly maxPending: number;

  constructor(
    private readonly onLine: (line: string) => void,
    maxPending = 64 * 1024,
  ) {
    this.maxPending = maxPending;
  }

  push(chunk: string): void {
    this.pending += chunk;
    let idx: number;
    while ((idx = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      this.onLine(line);
    }
    // A pathological no-newline stream must not grow unboundedly: drop the head.
    if (this.pending.length > this.maxPending) {
      this.pending = this.pending.slice(-this.maxPending);
    }
  }

  /** Flushes any trailing partial line (call on child exit). */
  flush(): void {
    if (this.pending) {
      const line = this.pending;
      this.pending = "";
      this.onLine(line);
    }
  }
}
