import https from "node:https";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolkitManager } from "../toolkit/manager.js";
import { UniDmError, type ToolkitPathEntry, type ToolkitToolStatus } from "@unidm/contracts";

/**
 * Toolkit pipeline integration tests (Phase 10): a real local HTTPS server serves real
 * archives (zip via yazl, tar.xz via tar-stream + lzma-native, and raw single-file
 * artifacts); the manager's fetch → verify → extract → activate → persist → push flow is
 * exercised end-to-end, including every failure gate.
 */

// ---- archive builders ----

async function buildZip(files: Record<string, Buffer | string>): Promise<Buffer> {
  const yazl = await import("yazl");
  const zipfile = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) {
    zipfile.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), name);
  }
  zipfile.end();
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  await new Promise<void>((res, rej) => {
    zipfile.outputStream.pipe(sink).on("finish", res).on("error", rej);
  });
  return Buffer.concat(chunks);
}

/** Hand-assembled stored-entry zip — used for hostile entry names that honest zip
 *  writers (yazl) refuse to produce ("../escape"). yauzl must still be able to open it. */
function evilZip(entryName: string, content: Buffer): Buffer {
  const crc = zlib.crc32(content) >>> 0;
  const name = Buffer.from(entryName, "utf8");
  const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  const local = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(0), u16(0), u16(0),
    u32(crc), u32(content.length), u32(content.length), u16(name.length), u16(0), name,
  ]);
  const central = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
    u32(crc), u32(content.length), u32(content.length), u16(name.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(0), name,
  ]);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(1), u16(1),
    u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, content, central, eocd]);
}

async function buildTarXz(files: Record<string, Buffer | string>): Promise<Buffer> {
  const tar = await import("tar-stream");
  const lzma = await import("lzma-native");
  const { Readable } = await import("node:stream");

  const pack = tar.pack();
  const compressor = lzma.createCompressor({ threads: 1 }) as NodeJS.ReadWriteStream;
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  const done = new Promise<void>((res, rej) => {
    compressor.pipe(sink).on("finish", res).on("error", rej);
  });
  void Readable.from(pack).pipe(compressor);

  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    await new Promise<void>((res, rej) => {
      pack.entry({ name, size: buf.length }, buf, (err?: Error | null) =>
        err ? rej(err) : res(),
      );
    });
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

// ---- HTTP harness ----

interface ServePlan {
  /** One entry per HTTP request served, in order (arrays cycle on the last). */
  status?: number[];
  body?: Buffer;
  /** Truncate the served body to this many bytes (simulates a cut stream). */
  serveBytes?: number;
  /** Never end the response (for cancellation tests). */
  hang?: boolean;
  /** Drop the connection after N bytes without ending. */
  cutAfter?: number;
}

function startServer(plan: ServePlan): Promise<{ server: Server; url: string; requests: () => number }> {
  let served = 0;
  const server = https.createServer(
    {
      key: readFileSync(join(tlsDir, "key.pem")),
      cert: readFileSync(join(tlsDir, "cert.pem")),
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const idx = Math.min(served, (plan.status?.length ?? 1) - 1);
      served++;
      const status = plan.status?.[idx] ?? 200;
      if (status !== 200) {
        res.writeHead(status).end("nope");
        return;
      }
      const body = plan.body ?? Buffer.alloc(0);
      if (plan.hang) {
        res.writeHead(200, { "content-length": String(body.length) });
        res.write(body.subarray(0, Math.min(body.length, 64)));
        return; // never end — client must abort
      }
      if (plan.cutAfter !== undefined) {
        res.writeHead(200, { "content-length": String(body.length) });
        res.write(body.subarray(0, plan.cutAfter));
        res.destroy();
        return;
      }
      // A clean, complete response — possibly shorter than the pin (verify-gate test).
      const out = plan.serveBytes !== undefined ? body.subarray(0, plan.serveBytes) : body;
      res.writeHead(200, { "content-length": String(out.length) });
      res.end(out);
    },
  );
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `https://127.0.0.1:${port}/artifact`, requests: () => served });
    });
  });
}

// ---- manager harness ----

interface Fixture {
  root: string;
  manifestPath: string;
  statePath: string;
  toolsRoot: string;
  statuses: ToolkitToolStatus[];
  corePushes: ToolkitPathEntry[][];
}

async function writeManifest(
  manifestPath: string,
  tool: {
    id: string;
    version: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    archiveType: "none" | "zip" | "tar.xz";
    execPath: string;
    extraExecs?: string[];
  },
): Promise<void> {
  const manifest = {
    manifestVersion: 1,
    tools: [
      {
        id: tool.id,
        version: tool.version,
        platforms: {
          "linux-x64": {
            url: tool.url,
            sha256: tool.sha256,
            sizeBytes: tool.sizeBytes,
            archiveType: tool.archiveType,
            execPath: tool.execPath,
            ...(tool.extraExecs ? { extraExecs: tool.extraExecs } : {}),
          },
        },
      },
    ],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "unidm-toolkit-"));
  const manifestPath = join(root, "toolchains.json");
  const statePath = join(root, "toolkit-state.json");
  const toolsRoot = join(root, "tools");
  const fixture: Fixture = {
    root,
    manifestPath,
    statePath,
    toolsRoot,
    statuses: [],
    corePushes: [],
  };
  return fixture;
}

function makeManager(f: Fixture, opts: { platform?: string } = {}): ToolkitManager {
  return new ToolkitManager({
    manifestPath: f.manifestPath,
    toolsRoot: f.toolsRoot,
    statePath: f.statePath,
    onStatus: (s) => f.statuses.push(s),
    onReadyToolsChanged: (tools) => f.corePushes.push(tools),
    platform: opts.platform ?? "linux",
    arch: "x64",
  });
}

async function waitFor(
  f: Fixture,
  toolId: string,
  state: ToolkitToolStatus["state"],
  timeoutMs = 10_000,
): Promise<ToolkitToolStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = f.statuses.find((s) => s.id === toolId && s.state === state);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${toolId} → ${state}; statuses: ${JSON.stringify(f.statuses)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---- tests ----

// The shipped manifest enforces https-only artifact URLs (contract-level). The local
// harness therefore runs a real TLS server with a throwaway self-signed certificate and
// disables trust-checking for the TEST PROCESS ONLY — the production fetch path is
// exercised end-to-end over https exactly as it will run for real artifacts.
let tlsDir: string;

beforeAll(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  tlsDir = mkdtempSync(join(tmpdir(), "unidm-tls-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(tlsDir, "key.pem"), "-out", join(tlsDir, "cert.pem"),
    "-days", "2", "-subj", "/CN=localhost",
  ]);
});

describe("toolkit pipeline (Phase 10)", () => {
  let servers: Server[] = [];
  let fixtures: string[] = [];

  beforeEach(() => {
    servers = [];
    fixtures = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const s of servers) await new Promise<void>((res) => s.close(() => res()));
    for (const f of fixtures) await rm(f, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function track(f: Fixture): Promise<void> {
    fixtures.push(f.root);
  }

  it("installs a raw single-file artifact end-to-end (none archive)", async () => {
    const f = await makeFixture();
    await track(f);
    const body = Buffer.from("#!/bin/sh\necho yt-dlp\n");
    const { server, url } = await startServer({ body });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "2025.09.26",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    expect(manager.getStatus().tools[0]!.state).toBe("missing");

    const started = manager.ensure("yt-dlp");
    expect(started).toBe(true);
    const ready = await waitFor(f, "yt-dlp", "ready");
    expect(ready.path).toBe(join(f.toolsRoot, "yt-dlp", "2025.09.26", "yt-dlp"));
    const content = await readFile(ready.path!, "utf8");
    expect(content).toContain("echo yt-dlp");
    // exec bit set on linux
    const st = await stat(ready.path!);
    expect(st.mode & 0o111).toBeTruthy();
    // registry persisted + core pushed exactly the ready tools
    const persisted = JSON.parse(await readFile(f.statePath, "utf8"));
    expect(persisted.tools[0].path).toBe(ready.path);
    expect(f.corePushes.at(-1)).toEqual([
      { id: "yt-dlp", version: "2025.09.26", path: ready.path },
    ]);
    // second ensure is a no-op at the pinned version
    expect(manager.ensure("yt-dlp")).toBe(false);
    // stale staging dir cleaned up
    const leftovers = await readdir(join(f.toolsRoot, ".staging"));
    expect(leftovers).toEqual([]);
  });

  it("installs a zip archive with nested exec path and chmods it", async () => {
    const f = await makeFixture();
    await track(f);
    const exe = Buffer.from("MZfake-ffmpeg-binary");
    const zip = await buildZip({ "ffmpeg-8.0/bin/ffmpeg.exe": exe, "ffmpeg-8.0/README.txt": "hi" });
    const { server, url } = await startServer({ body: zip });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "ffmpeg",
      version: "8.0.1",
      url,
      sha256: createHash("sha256").update(zip).digest("hex"),
      sizeBytes: zip.length,
      archiveType: "zip",
      execPath: "ffmpeg-8.0/bin/ffmpeg.exe",
      extraExecs: ["ffmpeg-8.0/README.txt"],
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("ffmpeg");
    const ready = await waitFor(f, "ffmpeg", "ready");
    expect(await readFile(ready.path!, null)).toEqual(exe);
    expect((await stat(ready.path!)).mode & 0o111).toBeTruthy();
    expect((await stat(join(f.toolsRoot, "ffmpeg", "8.0.1", "ffmpeg-8.0/README.txt"))).mode & 0o111).toBeTruthy();
  });

  it("installs a tar.xz archive", async () => {
    const f = await makeFixture();
    await track(f);
    const bin = Buffer.from("static-ffmpeg-bytes");
    const tarxz = await buildTarXz({ "ffmpeg-7.0.2-amd64-static/ffmpeg": bin });
    const { server, url } = await startServer({ body: tarxz });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "ffmpeg",
      version: "7.0.2",
      url,
      sha256: createHash("sha256").update(tarxz).digest("hex"),
      sizeBytes: tarxz.length,
      archiveType: "tar.xz",
      execPath: "ffmpeg-7.0.2-amd64-static/ffmpeg",
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("ffmpeg");
    const ready = await waitFor(f, "ffmpeg", "ready");
    expect(await readFile(ready.path!, null)).toEqual(bin);
  }, 30_000);

  it("fails with toolkit_checksum_mismatch and keeps nothing", async () => {
    const f = await makeFixture();
    await track(f);
    const body = Buffer.from("legit bytes but the hash will lie");
    const { server, url } = await startServer({ body });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: "ab".repeat(32), // wrong on purpose
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("yt-dlp");
    const failed = await waitFor(f, "yt-dlp", "failed");
    expect(failed.errorCode).toBe("toolkit_checksum_mismatch");
    // no activated dir, no registry, no core push
    await expect(stat(join(f.toolsRoot, "yt-dlp"))).rejects.toBeTruthy();
    await expect(readFile(f.statePath, "utf8")).rejects.toBeTruthy();
    expect(f.corePushes).toEqual([]);
    // staging is empty again
    expect(await readdir(join(f.toolsRoot, ".staging"))).toEqual([]);
  });

  it("rejects a body that deviates from the pinned size (clean short body)", async () => {
    const f = await makeFixture();
    await track(f);
    const body = randomBytes(4096);
    // The server sends a complete, cleanly-terminated 1000-byte body — the verify gate
    // (not the network) must catch the deviation from the pinned 4096.
    const { server, url } = await startServer({ body, serveBytes: 1000 });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("yt-dlp");
    const failed = await waitFor(f, "yt-dlp", "failed");
    expect(failed.errorCode).toBe("toolkit_checksum_mismatch");
    expect(f.corePushes).toEqual([]);
  });

  it("retries transient failures and then succeeds", async () => {
    const f = await makeFixture();
    await track(f);
    const body = Buffer.from("retry-me");
    const { server, url, requests } = await startServer({ status: [503, 503, 200], body });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("yt-dlp");
    const ready = await waitFor(f, "yt-dlp", "ready");
    expect(ready.path).toContain("yt-dlp");
    expect(requests()).toBe(3);
  });

  it("cuts a runaway stream at the size cap", async () => {
    const f = await makeFixture();
    await track(f);
    const body = randomBytes(3 * 1024 * 1024); // 3 MiB vs a 1 KiB pin → cap trips mid-stream
    const { server, url } = await startServer({ body });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: 1024,
      archiveType: "none",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("yt-dlp");
    const failed = await waitFor(f, "yt-dlp", "failed");
    expect(failed.errorCode).toBe("toolkit_fetch_failed");
    expect(failed.message).toMatch(/size cap/);
  }, 30_000);

  it("rejects zip-slip entries and writes nothing outside the root", async () => {
    const f = await makeFixture();
    await track(f);
    // Hand-crafted: honest zip writers refuse traversal names, so assemble one directly.
    const evil = evilZip("../escaped.txt", Buffer.from("pwn"));
    const { server, url } = await startServer({ body: evil });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(evil).digest("hex"),
      sizeBytes: evil.length,
      archiveType: "zip",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    manager.ensure("yt-dlp");
    const failed = await waitFor(f, "yt-dlp", "failed");
    expect(failed.errorCode).toBe("toolkit_extract_failed");
    // the escaped file must NOT exist next to the tools root
    await expect(stat(join(f.toolsRoot, "escaped.txt"))).rejects.toBeTruthy();
    await expect(stat(join(f.root, "escaped.txt"))).rejects.toBeTruthy();
    expect(f.corePushes).toEqual([]);
  });

  it("cancels an in-flight fetch and reports missing", async () => {
    const f = await makeFixture();
    await track(f);
    const body = randomBytes(1024 * 1024);
    const { server, url } = await startServer({ body, hang: true });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });

    const manager = makeManager(f);
    await manager.load();
    expect(manager.ensure("yt-dlp")).toBe(true);
    await waitFor(f, "yt-dlp", "fetching");
    expect(manager.cancel("yt-dlp")).toBe(true);
    await waitFor(f, "yt-dlp", "missing");
    expect(f.corePushes).toEqual([]);
  });

  it("quarantines a corrupt registry and drops entries whose executable vanished", async () => {
    const f = await makeFixture();
    await track(f);
    const body = Buffer.from("x");
    const { server, url } = await startServer({ body });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });
    // corrupt JSON → quarantine
    await writeFile(f.statePath, "{not json", "utf8");
    const manager = makeManager(f);
    await manager.load();
    expect(manager.readyToolPaths()).toEqual([]);
    const quarantined = await readdir(f.root);
    expect(quarantined.some((n) => n.startsWith("toolkit-state.json.corrupt-"))).toBe(true);

    // valid JSON but the executable is gone → entry dropped (fail-closed)
    await writeFile(
      f.statePath,
      JSON.stringify({
        version: 1,
        tools: [
          { id: "yt-dlp", version: "1", path: join(f.root, "vanished", "yt-dlp"), sha256: "ab".repeat(32), installedAt: 1 },
        ],
      }),
      "utf8",
    );
    const manager2 = makeManager(f);
    await manager2.load();
    expect(manager2.readyToolPaths()).toEqual([]);
    const status = manager2.getStatus();
    expect(status.tools[0]!.state).toBe("missing");
  });

  it("prunes superseded versions after a re-pin", async () => {
    const f = await makeFixture();
    await track(f);
    const bodyV1 = Buffer.from("tool v1");
    const bodyV2 = Buffer.from("tool v2 with different content");
    const { server, url } = await startServer({ body: bodyV1 });
    const { server: server2, url: url2 } = await startServer({ body: bodyV2 });
    servers.push(server, server2);

    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1.0.0",
      url,
      sha256: createHash("sha256").update(bodyV1).digest("hex"),
      sizeBytes: bodyV1.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });
    const manager = makeManager(f);
    await manager.load();
    manager.ensure("yt-dlp");
    await waitFor(f, "yt-dlp", "ready");

    // Re-pin: a fresh manager reads the updated manifest and installs 2.0.0.
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "2.0.0",
      url: url2,
      sha256: createHash("sha256").update(bodyV2).digest("hex"),
      sizeBytes: bodyV2.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });
    const manager2 = new ToolkitManager({
      manifestPath: f.manifestPath,
      toolsRoot: f.toolsRoot,
      statePath: f.statePath,
      onStatus: (s) => f.statuses.push(s),
      onReadyToolsChanged: (tools) => f.corePushes.push(tools),
      platform: "linux",
      arch: "x64",
    });
    await manager2.load();
    manager2.ensure("yt-dlp");
    const readyV2 = await vi.waitFor(
      () => {
        const found = f.statuses.find(
          (s) => s.id === "yt-dlp" && s.state === "ready" && s.version === "2.0.0",
        );
        if (!found) throw new Error("v2 not ready yet");
        return found;
      },
      { timeout: 15_000, interval: 25 },
    );
    expect(readyV2.path).toContain("2.0.0");
    const versions = await readdir(join(f.toolsRoot, "yt-dlp"));
    expect(versions).toEqual(["2.0.0"]);
    const persisted = JSON.parse(await readFile(f.statePath, "utf8"));
    expect(persisted.tools[0].version).toBe("2.0.0");
  });

  it("surfaces toolkit_unsupported_platform on unsupported hosts", async () => {
    const f = await makeFixture();
    await track(f);
    const body = Buffer.from("x");
    const { server, url } = await startServer({ body });
    servers.push(server);
    await writeManifest(f.manifestPath, {
      id: "yt-dlp",
      version: "1",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      archiveType: "none",
      execPath: "yt-dlp",
    });
    const manager = makeManager(f, { platform: "darwin" });
    await manager.load();
    expect(() => manager.ensure("yt-dlp")).toThrowError(/darwin/);
    try {
      manager.ensure("yt-dlp");
      expect.unreachable();
    } catch (err) {
      expect((err as UniDmError).code).toBe("toolkit_unsupported_platform");
    }
    expect(manager.getStatus().platform).toBeNull();
    expect(manager.ensureAll()).toEqual([]);
  });

  it("ensureAll installs every missing tool and is idempotent while running", async () => {
    const f = await makeFixture();
    await track(f);
    const yt = Buffer.from("yt binary");
    const deno = Buffer.from("deno binary");
    const s1 = await startServer({ body: yt });
    const s2 = await startServer({ body: deno });
    servers.push(s1.server, s2.server);
    const manifest = {
      manifestVersion: 1,
      tools: [
        {
          id: "yt-dlp",
          version: "1",
          platforms: {
            "linux-x64": {
              url: s1.url,
              sha256: createHash("sha256").update(yt).digest("hex"),
              sizeBytes: yt.length,
              archiveType: "none",
              execPath: "yt-dlp",
            },
          },
        },
        {
          id: "deno",
          version: "1",
          platforms: {
            "linux-x64": {
              url: s2.url,
              sha256: createHash("sha256").update(deno).digest("hex"),
              sizeBytes: deno.length,
              archiveType: "none",
              execPath: "deno",
            },
          },
        },
      ],
    };
    await writeFile(f.manifestPath, JSON.stringify(manifest), "utf8");
    const manager = makeManager(f);
    await manager.load();
    const started = manager.ensureAll();
    expect(started).toEqual(["yt-dlp", "deno"]);
    await waitFor(f, "yt-dlp", "ready");
    await waitFor(f, "deno", "ready");
    const paths = manager.readyToolPaths();
    expect(paths).toHaveLength(2);
    expect(f.corePushes.at(-1)).toHaveLength(2);
    // all installed: ensureAll is now a no-op
    expect(manager.ensureAll()).toEqual([]);
  });
});
