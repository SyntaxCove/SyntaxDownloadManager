import { create } from "zustand";
import type { BudgetReport, HealthReport, LogRecord, LogLevel, PerformanceSnapshot } from "@syntaxdm/contracts";
import { rpc } from "../bridge.js";
import { publishToast } from "../app/toasts.js";
import { currentT } from "../i18n/context.js";
import { benchIpcDispatch, benchQueueSort, benchStoreHotPath } from "../perf/benches.js";
import { describeError } from "./settings.js";

/**
 * Diagnostics store (Phase 20) — health report + log tail mirror. Both reads are
 * main-served snapshots pulled on demand (page mount, manual refresh, bounded auto
 * refresh); there are no push events for diagnostics — a per-line firehose over IPC is
 * noise, not signal. Export is a consent flow: app.pickDirectory → diagnostics.exportLogs.
 * Phase 22 adds the performance snapshot (boot timings, memory, IPC counters) on the
 * same pull model. Phase 29 adds the budget report: the RENDERER measures its own
 * benches first (real bridge dispatch, throwaway store hot path, queue sort), hands the
 * numbers to `perf.runReport`, and main assembles the typed verdict.
 */

interface DiagnosticsStoreState {
  report: HealthReport | null;
  perf: PerformanceSnapshot | null;
  records: LogRecord[];
  levelFilter: LogLevel | undefined;
  loading: boolean;
  loaded: boolean;
  exporting: boolean;
  /** Absolute path of the last written export zip (user's chosen destination). */
  lastExportPath: string | null;
  error: string | null;
  loadReport: () => Promise<void>;
  loadPerf: () => Promise<void>;
  loadLogs: () => Promise<void>;
  setLevelFilter: (level: LogLevel | undefined) => void;
  exportLogs: () => Promise<void>;
  /** Phase 29: run the renderer benches + assemble the budget report (single result kept). */
  budgetReport: BudgetReport | null;
  budgetRunning: boolean;
  budgetError: string | null;
  runBudgetReport: () => Promise<void>;
}

export const useDiagnosticsStore = create<DiagnosticsStoreState>((set, get) => ({
  report: null,
  perf: null,
  records: [],
  levelFilter: undefined,
  loading: false,
  loaded: false,
  exporting: false,
  lastExportPath: null,
  error: null,
  budgetReport: null,
  budgetRunning: false,
  budgetError: null,

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

  loadPerf: async () => {
    try {
      const { snapshot } = await rpc("perf.getSnapshot", {});
      set({ perf: snapshot, error: null });
    } catch (err) {
      set({ error: describeError(err) });
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

  runBudgetReport: async () => {
    if (get().budgetRunning) return;
    set({ budgetRunning: true, budgetError: null });
    try {
      // Renderer-side benches first — these are the only budgets the renderer can
      // measure about itself; absent numbers would render those rows skipped.
      const ipcDispatch2000Ms = await benchIpcDispatch(rpc);
      const uiStoreHotPathMs = benchStoreHotPath();
      const uiQueueSortMs = benchQueueSort();
      const { report } = await rpc("perf.runReport", {
        renderer: { ipcDispatch2000Ms, uiStoreHotPathMs, uiQueueSortMs },
      });
      set({ budgetReport: report });
    } catch (err) {
      set({ budgetError: describeError(err) });
    } finally {
      set({ budgetRunning: false });
    }
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
      // Phase 27 (F-1): these two titles were the last hardcoded-English user-visible
      // strings from Phase 21 — resolved through the module-level translator like the
      // toasts bus itself does.
      publishToast({
        title: currentT()("diag.toast.exported"),
        body: result.path,
        intent: "success",
      });
    } catch (err) {
      publishToast({
        title: currentT()("diag.toast.exportFailed"),
        body: describeError(err),
        intent: "error",
      });
    } finally {
      set({ exporting: false });
    }
  },
}));
