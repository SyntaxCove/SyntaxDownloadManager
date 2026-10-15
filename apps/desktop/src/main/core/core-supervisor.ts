import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { SyntaxDmError } from "@syntaxdm/contracts";
import { CoreClient } from "./core-client.js";
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
  /** Test hook: override process spawning. */
  spawnFn?: typeof spawn;
}

export class CoreSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private client: CoreClient | null = null;
  private state: CoreState = "stopped";
  private consecutiveFailures = 0;
  private readySince = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly spawnFn: typeof spawn;

  constructor(private readonly options: SupervisorOptions) {
    super();
    this.spawnFn = options.spawnFn ?? spawn;
  }

  get currentState(): CoreState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === "ready" && this.client !== null;
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
      },
    });
    this.child = child;
    child.stdout?.pipe(stdout);
    stdin.pipe(child.stdin ?? new PassThrough());

    child.on("error", (err) => {
      this.log(`[supervisor] spawn error: ${err.message}`);
      this.handleExit();
    });
    child.on("exit", (code, signal) => {
      this.log(`[supervisor] core exited (code=${code} signal=${signal})`);
      this.handleExit();
    });

    this.client = new CoreClient(stdout, stdin, 30_000, (m) => this.log(m));
    this.client.on("event", (name: string, payload: unknown) => {
      if (name === "core.ready") {
        const wasUnhealthy = this.consecutiveFailures > 0;
        if (shouldResetStreak(Date.now() - this.readySince) || wasUnhealthy) {
          // fresh process: streak resets after it proves healthy for RESET_AFTER_MS
          this.readySince = Date.now();
          setTimeout(() => {
            if (this.state === "ready" && shouldResetStreak(Date.now() - this.readySince)) {
              this.consecutiveFailures = 0;
            }
          }, RESET_AFTER_MS + 10);
        }
        this.readySince = Date.now();
        this.consecutiveFailures = 0;
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

    if (shouldGiveUp(this.consecutiveFailures + 1)) {
      this.consecutiveFailures += 1;
      this.log(`[supervisor] giving up after ${this.consecutiveFailures} consecutive failures`);
      this.setState("unavailable");
      return;
    }

    this.consecutiveFailures += 1;
    const delay = delayForFailure(this.consecutiveFailures);
    this.log(`[supervisor] restarting in ${delay}ms (attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE})`);
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
