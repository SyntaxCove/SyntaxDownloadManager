import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import { describe } from "vitest";
import { EVENTS, RequestEnvelope, type UpdateState } from "@syntaxdm/contracts";
import { IpcRouter } from "../main/ipc/router.js";
import {
  CoreSupervisor,
  resolveCoreBinaryPath,
} from "../main/core/core-supervisor.js";
import { JsonlLogger } from "../main/logging/logger.js";
import { parseCoreStderrLine } from "../main/logging/core-stderr.js";
import { SettingsStore } from "../main/domains/settings.js";
import { ProxyProfileStore } from "../main/domains/proxy.js";
import { ToolkitManager } from "../main/toolkit/manager.js";
import { BootClock } from "../main/perf/boot-clock.js";
import { registerAppDomains, pushCoreRuntimeState } from "../main/composition.js";
import type { OsNotificationPort } from "../main/domains/notify.js";
import type { RevealShell } from "../main/domains/app-reveal.js";
import type { DirectoryPicker } from "../main/domains/app-dialogs.js";

/**
 * Phase 25 E2E harness — the REAL main-process composition over the REAL Rust core
 * binary, with stubs ONLY at the Electron port boundaries (no Electron binary exists
 * in the headless sandbox). Everything else is production code: IpcRouter + zod,
 * SettingsStore, ProxyProfileStore, ToolkitManager, JsonlLogger, BootClock,
 * CoreSupervisor (real child process, stdio JSONL), and `registerAppDomains` — the
 * exact registration surface `main.ts` ships.
 */

/**
 * Repo root: npm workspace test runs execute with cwd = apps/desktop. An env override
 * keeps the harness usable from any runner that changes the working directory.
 */
export const REPO_ROOT = process.env.SYNTAXDM_REPO_ROOT
  ? resolve(process.env.SYNTAXDM_REPO_ROOT)
  : resolve(process.cwd(), "../..");

const CORE_BINARY = resolveCoreBinaryPath({ appRoot: REPO_ROOT, isPackaged: false });

/** The desktop app version (apps/desktop/package.json) — read fresh, never drifted. */
export function desktopVersion(): string {
  return (
    JSON.parse(
      readFileSync(join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
    ) as { version: string }
  ).version;
}

/** `describe` wrapper: runs the suite only when the core binary has been built. */
export function describeWithCore(name: string, fn: () => void): ReturnType<typeof describe> {
  const available = existsSync(CORE_BINARY);
  if (!available) {
    console.warn(
      `[e2e] core binary not found at ${CORE_BINARY} — run 'cargo build --manifest-path core/Cargo.toml -p download-core'. Skipping.`,
    );
  }
  return describe.skipIf(!available)(name, fn);
}

export { CORE_BINARY };

// ---------------------------------------------------------------------------
// HTTP fixture — a REAL local HTTP server with download-engine-facing behaviors.
// ---------------------------------------------------------------------------

export interface FixtureRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

export type FixtureHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class HttpFixture {
  private server: Server | null = null;
  private handler: FixtureHandler = (_req, res) => res.destroy();
  readonly requests: FixtureRequest[] = [];
  port = 0;

  setHandler(handler: FixtureHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      try {
        this.handler(req, res);
      } catch (err) {
        res.destroy(err instanceof Error ? err : undefined);
      }
    });
    await new Promise<void>((resolvePromise) => {
      this.server!.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const addr = this.server!.address();
    if (addr === null || typeof addr === "string") throw new Error("fixture listen failed");
    this.port = addr.port;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** Range-aware static body (ETag / Last-Modified / Content-Disposition optional). */
  static handlerForStaticBytes(
    body: Buffer,
    opts: {
      etag?: string;
      lastModified?: string;
      contentType?: string;
      disposition?: string;
      acceptRanges?: boolean;
    } = {},
  ): FixtureHandler {
    return (req, res) => {
      const base: Record<string, string> = {
        "Content-Type": opts.contentType ?? "application/octet-stream",
        "Accept-Ranges": opts.acceptRanges === false ? "none" : "bytes",
        ...(opts.etag !== undefined ? { ETag: opts.etag } : {}),
        ...(opts.lastModified !== undefined ? { "Last-Modified": opts.lastModified } : {}),
        ...(opts.disposition !== undefined ? { "Content-Disposition": opts.disposition } : {}),
      };
      const range = req.headers.range;
      const match = range !== undefined ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      if (match && opts.acceptRanges !== false) {
        const start = Number(match[1]);
        const end = match[2] !== undefined && match[2] !== "" ? Number(match[2]) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          ...base,
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Content-Length": String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { ...base, "Content-Length": String(body.length) });
      res.end(body);
    };
  }

  /** Slow streaming body with Range support — for pause/resume drills. */
  static handlerForSlowBytes(
    body: Buffer,
    opts: { chunkBytes?: number; chunkDelayMs?: number; contentType?: string } = {},
  ): FixtureHandler {
    const chunkBytes = opts.chunkBytes ?? 2048;
    const chunkDelayMs = opts.chunkDelayMs ?? 20;
    return (req, res) => {
      const range = req.headers.range;
      const match = range !== undefined ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      const start = match ? Number(match[1]) : 0;
      const slice = body.subarray(start);
      res.writeHead(match ? 206 : 200, {
        "Content-Type": opts.contentType ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        ...(match ? { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
        "Content-Length": String(slice.length),
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= slice.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        const chunk = slice.subarray(offset, Math.min(offset + chunkBytes, slice.length));
        offset += chunk.length;
        res.write(chunk);
      }, chunkDelayMs);
      res.on("close", () => clearInterval(timer));
    };
  }

  static handlerForNotFound(): FixtureHandler {
    return (_req, res) => {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  }
}

// ---------------------------------------------------------------------------
// Preload mirror — a faithful re-implementation of src/preload/preload.ts with
// `ipcRenderer.invoke` replaced by `router.handleRequest` and `ipcRenderer.on`
// replaced by `router.onEvent`. Same envelope checks, same unwrap/throw contract.
// ---------------------------------------------------------------------------

export interface PreloadMirror {
  rpc(method: string, params?: unknown): Promise<unknown>;
  onEvent(name: string, cb: (payload: unknown) => void): () => void;
}

export function makePreloadMirror(router: IpcRouter): PreloadMirror {
  const envelopeListeners = new Map<string, Set<(payload: unknown) => void>>();
  router.onEvent((name, payload) => {
    const set = envelopeListeners.get(name);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  });
  let counter = 0;
  const nextId = (): string => {
    counter = (counter + 1) % 0xffffffff;
    return `${Date.now().toString(36)}-${counter.toString(36)}`;
  };
  return {
    async rpc(method: string, params?: unknown): Promise<unknown> {
      const request: RequestEnvelope = { v: 1, id: nextId(), method, params };
      const response = await router.handleRequest(request, {});
      if (response.v !== 1 || response.id !== request.id) {
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
}

// ---------------------------------------------------------------------------
// App boot — the production composition over a real core subprocess.
// ---------------------------------------------------------------------------

export interface RecordedNotification {
  title: string;
  body: string;
}

export interface AppHandle {
  userDataDir: string;
  router: IpcRouter;
  supervisor: CoreSupervisor;
  settings: SettingsStore;
  proxyStore: ProxyProfileStore;
  toolkit: ToolkitManager;
  logger: JsonlLogger;
  bootClock: BootClock;
  notifications: RecordedNotification[];
  shellReveals: { mode: "folder" | "open"; path: string }[];
  /** Every validated router event since boot (bounded, scanned by waitEvent). */
  eventLog: { name: string; payload: unknown; at: number }[];
  mirror: PreloadMirror;
  rpc(method: string, params?: unknown): Promise<unknown>;
  waitEvent(
    name: string,
    predicate?: (payload: unknown) => boolean,
    timeoutMs?: number,
  ): Promise<unknown>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export async function bootApp(opts: BootOptions = {}): Promise<AppHandle> {
  const userDataDir = opts.userDataDir ?? (await mkdtemp(join(tmpdir(), "syntaxdm-e2e-")));
  const logger = new JsonlLogger({ dir: join(userDataDir, "logs") });
  const router = new IpcRouter((msg) => logger.info("ipc", msg));
  const eventLog: AppHandle["eventLog"] = [];
  router.onEvent((name, payload) => {
    eventLog.push({ name, payload, at: Date.now() });
    if (eventLog.length > 5000) eventLog.shift();
  });

  const settings = new SettingsStore(userDataDir);
  await settings.load();

  // Plaintext SafeStorageLike — the production Electron safeStorage is unavailable
  // headlessly; the store's own unit tests cover the real encryption path shapes.
  const proxyStore = new ProxyProfileStore(userDataDir, {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, "utf8"),
    decryptString: (enc: Buffer) => enc.toString("utf8"),
  });
  await proxyStore.load();

  const supervisor = new CoreSupervisor({
    binaryPath: CORE_BINARY,
    dbPath: join(userDataDir, "downloads.db"),
    maxConcurrent: opts.maxConcurrent ?? 3,
    ...(opts.maxConnectionsPerDownload !== undefined
      ? { maxConnectionsPerDownload: opts.maxConnectionsPerDownload }
      : {}),
    log: (msg) => logger.info("supervisor", msg),
    onStderrLine: (line) => {
      const record = parseCoreStderrLine(line, Date.now());
      if (record) logger.log(record.level, record.component, record.msg, record.data);
    },
  });

  const toolkit = new ToolkitManager({
    manifestPath: join(userDataDir, "toolchains-manifest.json"),
    toolsRoot: join(userDataDir, "tools"),
    statePath: join(userDataDir, "toolkit-state.json"),
    onStatus: () => undefined,
    onReadyToolsChanged: () => undefined,
  });
  await toolkit.load().catch(() => undefined); // classified failures surface via toolkit.getStatus

  const bootClock = new BootClock();
  bootClock.mark("main-modules-evaluated");
  bootClock.mark("app-ready");
  bootClock.mark("window-created");

  const notifications: RecordedNotification[] = [];
  const notificationPort: OsNotificationPort = {
    supported: () => true,
    show: ({ title, body }) => notifications.push({ title, body }),
  };
  const shellReveals: AppHandle["shellReveals"] = [];
  const shell: RevealShell = {
    showItemInFolder: (p) => shellReveals.push({ mode: "folder", path: p }),
    openPath: async (p) => {
      shellReveals.push({ mode: "open", path: p });
      return "";
    },
  };
  const directoryPicker: DirectoryPicker = { pick: async () => null };

  // Updater stub: diagnostics embeds the snapshot; the unavailable state is exactly
  // what the real app reports for unpackaged runs (same reason — no electron-updater).
  const appVersion = desktopVersion();
  const unavailableUpdateState = (): UpdateState => ({
    status: "unavailable",
    unavailableReason: "not_packaged",
    currentVersion: appVersion,
    availableVersion: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    errorCode: null,
    message: null,
    lastCheckedAt: null,
  });
  const updateController = {
    getState: (): UpdateState => unavailableUpdateState(),
  };

  const pushRuntimeProxies = (): void => {
    void proxyStore
      .runtimeEndpoints()
      .then((profiles) => supervisor.request("proxy.setRuntime", { profiles }))
      .catch(() => undefined);
  };

  registerAppDomains({
    router,
    supervisor,
    settings,
    proxyStore,
    toolkit,
    logger,
    bootClock,
    updateController,
    pushRuntimeProxies,
    shell,
    directoryPicker,
    notificationPort,
    appFacts: {
      version: appVersion,
      electronVersion: "e2e-headless",
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeMs: () => Math.round(process.uptime() * 1000),
      memoryRssBytes: () => process.memoryUsage().rss,
    },
    perfReport: {
      // The REAL budgets file from apps/desktop/resources — the same bytes the packaged
      // app ships and the build gate enforces.
      budgetsFile: resolve(REPO_ROOT, "apps", "desktop", "resources", "perf-budgets.json"),
      bootClock,
      supervisor,
      appVersion,
      platform: process.platform,
      osRelease: osRelease(),
      source: "headless-test",
      rendererAssetsDir: resolve(REPO_ROOT, "apps", "desktop", "dist", "renderer", "assets"),
      logger,
    },
  });

  supervisor.on("state", (status: string) => {
    router.emit("core.state", EVENTS["core.state"].payload, { status });
    if (status === "ready") {
      bootClock.mark("core-ready");
      pushCoreRuntimeState({ supervisor, settings, toolkit, pushRuntimeProxies });
    }
  });

  const mirror = makePreloadMirror(router);

  // Production boot order: the composition is fully registered before the supervisor
  // starts (main.ts does the same), so the core's ready push always finds its targets.
  bootClock.mark("core-spawned");
  supervisor.start();

  const waitEvent = (
    name: string,
    predicate?: (payload: unknown) => boolean,
    timeoutMs = 30_000,
  ): Promise<unknown> => {
    const existing = eventLog.find((e) => e.name === name && (!predicate || predicate(e.payload)));
    if (existing) return Promise.resolve(existing.payload);
    return new Promise((resolvePromise, reject) => {
      const off = router.onEvent((eventName, payload) => {
        if (eventName !== name) return;
        if (predicate && !predicate(payload)) return;
        clearTimeout(timer);
        off();
        resolvePromise(payload);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for event ${name} after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  };

  const stop = async (): Promise<void> => {
    await supervisor.stop(6_000);
  };

  const dispose = async (): Promise<void> => {
    await stop();
    await rm(userDataDir, { recursive: true, force: true });
  };

  return {
    userDataDir,
    router,
    supervisor,
    settings,
    proxyStore,
    toolkit,
    logger,
    bootClock,
    notifications,
    shellReveals,
    eventLog,
    mirror,
    rpc: (method, params) => mirror.rpc(method, params),
    waitEvent,
    stop,
    dispose,
  };
}

export interface BootOptions {
  maxConcurrent?: number;
  maxConnectionsPerDownload?: number;
  /** Reuse an existing userData dir (persistence drills: boot #2 over the same DB). */
  userDataDir?: string;
}

/** Wait until a download job reaches the given status (polls download.get). */
export async function waitForJobStatus(
  app: AppHandle,
  jobId: string,
  status: string,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = (await app.rpc("download.get", { id: jobId })) as {
      job: Record<string, unknown> | null;
    };
    if (result.job && result.job.status === status) return result.job;
    if (
      result.job &&
      ["failed", "completed", "canceled"].includes(String(result.job.status)) &&
      result.job.status !== status
    ) {
      throw new Error(
        `job ${jobId} reached terminal ${String(result.job.status)} instead of ${status}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not reach ${status} within ${timeoutMs}ms (last: ${JSON.stringify(result.job)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
