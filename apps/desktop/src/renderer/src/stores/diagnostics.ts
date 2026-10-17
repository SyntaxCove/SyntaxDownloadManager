import { create } from "zustand";
import type { HealthReport, LogRecord, LogLevel } from "@syntaxdm/contracts";
import { rpc } from "../bridge.js";
import { publishToast } from "../app/toasts.js";
import { describeError } from "./settings.js";

/**
 * Diagnostics store (Phase 20) — health report + log tail mirror. Both reads are
 * main-served snapshots pulled on demand (page mount, manual refresh, bounded auto
 * refresh); there are no push events for diagnostics — a per-line firehose over IPC is
 * noise, not signal. Export is a consent flow: app.pickDirectory → diagnostics.exportLogs.
 */

interface DiagnosticsStoreState {
  report: HealthReport | null;
  records: LogRecord[];
  levelFilter: LogLevel | undefined;
  loading: boolean;
  loaded: boolean;
  exporting: boolean;
  /** Absolute path of the last written export zip (user's chosen destination). */
  lastExportPath: string | null;
  error: string | null;
  loadReport: () => Promise<void>;
  loadLogs: () => Promise<void>;
  setLevelFilter: (level: LogLevel | undefined) => void;
  exportLogs: () => Promise<void>;
}

export const useDiagnosticsStore = create<DiagnosticsStoreState>((set, get) => ({
  report: null,
  records: [],
  levelFilter: undefined,
  loading: false,
  loaded: false,
  exporting: false,
  lastExportPath: null,
  error: null,

  loadReport: async () => {
    set({ loading: true });
    try {
      const { report } = await rpc("diagnostics.getHealthReport", {});
      set({ report, loaded: true, error: null });
    } catch (err) {
      set({ error: describeError(err) });
    } finally {
      set({ loading: false });
    }
  },

  loadLogs: async () => {
    const { levelFilter } = get();
    try {
      const { records } = await rpc("diagnostics.getRecentLogs", {
        ...(levelFilter ? { level: levelFilter } : {}),
        limit: 200,
      });
      set({ records, error: null });
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  setLevelFilter: (level) => {
    set({ levelFilter: level });
    void get().loadLogs();
  },

  exportLogs: async () => {
    set({ exporting: true });
    try {
      const { path } = (await rpc("app.pickDirectory", {})) as { path: string | null };
      if (!path) return; // user canceled the picker — not an error
      const result = (await rpc("diagnostics.exportLogs", { directory: path })) as {
        path: string;
        bytes: number;
      };
      set({ lastExportPath: result.path });
      publishToast({
        title: "Diagnostics exported",
        body: result.path,
        intent: "success",
      });
    } catch (err) {
      publishToast({
        title: "Export failed",
        body: describeError(err),
        intent: "error",
      });
    } finally {
      set({ exporting: false });
    }
  },
}));
