import { z } from "zod";

/**
 * Performance domain (Phase 22, v1.15): startup timing, memory, IPC counters.
 *
 * Posture:
 *  - MAIN-SERVED only (`perf.getSnapshot`). The core knows nothing about budgets —
 *    dc-protocol mirrors the contract version constant but adds no Rust surface here
 *    (same precedent as the v1.13.0 update domain).
 *  - Every core-derived number is nullable: until the first `core.ready` transition the
 *    supervisor cannot report spawn→ready latency or child RSS, and the snapshot must
 *    still be valid (diagnostics-style graceful degradation — a perf surface that throws
 *    is worthless).
 *  - Numbers describe THIS device's last completed boot. They are measurements, never
 *    assertions; pass/fail against budgets is a build-gate concern (apps/desktop/resources/perf-budgets.json)
 *    — and, since v1.16 (Phase 29), also a real-device concern via the typed budget report.
 */

/** The five boot phases instrumented in the Electron main process (boot-clock.ts). */
export const BootPhase = z.enum([
  /** Earliest observable main-process point: core modules of the entry module evaluated. */
  "main-modules-evaluated",
  /** Electron `whenReady()` began. */
  "app-ready",
  /** The shell BrowserWindow was constructed. */
  "window-created",
  /** The Rust core subprocess was spawned. */
  "core-spawned",
  /** First `core.ready` transition observed by the supervisor. */
  "core-ready",
]);
export type BootPhase = z.infer<typeof BootPhase>;

export const BootPhaseTiming = z.object({
  phase: BootPhase,
  /** Wall-clock ms from the previous phase (or process start for the first). */
  durationMs: z.number().nonnegative(),
});
export type BootPhaseTiming = z.infer<typeof BootPhaseTiming>;

export const BootTimingReport = z.object({
  /** One entry per marked phase, in phase order. Unmarked phases are absent. */
  phases: z.array(BootPhaseTiming),
  /** ms from process start to `core-ready` (null until that mark exists). */
  totalToCoreReadyMs: z.number().nonnegative().nullable(),
  /**
   * ms from `core-spawned` to `core-ready` — the core's cold-start latency as observed
   * by the supervisor. Null until both marks exist.
   */
  coreSpawnToReadyMs: z.number().nonnegative().nullable(),
  /** Epoch ms the report was assembled. */
  recordedAt: z.number().int().nonnegative(),
});
export type BootTimingReport = z.infer<typeof BootTimingReport>;

/** Monotonic per-session IPC counters (integer increments only — no hot-path timing). */
export const IpcCounters = z.object({
  /** Parsed request envelopes dispatched (success and error outcomes both count). */
  requestsServed: z.number().int().nonnegative(),
  /** Event envelopes that passed validation and reached every listener. */
  eventsEmitted: z.number().int().nonnegative(),
  /** Requests dropped for a malformed envelope (before method lookup). */
  invalidDropped: z.number().int().nonnegative(),
});
export type IpcCounters = z.infer<typeof IpcCounters>;

export const PerformanceSnapshot = z.object({
  boot: BootTimingReport,
  ipc: IpcCounters,
  /** Main-process RSS at sampling time (process.memoryUsage().rss). */
  mainRssBytes: z.number().int().nonnegative(),
  /**
   * Core subprocess RSS at sampling time. Null on platforms without sampling support
   * (non-unix) or while the core is not running.
   */
  coreRssBytes: z.number().int().nonnegative().nullable(),
  /** Epoch ms of assembly. */
  sampledAt: z.number().int().nonnegative(),
});
export type PerformanceSnapshot = z.infer<typeof PerformanceSnapshot>;

// ---- v1.16 (Phase 29): the real-device budget report harness ----
//
// Posture carried over from v1.15 and extended:
//  - MAIN-SERVED only (`perf.probe`, `perf.runReport`). The core knows nothing about
//    budgets — dc-protocol mirrors the contract version constant but adds no Rust surface
//    here (same precedent as the v1.13.0 update domain and v1.15.0 snapshot).
//  - The report is assembled from independently-degrading producers; a producer that cannot
//    measure reports `skipped` with a reason instead of inventing a number.
//  - The wire type CANNOT LIE: BudgetMeasurement's superRefine enforces the arithmetic
//    (skipped ⇔ actual null; pass ⇔ actual ≤ budget; breach ⇔ actual > budget), and
//    BudgetReport enforces exactly one measurement per BudgetId and a summary whose parts
//    sum to the total with a verdict implied by the breach count. A report that parses is
//    an internally consistent report.

/** Every budget shipped in apps/desktop/resources/perf-budgets.json (closed list). */
export const BudgetId = z.enum([
  "core.coldStartReadyMs",
  "core.rssAfterReadyKb",
  "core.echoAvgUs",
  "renderer.maxTotalJsBytes",
  "renderer.maxLargestChunkBytes",
  "renderer.maxTotalCssBytes",
  "ts.ipcDispatch2000Ms",
  "ts.uiStoreHotPathMs",
  "ts.uiQueueSortMs",
]);
export type BudgetId = z.infer<typeof BudgetId>;

/** Measurement unit of a budget — the budget and the actual are always in the SAME unit. */
export const BudgetUnit = z.enum(["ms", "us", "bytes", "kb"]);
export type BudgetUnit = z.infer<typeof BudgetUnit>;

export const BudgetVerdict = z.enum(["pass", "breach", "skipped"]);
export type BudgetVerdict = z.infer<typeof BudgetVerdict>;

/** Where a report was assembled: a packaged install, a dev checkout run, or the E2E harness. */
export const BudgetReportSource = z.enum(["packaged-app", "dev", "headless-test"]);
export type BudgetReportSource = z.infer<typeof BudgetReportSource>;

export const BudgetMeasurement = z
  .object({
    id: BudgetId,
    /** Ceiling from the budgets file, in `unit`. Always present — skipped says WHY, not "no budget". */
    budget: z.number().int().positive(),
    /** Measured value in `unit`; null exactly when verdict is "skipped". */
    actual: z.number().nonnegative().nullable(),
    unit: BudgetUnit,
    verdict: BudgetVerdict,
    /** Human-readable provenance: what was measured, or why the producer skipped. */
    detail: z.string().min(1),
  })
  .superRefine((m, ctx) => {
    if (m.verdict === "skipped") {
      if (m.actual !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actual"], message: "skipped measurement must carry a null actual" });
      }
      return;
    }
    if (m.actual === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actual"], message: "pass/breach verdict requires a measured actual" });
      return;
    }
    if (m.verdict === "pass" && m.actual > m.budget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "actual above budget cannot be a pass" });
    }
    if (m.verdict === "breach" && m.actual <= m.budget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "actual at/below budget cannot be a breach" });
    }
  });
export type BudgetMeasurement = z.infer<typeof BudgetMeasurement>;

export const BudgetReportSummary = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    breached: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .superRefine((s, ctx) => {
    if (s.passed + s.breached + s.skipped !== s.total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "summary parts must sum to total" });
    }
  });
export type BudgetReportSummary = z.infer<typeof BudgetReportSummary>;

export const BudgetReport = z
  .object({
    /** Report wire shape version — bump on any shape change, independent of the contract minor. */
    reportVersion: z.literal(1),
    generatedAt: z.number().int().nonnegative(),
    appVersion: z.string().min(1),
    contractVersion: z.string().min(1),
    platform: z.string().min(1),
    osRelease: z.string().min(1),
    source: BudgetReportSource,
    /** Exactly one measurement per BudgetId (enforced below). */
    measurements: z.array(BudgetMeasurement),
    summary: BudgetReportSummary,
    /** healthy ⇔ zero breaches (enforced below). Skips never fail a report — they are listed. */
    verdict: z.enum(["healthy", "breached"]),
  })
  .superRefine((r, ctx) => {
    const ids = r.measurements.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurements"], message: "duplicate budget ids in report" });
    }
    for (const id of BudgetId.options) {
      if (!ids.includes(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurements"], message: `missing measurement for ${id}` });
      }
    }
    if (r.summary.total !== r.measurements.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "summary.total must equal the measurement count" });
    }
    const breached = r.measurements.filter((m) => m.verdict === "breach").length;
    const passed = r.measurements.filter((m) => m.verdict === "pass").length;
    const skipped = r.measurements.filter((m) => m.verdict === "skipped").length;
    if (r.summary.breached !== breached || r.summary.passed !== passed || r.summary.skipped !== skipped) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "summary counts do not match the measurements" });
    }
    const expectedVerdict = breached > 0 ? "breached" : "healthy";
    if (r.verdict !== expectedVerdict) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: `verdict must be "${expectedVerdict}" for this breach count` });
    }
  });
export type BudgetReport = z.infer<typeof BudgetReport>;

/**
 * The three renderer-side numbers the RENDERER must measure about itself (the main process
 * cannot see renderer dispatch wall-clock or store work). Produced by the Diagnostics page's
 * bench helpers; omitted ⇒ those budgets report skipped. Bounded at one hour so a broken
 * producer cannot ship absurd wire values.
 */
export const RendererMeasurements = z.object({
  ipcDispatch2000Ms: z.number().nonnegative().finite().max(3_600_000),
  uiStoreHotPathMs: z.number().nonnegative().finite().max(3_600_000),
  uiQueueSortMs: z.number().nonnegative().finite().max(3_600_000),
});
export type RendererMeasurements = z.infer<typeof RendererMeasurements>;

// ---- main-served methods ----

export const PerfGetSnapshotParams = z.object({});
export const PerfGetSnapshotResult = z.object({ snapshot: PerformanceSnapshot });

/** Phase 29: the fixed tiny round-trip the renderer's dispatch bench hammers. */
export const PerfProbeParams = z.object({});
export const PerfProbeResult = z.object({ pong: z.literal(true) });

export const PerfRunReportParams = z.object({
  /** Renderer-side measurements; absent ⇒ the ts.* budgets report skipped. */
  renderer: RendererMeasurements.optional(),
});
export const PerfRunReportResult = z.object({ report: BudgetReport });
