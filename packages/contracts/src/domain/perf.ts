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
 *    assertions; pass/fail against budgets is a build-gate concern (scripts/perf-budgets.json),
 *    not a runtime verdict.
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

// ---- main-served method ----

export const PerfGetSnapshotParams = z.object({});
export const PerfGetSnapshotResult = z.object({ snapshot: PerformanceSnapshot });
