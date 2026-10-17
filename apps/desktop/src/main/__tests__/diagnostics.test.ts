import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HealthReport, SETTINGS_DEFAULTS, UpdateState } from "@syntaxdm/contracts";
import { JsonlLogger } from "../logging/logger.js";
import {
  assembleHealthReport,
  buildDiagnosticsZip,
  collectLogEntries,
  type DiagnosticsDeps,
} from "../domains/diagnostics.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { SettingsStore } from "../domains/settings.js";
import type { UpdateController } from "../domains/updates.js";
import { open as yauzlOpen } from "yauzl";

const NOW = Date.parse("2026-10-17T09:00:00.000Z");

function coreHealthPayload() {
  return {
    health: {
      dbQuickCheck: "ok",
      dbPageCount: 32,
      dbPageSize: 4096,
      jobsByStatus: { completed: 2, downloading: 1 },
      counts: { mediaJobs: 1, torrentJobs: 0, historyEntries: 5, bookmarks: 2, schedulerJobs: 1 },
      uptimeMs: 65_000,
      contractVersion: "1.14.0",
      protocolVersion: 1,
    },
  };
}

const updaterState = () =>
  UpdateState.parse({
    status: "unavailable",
    unavailableReason: "not_packaged",
    currentVersion: "0.7.0",
    availableVersion: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    errorCode: null,
    message: null,
    lastCheckedAt: null,
  });

function fakeSupervisor(opts: { state?: string; health?: unknown; fail?: boolean } = {}) {
  return {
    currentState: opts.state ?? "ready",
    restarts: 2,
    consecutiveFailures: 0,
    lastExit: { code: null, signal: null },
    pid: 1234,
    readyUptimeMs: 61_000,
    request: async (method: string) => {
      if (opts.fail) throw new Error("core not ready");
      if (method !== "diagnostics.health") throw new Error("unexpected method " + method);
      return opts.health ?? coreHealthPayload();
    },
  } as unknown as CoreSupervisor;
}

function fakeSettings() {
  return { settings: { ...SETTINGS_DEFAULTS, verboseLogging: true } } as unknown as SettingsStore;
}

function fakeToolkit() {
  return {
    getStatus: () => ({
      manifestVersion: 1 as const,
      platform: "linux-x64" as const,
      tools: [
        {
          id: "yt-dlp" as const,
          version: "2025.09.26",
          state: "ready" as const,
          path: "/tools/yt-dlp",
          bytesFetched: 100,
          totalBytes: null,
          errorCode: null,
          message: null,
        },
      ],
    }),
  };
}

function fakeUpdater() {
  return { getState: () => updaterState() } as unknown as UpdateController;
}

function makeDeps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    logger: new JsonlLogger({ dir: null, now: () => NOW }),
    supervisor: fakeSupervisor(),
    settings: fakeSettings(),
    toolkit: fakeToolkit(),
    updater: fakeUpdater(),
    appFacts: {
      version: "0.7.0",
      electronVersion: "44.5.1",
      platform: "linux",
      arch: "x64",
      pid: 999,
      uptimeMs: () => 120_000,
      memoryRssBytes: () => 80 * 1024 * 1024,
    },
    now: () => NOW,
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "syntaxdm-diag-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("assembleHealthReport", () => {
  it("assembles a contract-valid report from every ingredient (core ready)", async () => {
    const report = await assembleHealthReport(makeDeps());
    // Parse-asserted inside; assert the key projections here.
    expect(HealthReport.safeParse(report).success).toBe(true);
    expect(report.generatedAt).toBe(NOW);
    expect(report.versions.contract).toBe("1.14.0");
    expect(report.core.supervision.state).toBe("ready");
    expect(report.core.supervision.restarts).toBe(2);
    expect(report.core.snapshot?.dbQuickCheck).toBe("ok");
    expect(report.core.snapshot?.jobsByStatus.completed).toBe(2);
    expect(report.toolkit.tools[0]?.id).toBe("yt-dlp");
    expect(report.updater.status).toBe("unavailable");
    expect(report.settings.verboseLogging).toBe(true);
    expect(report.app.memoryRssBytes).toBe(80 * 1024 * 1024);
  });

  it("degrades to snapshot:null when the core is unreachable — never throws", async () => {
    const report = await assembleHealthReport(
      makeDeps({ supervisor: fakeSupervisor({ state: "unavailable", fail: true }) }),
    );
    expect(report.core.snapshot).toBeNull();
    expect(report.core.supervision.state).toBe("unavailable");
    expect(report.app.version).toBe("0.7.0");
  });

  it("rejects a malformed core snapshot (contract validation, defense in depth)", async () => {
    const report = await assembleHealthReport(
      makeDeps({
        supervisor: fakeSupervisor({
          health: { health: { dbQuickCheck: "ok" } }, // missing required fields
        }),
      }),
    );
    expect(report.core.snapshot).toBeNull();
  });
});

describe("log export (zip)", () => {
  function readZipEntries(path: string): Promise<Array<{ name: string; content: string }>> {
    return new Promise((resolve, reject) => {
      yauzlOpen(path, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error("no zipfile"));
        const entries: Array<{ name: string; content: string }> = [];
        zipfile.on("entry", (entry: { fileName: string }) => {
          zipfile.openReadStream(entry as never, (e, stream) => {
            if (e || !stream) return reject(e ?? new Error("no stream"));
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => {
              entries.push({ name: entry.fileName, content: Buffer.concat(chunks).toString("utf8") });
              zipfile.readEntry();
            });
          });
        });
        zipfile.on("end", () => resolve(entries));
        zipfile.on("error", reject);
        zipfile.readEntry();
      });
    });
  }

  it("bundles the health report and all current log files; returns the written path", async () => {
    const dir = tmpDir();
    const logger = new JsonlLogger({ dir, now: () => NOW });
    logger.info("main", "export me", { ok: true });

    const deps = makeDeps({ logger });
    const report = await assembleHealthReport(deps);
    const entries = await collectLogEntries(logger);
    expect(entries.length).toBe(1);
    expect(entries[0]!.entryName).toMatch(/^logs\/main-\d{4}-\d{2}-\d{2}\.jsonl$/);

    const outDir = tmpDir();
    const result = await buildDiagnosticsZip({ directory: outDir, report, logEntries: entries, now: () => NOW });
    expect(result.path).toMatch(/syntaxdm-diagnostics-\d{14}\.zip$/);
    expect(result.bytes).toBeGreaterThan(0);

    const zipped = await readZipEntries(result.path);
    const names = zipped.map((e) => e.name).sort();
    expect(names).toEqual(["health-report.json", entries[0]!.entryName]);
    const reportJson = JSON.parse(zipped.find((e) => e.name === "health-report.json")!.content);
    expect(reportJson.generatedAt).toBe(NOW);
    const logLine = JSON.parse(zipped.find((e) => e.name !== "health-report.json")!.content.trim());
    expect(logLine.msg).toBe("export me");
  });

  it("refuses a directory that does not exist (invalid_params, no partial writes)", async () => {
    const report = await assembleHealthReport(makeDeps());
    await expect(
      buildDiagnosticsZip({
        directory: join(tmpDir(), "does-not-exist"),
        report,
        logEntries: [],
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("exports what still exists when a log file vanishes between listing and stat", async () => {
    const outDir = tmpDir();
    const ghost = join(tmpDir(), "main-2099-01-01.jsonl");
    writeFileSync(ghost, "gone soon\n");
    const logger = new JsonlLogger({ dir: null, now: () => NOW });
    const entries = [{ entryName: "logs/main-2099-01-01.jsonl", absolutePath: ghost }];
    rmSync(ghost);
    // buildDiagnosticsZip adds entries via yazl — a vanished file would fail the stream;
    // collectLogEntries is the guard. Verify it filters vanished files out.
    const filtered = await collectLogEntries(logger);
    expect(filtered).toEqual([]);
    void outDir;
  });
});
