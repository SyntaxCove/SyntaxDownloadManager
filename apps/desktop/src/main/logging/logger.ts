import { LogLevel, LogRecord } from "@syntaxdm/contracts";
import type { LogLevel as LogLevelT, LogRecord as LogRecordT } from "@syntaxdm/contracts";

/**
 * JsonlLogger — the main process's structured log pipeline (Phase 20).
 *
 * Every record is `{ ts, level, component, msg, data? }`:
 *  - `ring`: bounded in-memory buffer feeding the in-app log tail (`diagnostics.getRecentLogs`);
 *  - `file`: append-only JSONL, one file per UTC day (`main-YYYY-MM-DD.jsonl`), rotated by
 *    day and by per-day size cap (`main-YYYY-MM-DD.N.jsonl`), pruned after `retentionDays`.
 *
 * Integrity posture: logging must NEVER take the app down. File I/O is wrapped — an I/O
 * failure degrades to console.error once and the process keeps running. Records are
 * credential-scrubbed before they reach ANY sink (memory, disk, UI, exports).
 *
 * Crash semantics are deliberately preserved: `uncaughtException` is NOT subscribed (a
 * listener would suppress Electron's default crash dialog and change exit behavior);
 * `unhandledRejection` / renderer-gone / child-gone surfaces log via their own hooks.
 */

export type { LogLevelT, LogRecordT };

const LEVEL_ORDER: Record<LogLevelT, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Bounds — mirrored by the contract schemas; keep in sync with domain/diagnostics.ts. */
export const LOG_MSG_MAX = 2000;
export const RING_DEFAULT_CAPACITY = 2000;
export const DAY_FILE_BYTES_DEFAULT = 5 * 1024 * 1024;
export const RETENTION_DAYS_DEFAULT = 7;

/** Minimal fs surface — injectable for tests. */
export interface LoggerFs {
  mkdirSync(dir: string, opts: { recursive: true }): void;
  existsSync(path: string): boolean;
  appendFileSync(path: string, data: string): void;
  readdirSync(dir: string): string[];
  statSync(path: string): { size: number; mtimeMs: number; isFile(): boolean };
  unlinkSync(path: string): void;
}

const dateStamp = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/**
 * Credential scrubbing. Applied to messages and (recursively) data before any sink sees
 * them. Bounded and regex-based — best-effort, but covers the realistic leaks:
 *  - `scheme://user:password@host` URLs;
 *  - query values keyed like secrets (token/key/secret/password/api key/signature…);
 *  - `Authorization: Bearer …` headers (string-typed data).
 */
export function scrub(text: string): string {
  let out = text
    // user:password@ in URLs (proxy URLs are the realistic carrier)
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
    // secret-looking query parameters
    .replace(
      /([?&](?:token|key|secret|password|passwd|access[_-]?token|api[_-]?key|apikey|signature|sig|authorization)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    // bearer/credential headers
    .replace(
      /((?:authorization|proxy-authorization)["':=\s]+(?:bearer|basic)\s+)[^\s"',}]+/gi,
      "$1[redacted]",
    );
  return out.length > LOG_MSG_MAX ? out.slice(0, LOG_MSG_MAX) : out;
}

/** JSON-safe, depth- and size-bounded scrub of a structured detail. */
export function scrubData(data: unknown, depth = 0): unknown {
  if (data === null || data === undefined) return undefined;
  if (depth > 4) return "[truncated]";
  if (typeof data === "string") return scrub(data);
  if (typeof data === "number" || typeof data === "boolean") return data;
  if (Array.isArray(data)) return data.slice(0, 50).map((v) => scrubData(v, depth + 1));
  if (data instanceof Error) {
    return { name: data.name, message: scrub(data.message) };
  }
  if (typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>).slice(0, 50)) {
      out[k] = scrubData(v, depth + 1);
    }
    return out;
  }
  return scrub(String(data)).slice(0, LOG_MSG_MAX);
}

export class JsonlLogger {
  private level: LogLevelT;
  private readonly ring: LogRecordT[] = [];
  private readonly fs: LoggerFs;
  private readonly now: () => number;
  private readonly dir: string | null;
  private readonly dayCapBytes: number;
  private readonly retentionDays: number;
  private readonly ringCapacity: number;
  /** Current file bookkeeping (null = logging to file disabled / not yet opened). */
  private currentFile: string | null = null;
  private currentFileSize = 0;
  private ioWarned = false;

  constructor(opts: {
    dir?: string | null;
    level?: LogLevelT;
    ringCapacity?: number;
    dayCapBytes?: number;
    retentionDays?: number;
    fs?: LoggerFs;
    now?: () => number;
  }) {
    this.level = opts.level ?? "info";
    this.fs = opts.fs ?? (nodeFs() as LoggerFs);
    this.now = opts.now ?? Date.now;
    this.dir = opts.dir ?? null;
    this.dayCapBytes = opts.dayCapBytes ?? DAY_FILE_BYTES_DEFAULT;
    this.retentionDays = opts.retentionDays ?? RETENTION_DAYS_DEFAULT;
    this.ringCapacity = opts.ringCapacity ?? RING_DEFAULT_CAPACITY;
    if (this.dir) {
      try {
        this.fs.mkdirSync(this.dir, { recursive: true });
        this.prune();
      } catch (err) {
        this.onIoError("init log dir", err);
      }
    }
  }

  setLevel(level: LogLevelT): void {
    this.level = level;
  }

  get activeLevel(): LogLevelT {
    return this.level;
  }

  get logsDir(): string | null {
    return this.dir;
  }

  debug(component: string, msg: string, data?: unknown): void {
    this.log("debug", component, msg, data);
  }
  info(component: string, msg: string, data?: unknown): void {
    this.log("info", component, msg, data);
  }
  warn(component: string, msg: string, data?: unknown): void {
    this.log("warn", component, msg, data);
  }
  error(component: string, msg: string, data?: unknown): void {
    this.log("error", component, msg, data);
  }

  log(level: LogLevelT, component: string, msg: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecordT = {
      ts: this.now(),
      level,
      component: component.slice(0, 40),
      msg: scrub(msg),
      ...(data !== undefined ? { data: scrubData(data) } : {}),
    };

    // Ring always keeps the record (the UI tail filters by level itself).
    this.ring.push(record);
    if (this.ring.length > this.ringCapacity) {
      this.ring.splice(0, this.ring.length - this.ringCapacity);
    }

    this.writeToFile(record);
  }

  /** Newest-last tail of the ring buffer with optional level floor filter. */
  getRecent(opts: { level?: LogLevelT; limit?: number } = {}): LogRecordT[] {
    const limit = opts.limit ?? 200;
    const floor = opts.level ? LEVEL_ORDER[opts.level] : undefined;
    const out: LogRecordT[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const rec: LogRecordT | undefined = this.ring[i];
      if (!rec) continue;
      if (floor === undefined || LEVEL_ORDER[rec.level] >= floor) out.push(rec);
    }
    return out.reverse();
  }

  /** Log files in the logs dir (name/bytes/mtime), oldest first — for the health report. */
  listLogFiles(): Array<{ name: string; bytes: number; modifiedAt: number }> {
    if (!this.dir) return [];
    try {
      return this.fs
        .readdirSync(this.dir)
        .filter((n) => /^main-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(n))
        .map((name) => {
          const st = this.fs.statSync(`${this.dir}/${name}`);
          return st.isFile()
            ? { name, bytes: st.size, modifiedAt: Math.round(st.mtimeMs) }
            : null;
        })
        .filter((v): v is { name: string; bytes: number; modifiedAt: number } => v !== null)
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return [];
    }
  }

  /** Test hook: exposes the sink state without waiting on async I/O. */
  get currentFilePath(): string | null {
    return this.currentFile;
  }

  private writeToFile(record: LogRecordT): void {
    if (!this.dir) return;
    try {
      const day = dateStamp(record.ts);
      const line = JSON.stringify(record) + "\n";
      if (
        this.currentFile === null ||
        !this.currentFile.includes(`-${day}`) ||
        this.currentFileSize + Buffer.byteLength(line) > this.dayCapBytes
      ) {
        this.rotate(record.ts, day, Buffer.byteLength(line));
      }
      this.fs.appendFileSync(`${this.dir}/${this.currentFile}`, line);
      this.currentFileSize += Buffer.byteLength(line);
    } catch (err) {
      this.onIoError("append log record", err);
    }
  }

  /** Pick the next file for the day that fits the incoming line: `main-<day>.jsonl`,
   *  then `.1`, `.2`… A file chosen here never grows past the cap by this write. */
  private rotate(ts: number, day: string, lineBytes: number): void {
    const base = `main-${day}`;
    let name = `${base}.jsonl`;
    let size = this.fileSize(name);
    let index = 0;
    while (size > 0 && size + lineBytes > this.dayCapBytes) {
      index += 1;
      name = `${base}.${index}.jsonl`;
      size = this.fileSize(name);
    }
    this.currentFile = name;
    this.currentFileSize = size;
    if (size === 0) this.prune(); // fresh file → good moment to drop stale days
  }

  private fileSize(name: string): number {
    try {
      const st = this.fs.statSync(`${this.dir}/${name}`);
      return st.isFile() ? st.size : 0;
    } catch {
      return 0;
    }
  }

  /** Delete files whose UTC day is older than `retentionDays`. */
  private prune(): void {
    if (!this.dir) return;
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const file of this.listLogFiles()) {
      const m = /^main-(\d{4}-\d{2}-\d{2})/.exec(file.name);
      if (!m) continue;
      if (Date.parse(`${m[1]}T00:00:00.000Z`) < cutoff - 24 * 60 * 60 * 1000) {
        try {
          this.fs.unlinkSync(`${this.dir}/${file.name}`);
        } catch (err) {
          this.onIoError(`prune ${file.name}`, err);
        }
      }
    }
  }

  private onIoError(what: string, err: unknown): void {
    if (!this.ioWarned) {
      this.ioWarned = true;
      // console, not the logger — the logger is the thing that failed.
      console.error(`[logger] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function nodeFs(): typeof import("node:fs") {
  // Lazy require keeps this module importable in every CJS context (main is bundled CJS).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs") as typeof import("node:fs");
}
