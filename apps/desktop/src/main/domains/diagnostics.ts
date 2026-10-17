import {
  CONTRACT_VERSION,
  DiagnosticsHealthResult,
  HealthReport,
  METHODS,
  PROTOCOL_VERSION,
  SyntaxDmError,
  type CoreHealthSnapshot,
  type DiagToolkitStatus,
  type HealthReport as HealthReportT,
  type LogFileInfo,
  type LogLevel as LogLevelT,
} from "@syntaxdm/contracts";
import { createWriteStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { JsonlLogger } from "../logging/logger.js";
import type { SettingsStore } from "./settings.js";
import type { ToolkitManager } from "../toolkit/manager.js";
import type { UpdateController } from "./updates.js";

/**
 * Diagnostics IPC surface (Phase 20) — health report, log tail, log export.
 *
 * Assembly rules:
 *  - every ingredient degrades independently: an unreachable core yields `snapshot: null`
 *    (classified), a failing updater/toolkit read surfaces whatever its own sanitized
 *    state machine last reported — the report itself NEVER throws;
 *  - the core snapshot is contract-validated before it enters the report (defense in
 *    depth: the router validates the result again);
 *  - export writes happen in main only; the renderer's input is the directory it picked
 *    via `app.pickDirectory`, its output is the written zip path (consented surface —
 *    the `app.revealEntry` job-row rule is untouched).
 */

export interface DiagnosticsDeps {
  logger: Pick<JsonlLogger, "getRecent" | "listLogFiles" | "logsDir">;
  supervisor: Pick<
    CoreSupervisor,
    | "currentState"
    | "restarts"
    | "consecutiveFailures"
    | "lastExit"
    | "pid"
    | "readyUptimeMs"
    | "request"
  >;
  settings: SettingsStore;
  toolkit: Pick<ToolkitManager, "getStatus">;
  updater: Pick<UpdateController, "getState">;
  appFacts: {
    version: string;
    electronVersion: string;
    platform: string;
    arch: string;
    pid: number;
    /** Getters keep uptime/rss live across the app's lifetime (report is on-demand). */
    uptimeMs: () => number;
    memoryRssBytes: () => number;
  };
  now?: () => number;
  /** RPC timeout for the core health snapshot (small: it is a handful of SQL aggregates). */
  coreHealthTimeoutMs?: number;
}

/** Pull the core health snapshot; null = core unreachable / returned garbage. */
export async function fetchCoreSnapshot(
  deps: Pick<DiagnosticsDeps, "supervisor" | "coreHealthTimeoutMs">,
): Promise<CoreHealthSnapshot | null> {
  try {
    const raw = await deps.supervisor.request<unknown>(
      "diagnostics.health",
      {},
      deps.coreHealthTimeoutMs ?? 3_000,
    );
    return DiagnosticsHealthResult.parse(raw).health;
  } catch {
    // Classified degradation: supervision facts above still tell the story.
    return null;
  }
}

/** Assemble the full health report (never throws — every part degrades independently). */
export async function assembleHealthReport(
  deps: DiagnosticsDeps,
): Promise<HealthReportT> {
  const now = deps.now ?? Date.now;
  const snapshot = await fetchCoreSnapshot(deps);
  const files: LogFileInfo[] = deps.logger.listLogFiles();

  const report: HealthReportT = {
    generatedAt: now(),
    app: {
      version: deps.appFacts.version,
      electronVersion: deps.appFacts.electronVersion,
      platform: deps.appFacts.platform,
      arch: deps.appFacts.arch,
      pid: deps.appFacts.pid,
      uptimeMs: deps.appFacts.uptimeMs(),
      memoryRssBytes: deps.appFacts.memoryRssBytes(),
    },
    versions: {
      contract: CONTRACT_VERSION,
      protocol: PROTOCOL_VERSION,
    },
    settings: deps.settings.settings,
    core: {
      supervision: {
        state: deps.supervisor.currentState,
        restarts: deps.supervisor.restarts,
        consecutiveFailures: deps.supervisor.consecutiveFailures,
        lastExit: deps.supervisor.lastExit,
        pid: deps.supervisor.pid,
        uptimeMs: deps.supervisor.readyUptimeMs,
      },
      snapshot,
    },
    toolkit: deps.toolkit.getStatus() as DiagToolkitStatus,
    updater: deps.updater.getState(),
    logs: {
      files,
      totalBytes: files.reduce((acc, f) => acc + f.bytes, 0),
    },
  };
  // Parse-assert the assembled report: a programming error here surfaces immediately in
  // tests instead of shipping a malformed snapshot.
  return HealthReport.parse(report);
}

/** Registry of report entries for the zip: wire names map to absolute paths. */
export async function collectLogEntries(
  logger: Pick<JsonlLogger, "logsDir" | "listLogFiles">,
): Promise<Array<{ entryName: string; absolutePath: string }>> {
  const dir = logger.logsDir;
  if (!dir) return [];
  const entries: Array<{ entryName: string; absolutePath: string }> = [];
  for (const file of logger.listLogFiles()) {
    const absolutePath = join(dir, file.name);
    try {
      const st = await fsStat(absolutePath);
      if (st.isFile()) entries.push({ entryName: `logs/${file.name}`, absolutePath });
    } catch {
      // vanished between listing and stat — export what still exists
    }
  }
  return entries;
}

/**
 * Build the diagnostics zip: every current log file + `health-report.json` (a fresh,
 * timestamped snapshot). Returns the written artifact path + size.
 */
export async function buildDiagnosticsZip(opts: {
  directory: string;
  report: HealthReportT;
  logEntries: Array<{ entryName: string; absolutePath: string }>;
  now?: () => number;
}): Promise<{ path: string; bytes: number }> {
  const dirStat = await fsStat(opts.directory).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new SyntaxDmError("invalid_params", `not a directory: ${opts.directory}`);
  }

  const ts = (opts.now ?? Date.now)();
  const stamp = new Date(ts).toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS UTC
  const zipPath = join(opts.directory, `syntaxdm-diagnostics-${stamp}.zip`);

  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(opts.report, null, 2), "utf8"), "health-report.json");
  for (const entry of opts.logEntries) {
    zip.addFile(entry.absolutePath, entry.entryName);
  }
  zip.end();

  const out = createWriteStream(zipPath);
  zip.outputStream.pipe(out);
  await new Promise<void>((resolve, reject) => {
    out.on("close", resolve);
    out.on("error", reject);
    zip.outputStream.on("error", reject);
  }).catch((err) => {
    throw new SyntaxDmError("io_error", `diagnostics zip write failed: ${String(err)}`);
  });

  const written = await fsStat(zipPath);
  return { path: zipPath, bytes: written.size };
}

/** Registers the three main-served diagnostics methods (contract schemas enforced). */
export function registerDiagnosticsDomain(router: IpcRouter, deps: DiagnosticsDeps): void {
  const entry = (method: keyof typeof METHODS) => {
    const e = METHODS[method];
    return {
      paramsSchema: e.params as NonNullable<typeof e.params>,
      resultSchema: e.result as NonNullable<typeof e.result>,
    };
  };

  router.handle("diagnostics.getHealthReport", {
    ...entry("diagnostics.getHealthReport"),
    handler: async () => ({ report: await assembleHealthReport(deps) }),
  });

  router.handle("diagnostics.getRecentLogs", {
    ...entry("diagnostics.getRecentLogs"),
    handler: async (params) => {
      const { level, limit } = params as { level?: LogLevelT; limit?: number };
      return { records: deps.logger.getRecent({ level, limit }) };
    },
  });

  router.handle("diagnostics.exportLogs", {
    ...entry("diagnostics.exportLogs"),
    handler: async (params) => {
      const { directory } = params as { directory: string };
      const report = await assembleHealthReport(deps);
      const logEntries = await collectLogEntries(deps.logger);
      return buildDiagnosticsZip({ directory, report, logEntries, now: deps.now });
    },
  });
}
