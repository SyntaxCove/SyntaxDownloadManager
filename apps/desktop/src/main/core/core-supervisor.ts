import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { SyntaxDmError } from "@syntaxdm/contracts";
import { CoreClient } from "./core-client.js";
import { StderrLineSplitter } from "../logging/core-stderr.js";
import {
  MAX_CONSECUTIVE,
  RESET_AFTER_MS,
  delayForFailure,
  shouldGiveUp,
  shouldResetStreak,
} from "./backoff.js";

/**
 * CoreSupervisor — owns the download-core child process.
 *
 * Lifecycle: spawn → wait for `core.ready` event → ready. On exit: exponential-backoff
 * restart (see backoff.ts) unless a deliberate stop is in flight; a healthy stretch longer
 * than RESET_AFTER_MS resets the streak; MAX_CONSECUTIVE failures surface `unavailable`.
 * Graceful stop: `core.shutdown` request → SIGTERM → SIGKILL escalation.
 */

export type CoreState = "stopped" | "starting" | "ready" | "restarting" | "unavailable";

export interface SupervisorOptions {
  /** Absolute core binary path (resolved by the app, not by this class). */
  binaryPath: string;
  /** Absolute SQLite path handed to the core via SYNTAXDM_DB. */
  dbPath: string;
  maxConcurrent: number;
  /** Range connections per download (Phase 6 segmentation ceiling; core clamps 1..16). */
  maxConnectionsPerDownload?: number;
  log?: (msg: string) => void;
  /** Phase 20: one structured record per core stderr line (JSON tracing output).
   *  MUST always be provided when the core is spawned — consuming stderr is what keeps
   *  the OS pipe buffer drained (an unread, chatty stderr would deadlock the core). */
  onStderrLine?: (line: string) => void;
  /** Phase 20 (verboseLogging setting): spawn the core with RUST_LOG=debug.
   *  Applies at spawn time; a live change takes effect on the next (re)launch. */
  verboseCoreLogging?: boolean;
  /** Test hook: override process spawning. */
  spawnFn?: typeof spawn;
}

export class CoreSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private client: CoreClient | null = null;
  private state: CoreState = "stopped";
  private failureStreak = 0;
  private readySince = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly spawnFn: typeof spawn;
  private stderrSplitter: StderrLineSplitter | null = null;
  private verboseCoreLogging: boolean;
  // Phase 20 lifecycle facts for the diagnostics health report.
  private restartCount = 0;
  private lastExitInfo: { code: number | null; signal: string | null } | null = null;

  constructor(private readonly options: SupervisorOptions) {
    super();
    this.spawnFn = options.spawnFn ?? spawn;
    this.verboseCoreLogging = options.verboseCoreLogging ?? false;
  }

  get currentState(): CoreState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === "ready" && this.client !== null;
  }

  // ---- Phase 20: diagnostics-facing lifecycle facts ----

  /** Total relaunches this app session (a deliberate stop does not increment it). */
  get restarts(): number {
    return this.restartCount;
  }

  get consecutiveFailures(): number {
    return this.failureStreak;
  }

  /** Exit of the most recent child (graceful stop clears it). */
  get lastExit(): { code: number | null; signal: string | null } | null {
    return this.lastExitInfo;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Time since the current ready transition (null while not ready). */
  get readyUptimeMs(): number | null {
    return this.state === "ready" ? Math.max(0, Date.now() - this.readySince) : null;
  }

  /** verboseLogging setting → core spawn env; effective on the next launch. */
  setVerboseCoreLogging(verbose: boolean): void {
    this.verboseCoreLogging = verbose;
  }

  private setState(state: CoreState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  private log(msg: string): void {
    this.options.log?.(msg);
  }

  start(): void {
    if (this.child || this.stopping) return;
    this.setState(this.state === "restarting" ? "restarting" : "starting");
    this.launch();
  }

  private launch(): void {
    const binary = this.options.binaryPath;
    if (!existsSync(binary)) {
      this.log(`[supervisor] core binary not found: ${binary}`);
      this.setState("unavailable");
      return;
    }

    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = this.spawnFn(binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SYNTAXDM_DB: this.options.dbPath,
        SYNTAXDM_MAX_CONCURRENT: String(this.options.maxConcurrent),
        ...(this.options.maxConnectionsPerDownload !== undefined
          ? { SYNTAXDM_MAX_CONNECTIONS: String(this.options.maxConnectionsPerDownload) }
          : {}),
        // Phase 20: verbose diagnostics — the core's default filter is `info`.
        ...(this.verboseCoreLogging ? { RUST_LOG: "debug" } : {}),
      },
    });
    this.child = child;
    child.stdout?.pipe(stdout);
    stdin.pipe(child.stdin ?? new PassThrough());

    // Phase 20: ALWAYS consume stderr — records flow to the app log; the consumer also
    // guarantees the OS pipe buffer drains (an unread, chatty stderr would deadlock the
    // core on write).
    this.stderrSplitter = new StderrLineSplitter((line) => {
      if (this.options.onStderrLine) this.options.onStderrLine(line);
      else this.log(`[core:stderr] ${line}`);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.stderrSplitter?.push(chunk));
    child.on("exit", () => this.stderrSplitter?.flush());

    child.on("error", (err) => {
      this.log(`[supervisor] spawn error: ${err.message}`);
      this.handleExit();
    });
    child.on("exit", (code, signal) => {
      this.log(`[supervisor] core exited (code=${code} signal=${signal})`);
      this.lastExitInfo = { code, signal };
      this.handleExit();
    });

    this.client = new CoreClient(stdout, stdin, 30_000, (m) => this.log(m));
    this.client.on("event", (name: string, payload: unknown) => {
      if (name === "core.ready") {
        const wasUnhealthy = this.failureStreak > 0;
        if (shouldResetStreak(Date.now() - this.readySince) || wasUnhealthy) {
          // fresh process: streak resets after it proves healthy for RESET_AFTER_MS
          this.readySince = Date.now();
          setTimeout(() => {
            if (this.state === "ready" && shouldResetStreak(Date.now() - this.readySince)) {
              this.failureStreak = 0;
            }
          }, RESET_AFTER_MS + 10);
        }
        this.readySince = Date.now();
        this.failureStreak = 0;
        this.setState("ready");
      }
      this.emit("event", name, payload);
    });
  }

  private handleExit(): void {
    this.child = null;
    this.client?.rejectAll(new SyntaxDmError("core_unavailable", "core exited"));
    this.client?.removeAllListeners();
    this.client = null;

    if (this.stopping) {
      this.setState("stopped");
      return;
    }

    if (shouldGiveUp(this.failureStreak + 1)) {
      this.failureStreak += 1;
      this.log(`[supervisor] giving up after ${this.failureStreak} consecutive failures`);
      this.setState("unavailable");
      return;
    }

    this.failureStreak += 1;
    this.restartCount += 1;
    const delay = delayForFailure(this.failureStreak);
    this.log(`[supervisor] restarting in ${delay}ms (attempt ${this.failureStreak}/${MAX_CONSECUTIVE})`);
    this.setState("restarting");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, delay);
  }

  /** Wait until the core reports ready (or fail fast on unavailable). */
  async whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.isReady) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === "unavailable") {
        throw new SyntaxDmError("core_unavailable", "download core is unavailable");
      }
      if (this.isReady) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new SyntaxDmError("timeout", `core did not become ready within ${timeoutMs}ms`);
  }

  /** RPC passthrough; routes through the live client with its own timeouts. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.client || !this.isReady) {
      return Promise.reject(new SyntaxDmError("core_unavailable", "download core is not ready"));
    }
    return this.client.request<T>(method, params, timeoutMs);
  }

  /** Graceful stop: shutdown request → terminate → hard kill. */
  async stop(timeoutMs = 4_000): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child || !this.client) {
      this.setState("stopped");
      return;
    }
    try {
      await Promise.race([
        this.client.request("core.shutdown", undefined, 2_000),
        new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 2_200)),
      ]);
    } catch {
      // fall through to terminate
    }
    child.kill();
    const killed = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), Math.max(500, timeoutMs - 2_200));
      }),
    ]);
    if (!killed) {
      child.kill("SIGKILL");
      this.log("[supervisor] core hard-killed after graceful stop timed out");
    }
    this.child = null;
    this.client = null;
    this.lastExitInfo = null; // deliberate stop — not a crash signal for diagnostics
    this.setState("stopped");
  }
}

/** Resolve the core binary path across dev and packaged layouts. */
export function resolveCoreBinaryPath(opts: {
  appRoot: string;
  isPackaged: boolean;
  envOverride?: string;
}): string {
  if (opts.envOverride?.trim()) return opts.envOverride.trim();
  const exe = process.platform === "win32" ? "download-core.exe" : "download-core";
  if (opts.isPackaged) {
    return join(opts.appRoot, "bin", "download-core", exe);
  }
  // dev layout: built by `cargo build` inside the monorepo
  const profile = process.env.SYNTAXDM_CORE_PROFILE ?? "debug";
  return join(opts.appRoot, "core", "target", profile, exe);
}
