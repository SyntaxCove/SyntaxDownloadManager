import type { BootPhase } from "@syntaxdm/contracts";
import { BootPhaseTiming, BootTimingReport } from "@syntaxdm/contracts";

/**
 * Phase 22: boot-phase instrumentation for the Electron main process.
 *
 * Five marks, in the order they occur on a real boot:
 *   main-modules-evaluated → app-ready → window-created → core-spawned → core-ready
 *
 * Design constraints:
 *  - Zero behavior change: `mark()` records a timestamp and nothing else. main.ts calls it
 *    at lifecycle points that already exist; nothing is reordered, awaited, or deferred.
 *  - Deterministic and testable: the clock is injected (`nowMs`), so unit tests drive the
 *    exact same state machine the production boot walks.
 *  - The report is assembled from what ACTUALLY happened: phases that were never marked are
 *    absent (never zero-filled), and core-derived totals are null until `core-ready` exists.
 *
 * On a real Windows boot the finished report is logged once through the JsonlLogger
 * (`component: "perf"`), which puts true device numbers into the Phase 20 log pipeline,
 * the diagnostics tail, and every exported diagnostics zip. Sandbox enforcement of these
 * numbers is impossible (no Electron GUI); the enforced budgets live in
 * scripts/perf-budgets.json and cover what this repo CAN measure honestly.
 */

/** The ordered phase list — index IS the expected boot order. */
const PHASE_ORDER: readonly BootPhase[] = [
  "main-modules-evaluated",
  "app-ready",
  "window-created",
  "core-spawned",
  "core-ready",
];

export class BootClock {
  /** Phase → absolute timestamp (ms, same origin as the injected clock). */
  private readonly marks = new Map<BootPhase, number>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {
    this.epochMs = nowMs();
  }

  /** Record a phase mark. Unknown phases are a programming error (the enum is closed). */
  mark(phase: BootPhase): void {
    if (!PHASE_ORDER.includes(phase)) {
      throw new Error(`unknown boot phase: ${phase}`);
    }
    if (this.marks.has(phase)) {
      throw new Error(`boot phase marked twice: ${phase}`);
    }
    this.marks.set(phase, this.nowMs());
  }

  /** True once the core's first ready transition has been marked. */
  get coreReadyMarked(): boolean {
    return this.marks.has("core-ready");
  }

  /**
   * Assemble the boot report. Durations run from the previous marked phase (the first
   * phase measures from construction time — main.ts constructs the clock at module top
   * level, the earliest observable point of the entry module).
   */
  report(): BootTimingReport {
    const phases: BootPhaseTiming[] = [];
    let prev = this.epochMs;
    for (const phase of PHASE_ORDER) {
      const ts = this.marks.get(phase);
      if (ts === undefined) continue;
      phases.push(BootPhaseTiming.parse({ phase, durationMs: Math.max(0, ts - prev) }));
      prev = ts;
    }
    const coreReady = this.marks.get("core-ready");
    const coreSpawned = this.marks.get("core-spawned");
    return BootTimingReport.parse({
      phases,
      totalToCoreReadyMs: coreReady === undefined ? null : Math.max(0, coreReady - this.epochMs),
      coreSpawnToReadyMs:
        coreReady === undefined || coreSpawned === undefined
          ? null
          : Math.max(0, coreReady - coreSpawned),
      recordedAt: this.nowMs(),
    });
  }

  /** Clock epoch at construction — the first phase's duration measures from here. */
  private readonly epochMs: number;
}
