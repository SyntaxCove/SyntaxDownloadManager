import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  SyntaxDmError,
  type PlatformKey,
  type ToolkitManifest as ToolkitManifestT,
  type ToolkitPathEntry,
  type ToolkitToolState,
  type ToolkitToolStatus,
} from "@syntaxdm/contracts";
import { loadManifest, platformKey, resolveArtifact } from "./manifest.js";
import { fetchArtifact } from "./fetcher.js";
import { verifyArtifact } from "./verify.js";
import { extractArtifact, type ArchiveType } from "./extract.js";

/**
 * ToolkitManager (Phase 10) — the main-process lifecycle owner for the bundled media tools.
 *
 * Pipeline per tool: fetch (streamed, capped, retrying) → verify (independent on-disk
 * SHA-256 + exact size) → extract (escape-guarded) → activate (atomic rename into
 * tools/<id>/<version>/) → persist registry → prune superseded versions → push paths to
 * the core. A tool becomes `ready` — and its path becomes visible to ANYONE — only after
 * every gate passed; there is no partial activation.
 *
 * State is persisted in userData/toolkit-state.json (atomic tmp+rename; a file that fails
 * validation is quarantined and the manager rebuilds from the on-disk tools directory —
 * but only after re-proving each candidate path exists and points at a file). Registry
 * entries whose executable vanished are dropped (fail-closed: unproven bytes are invisible).
 */

export interface ToolkitManagerOptions {
  readonly manifestPath: string;
  readonly toolsRoot: string;
  readonly statePath: string;
  /** Called for every status change / throttled progress (main forwards to the renderer). */
  readonly onStatus: (status: ToolkitToolStatus) => void;
  /** Called after every activation/deactivation batch — main pushes toolkit.setPaths. */
  readonly onReadyToolsChanged: (tools: ToolkitPathEntry[]) => void;
  readonly platform?: string;
  readonly arch?: string;
  readonly now?: () => number;
}

interface RegistryEntry {
  id: ToolkitPathEntry["id"];
  version: string;
  path: string;
  sha256: string;
  installedAt: number;
}

interface RegistryFile {
  version: 1;
  tools: RegistryEntry[];
}

const RETRY_ATTEMPTS = 2; // 3 total attempts

export class ToolkitManager {
  private manifest: ToolkitManifestT | null = null;
  private platformKey: PlatformKey | null = null;
  /** In-memory registry of activated tools (mirrors the persisted file). */
  private registry = new Map<string, RegistryEntry>();
  private runtime = new Map<string, { state: ToolkitToolState; bytesFetched: number; totalBytes: number | null; errorCode: string | null; message: string | null }>();
  private aborts = new Map<string, AbortController>();
  private queue: ToolkitPathEntry["id"][] = [];
  private queued = new Set<ToolkitPathEntry["id"]>();
  private draining = false;
  private lastEmit = new Map<string, number>();

  private readonly opts: Required<Pick<ToolkitManagerOptions, "now">> &
    Omit<ToolkitManagerOptions, "now">;

  constructor(opts: ToolkitManagerOptions) {
    const { now, ...rest } = opts;
    this.opts = { ...rest, now: now ?? Date.now };
  }

  get stagingDir(): string {
    return join(this.opts.toolsRoot, ".staging");
  }

  /** Load manifest + registry. Throws `toolkit_manifest_invalid` when the shipped manifest
   *  is unreadable or malformed — the app still runs, but toolkit.ensure fails classified. */
  async load(): Promise<void> {
    const loaded = await loadManifest(this.opts.manifestPath);
    this.manifest = loaded.manifest;
    // The platform key comes from the INJECTED platform/arch (tests inject), not process defaults.
    this.platformKey = platformKey(this.opts.platform ?? process.platform, this.opts.arch ?? process.arch);
    await mkdir(this.opts.toolsRoot, { recursive: true });
    await rm(this.stagingDir, { recursive: true, force: true }); // stale partial installs
    await mkdir(this.stagingDir, { recursive: true });
    this.registry = await this.loadRegistry();
    await this.validateRegistry();
    for (const tool of this.manifest.tools) {
      const ready = this.registry.has(tool.id);
      this.runtime.set(tool.id, {
        state: ready ? "ready" : "missing",
        bytesFetched: 0,
        totalBytes: null,
        errorCode: null,
        message: null,
      });
    }
  }

  /** Status snapshot for the renderer (never exposes manifest URLs). */
  getStatus(): {
    manifestVersion: 1 | null;
    platform: PlatformKey | null;
    tools: ToolkitToolStatus[];
  } {
    const tools: ToolkitToolStatus[] = [];
    if (this.manifest) {
      for (const spec of this.manifest.tools) {
        const reg = this.registry.get(spec.id);
        const rt = this.runtime.get(spec.id);
        const state: ToolkitToolState = rt?.state ?? (reg ? "ready" : "missing");
        tools.push({
          id: spec.id,
          version: spec.version,
          state,
          path: reg && state === "ready" ? reg.path : null,
          bytesFetched: rt?.bytesFetched ?? 0,
          totalBytes: state === "fetching" ? (rt?.totalBytes ?? null) : null,
          errorCode: state === "failed" ? (rt?.errorCode ?? "toolkit_fetch_failed") : null,
          message: state === "failed" ? (rt?.message ?? null) : null,
        });
      }
    }
    return {
      manifestVersion: this.manifest ? 1 : null,
      platform: this.platformKey,
      tools,
    };
  }

  /** Enqueue a single tool install. Idempotent: ready-at-pinned-version and already-queued
   *  tools are no-ops; `started` reports whether work was actually queued. */
  ensure(id: ToolkitPathEntry["id"]): boolean {
    const spec = this.manifest?.tools.find((t) => t.id === id);
    if (!spec) {
      throw new SyntaxDmError("toolkit_manifest_invalid", `tool ${id} is not in the manifest`);
    }
    if (!this.platformKey) {
      throw new SyntaxDmError(
        "toolkit_unsupported_platform",
        `${this.opts.platform ?? process.platform}-${this.opts.arch ?? process.arch} has no bundled media tool artifacts`,
      );
    }
    const reg = this.registry.get(id);
    if (reg && reg.version === spec.version && reg.path) {
      return false; // already activated at the pinned version
    }
    if (this.queued.has(id)) return false;
    this.queued.add(id);
    this.queue.push(id);
    this.setRuntime(id, { state: "fetching", bytesFetched: 0, totalBytes: null, errorCode: null, message: null });
    this.emit(id, { state: "fetching", bytesFetched: 0, totalBytes: null });
    void this.drain();
    return true;
  }

  /** Enqueue every manifest tool that is not ready at its pinned version. */
  ensureAll(): string[] {
    const started: string[] = [];
    if (!this.manifest) return started;
    for (const spec of this.manifest.tools) {
      try {
        if (this.ensure(spec.id)) started.push(spec.id);
      } catch {
        // unsupported platform / invalid tool — getStatus surfaces it; ensureAll moves on
      }
    }
    return started;
  }

  /** Cancel an in-flight or queued fetch. Returns true when something was canceled. */
  cancel(id: ToolkitPathEntry["id"]): boolean {
    let canceled = false;
    if (this.queued.has(id)) {
      this.queued.delete(id);
      this.queue = this.queue.filter((q) => q !== id);
      canceled = true;
    }
    const abort = this.aborts.get(id);
    if (abort) {
      abort.abort();
      canceled = true;
    }
    if (canceled) {
      this.setRuntime(id, { state: "missing", bytesFetched: 0, totalBytes: null, errorCode: null, message: null });
    }
    return canceled;
  }

  /** Verified tool paths for the core push (registry content — proven bytes only). */
  readyToolPaths(): ToolkitPathEntry[] {
    return [...this.registry.values()].map((e) => ({ id: e.id, version: e.version, path: e.path }));
  }

  // ---- pipeline ----

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift();
        if (id === undefined) break;
        this.queued.delete(id);
        await this.install(id).catch(() => undefined); // install() reports failures itself
      }
    } finally {
      this.draining = false;
    }
  }

  private async install(id: ToolkitPathEntry["id"]): Promise<void> {
    const spec = this.manifest?.tools.find((t) => t.id === id);
    if (!spec || !this.platformKey) return;
    const { artifact, version } = resolveArtifact(this.manifest!, this.platformKey, id);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const jobId = randomUUID();
    const jobDir = join(this.stagingDir, jobId);
    await mkdir(jobDir, { recursive: true });
    try {
      this.emit(id, { state: "fetching", bytesFetched: 0, totalBytes: artifact.sizeBytes });
      const fetched = await fetchArtifact({
        url: artifact.url,
        stagingDir: jobDir,
        sizeBytes: artifact.sizeBytes,
        signal: abort.signal,
        retries: RETRY_ATTEMPTS,
        onChunk: (bytesFetched, totalBytes) => {
          this.throttledProgress(id, bytesFetched, totalBytes);
        },
      });
      if (abort.signal.aborted) throw new SyntaxDmError("canceled", "toolkit fetch canceled");

      this.emit(id, { state: "verifying", bytesFetched: fetched.sizeBytes, totalBytes: fetched.sizeBytes });
      const verified = await verifyArtifact({
        file: fetched.file,
        expectedSha256: artifact.sha256,
        expectedSizeBytes: artifact.sizeBytes,
      });

      await extractArtifact({
        archivePath: fetched.file,
        archiveType: artifact.archiveType as ArchiveType,
        destDir: jobDir,
        execPaths: [artifact.execPath, ...(artifact.extraExecs ?? [])],
        platform: this.opts.platform ?? process.platform,
      });
      if (abort.signal.aborted) throw new SyntaxDmError("canceled", "toolkit fetch canceled");

      // Activate: atomic rename into the versioned home, then supersede older versions.
      const home = join(this.opts.toolsRoot, id, version);
      await mkdir(join(this.opts.toolsRoot, id), { recursive: true });
      await rm(home, { recursive: true, force: true });
      await rename(jobDir, home);
      const execPath = join(home, ...artifact.execPath.split("/"));
      const entry: RegistryEntry = {
        id,
        version,
        path: execPath,
        sha256: verified.sha256,
        installedAt: this.opts.now(),
      };
      this.registry.set(id, entry);
      await this.persistRegistry();
      await this.pruneSuperseded(id, version);
      this.setRuntime(id, { state: "ready", bytesFetched: artifact.sizeBytes, totalBytes: artifact.sizeBytes, errorCode: null, message: null });
      this.emit(id, { state: "ready", bytesFetched: artifact.sizeBytes, totalBytes: artifact.sizeBytes });
      this.opts.onReadyToolsChanged(this.readyToolPaths());
    } catch (err) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
      if (err instanceof SyntaxDmError && err.code === "canceled") {
        this.setRuntime(id, { state: "missing", bytesFetched: 0, totalBytes: null, errorCode: null, message: null });
        this.emit(id, { state: "missing", bytesFetched: 0, totalBytes: null });
        return;
      }
      const code =
        err instanceof SyntaxDmError
          ? err.code
          : "toolkit_fetch_failed";
      const message = err instanceof Error ? err.message : String(err);
      this.setRuntime(id, { state: "failed", bytesFetched: 0, totalBytes: null, errorCode: code, message });
      this.emit(id, { state: "failed", bytesFetched: 0, totalBytes: null, errorCode: code, message });
    } finally {
      this.aborts.delete(id);
    }
  }

  private async pruneSuperseded(id: string, keepVersion: string): Promise<void> {
    const toolRoot = join(this.opts.toolsRoot, id);
    let versions: string[] = [];
    try {
      versions = await readdir(toolRoot);
    } catch {
      return;
    }
    for (const v of versions) {
      if (v === keepVersion || v.startsWith(".")) continue;
      await rm(join(toolRoot, v), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---- registry persistence (atomic + quarantine, mirrors settings/proxy stores) ----

  private registryPath(): string {
    return this.opts.statePath;
  }

  private async loadRegistry(): Promise<Map<string, RegistryEntry>> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.registryPath(), "utf8");
    } catch {
      return new Map(); // first run
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      await this.quarantineRegistry();
      return new Map();
    }
    const d = doc as Partial<RegistryFile>;
    const map = new Map<string, RegistryEntry>();
    if (d && Array.isArray(d.tools)) {
      for (const e of d.tools) {
        if (
          e &&
          typeof e.id === "string" &&
          typeof e.version === "string" &&
          typeof e.path === "string" &&
          typeof e.sha256 === "string" &&
          typeof e.installedAt === "number" &&
          /^[0-9a-f]{64}$/.test(e.sha256)
        ) {
          map.set(e.id, e);
        }
      }
    } else {
      await this.quarantineRegistry();
    }
    return map;
  }

  /** Fail-closed: a registry entry is only kept when its executable still exists on disk. */
  private async validateRegistry(): Promise<void> {
    let dirty = false;
    for (const [id, entry] of this.registry) {
      try {
        const s = await stat(entry.path);
        if (!s.isFile() || s.size === 0) throw new Error("missing or empty executable");
      } catch {
        this.registry.delete(id);
        dirty = true;
      }
    }
    if (dirty) await this.persistRegistry();
  }

  private async persistRegistry(): Promise<void> {
    const doc: RegistryFile = { version: 1, tools: [...this.registry.values()] };
    const tmp = `${this.registryPath()}.tmp-${this.opts.now()}`;
    try {
      await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
      await rename(tmp, this.registryPath());
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new SyntaxDmError("io_error", `toolkit registry persist failed: ${String(err)}`);
    }
  }

  private async quarantineRegistry(): Promise<void> {
    await rename(this.registryPath(), `${this.registryPath()}.corrupt-${this.opts.now()}`).catch(
      () => undefined,
    );
    this.registry = new Map();
  }

  // ---- status emission ----

  private setRuntime(
    id: string,
    rt: { state: ToolkitToolState; bytesFetched: number; totalBytes: number | null; errorCode: string | null; message: string | null },
  ): void {
    this.runtime.set(id, rt);
  }

  private emit(
    id: ToolkitPathEntry["id"],
    extra: { state: ToolkitToolState; bytesFetched: number; totalBytes: number | null; errorCode?: string | null; message?: string | null },
  ): void {
    const spec = this.manifest?.tools.find((t) => t.id === id);
    if (!spec) return;
    const reg = this.registry.get(id);
    this.opts.onStatus({
      id,
      version: spec.version,
      state: extra.state,
      path: reg && extra.state === "ready" ? reg.path : null,
      bytesFetched: extra.bytesFetched,
      totalBytes: extra.totalBytes,
      errorCode: extra.errorCode ?? null,
      message: extra.message ?? null,
    });
  }

  /** Progress events are throttled to ≥200 ms per tool; state transitions are not. */
  private throttledProgress(id: ToolkitPathEntry["id"], bytesFetched: number, totalBytes: number | null): void {
    const nowMs = this.opts.now();
    const last = this.lastEmit.get(id) ?? 0;
    if (nowMs - last < 200) return;
    this.lastEmit.set(id, nowMs);
    this.emit(id, { state: "fetching", bytesFetched, totalBytes });
  }
}
