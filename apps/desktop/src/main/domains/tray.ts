import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 17: tray integration. A persistent tray icon with a context menu (Open /
 * Start all / Pause all / live counts / Quit) and close-to-tray semantics: closing the
 * shell window hides it and keeps downloads running.
 *
 * Ground rules:
 *  - every Electron touchpoint sits behind `TrayPort` so the decision logic is
 *    headless-testable;
 *  - close-to-tray is effective ONLY while a tray icon actually exists — if tray
 *    creation failed (headless dev, missing Linux indicator host), closing keeps the
 *    Phase 2 quit behavior (an app that vanishes with no tray icon would strand the
 *    engine and the user's only way back in);
 *  - tray actions are best-effort: `startAll`/`pauseAll` go straight to the same core
 *    methods the UI uses; a classified failure (core restarting) is ignored — the tray
 *    counts heal from the next event.
 */

/** Pure decision: should this window `close` be turned into hide-to-tray? */
export function shouldHideOnClose(
  closeToTray: boolean,
  trayReady: boolean,
  quitting: boolean,
): boolean {
  return closeToTray && trayReady && !quitting;
}

export type TrayAction = "open" | "startAll" | "pauseAll" | "quit";

/** Menu model — pure data; the Electron adapter maps it to `MenuItem`s. */
export interface TrayMenuItem {
  readonly id: TrayAction | null;
  /** null id = an informational (disabled) line, e.g. "2 active · 1 queued". */
  readonly label: string;
  readonly enabled: boolean;
}

export interface QueueCounts {
  readonly active: number;
  readonly queued: number;
}

export function buildTrayTooltip(counts: QueueCounts): string {
  return `Syntax Download Manager — ${counts.active} active · ${counts.queued} queued`;
}

export function buildTrayMenuModel(counts: QueueCounts): TrayMenuItem[] {
  return [
    { id: "open", label: "Open Syntax Download Manager", enabled: true },
    { id: null, label: buildTrayTooltip(counts), enabled: false },
    { id: "startAll", label: "Start all downloads", enabled: counts.queued > 0 },
    { id: "pauseAll", label: "Pause all downloads", enabled: counts.active > 0 },
    { id: "quit", label: "Quit Syntax Download Manager", enabled: true },
  ];
}

/** Counts for the tray, projected from validated download job snapshots. */
export function countsFromStatuses(
  statuses: ReadonlyArray<{ status?: string } | undefined>,
): QueueCounts {
  let active = 0;
  let queued = 0;
  for (const j of statuses) {
    if (j?.status === "probing" || j?.status === "downloading") active += 1;
    else if (j?.status === "queued") queued += 1;
  }
  return { active, queued };
}

export interface TrayPort {
  setTooltip(text: string): void;
  setContextMenu(items: ReadonlyArray<TrayMenuItem>, onAction: (a: TrayAction) => void): void;
  onClick(cb: () => void): void;
  destroy(): void;
}

export interface TrayControllerDeps {
  readonly port: TrayPort;
  /** Tray actions dispatch straight to the core (same methods the UI calls). */
  readonly supervisor: Pick<CoreSupervisor, "request">;
  /** Open: show + focus the shell window. */
  readonly onOpen: () => void;
  /** Quit: flip the quitting flag, then `app.quit()`. */
  readonly onQuit: () => void;
}

/**
 * Owns the tray presentation: count updates (throttled to one menu rebuild per second —
 * the download engine emits ~500 ms progress events), tooltip text and action dispatch.
 * A live controller implies a live tray: the Electron wiring only constructs one after
 * the native Tray was created successfully, so `ready` is fixed at construction.
 */
export class TrayController {
  private counts: QueueCounts = { active: 0, queued: 0 };
  private lastPush = 0;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _ready = true;

  constructor(private readonly deps: TrayControllerDeps) {
    this.deps.port.onClick(() => this.deps.onOpen());
    this.push(true);
  }

  /** Whether the tray surface is live (close-to-tray keys off this). */
  get ready(): boolean {
    return this._ready;
  }

  /** Feed a fresh active/queued projection (already computed by the caller). */
  updateCounts(counts: QueueCounts): void {
    if (counts.active === this.counts.active && counts.queued === this.counts.queued) return;
    this.counts = counts;
    this.push();
  }

  private push(immediate = false): void {
    const now = Date.now();
    if (!immediate && now - this.lastPush < 1_000) {
      if (this.pushTimer === null) {
        this.pushTimer = setTimeout(() => {
          this.pushTimer = null;
          this.push(true);
        }, 1_000 - (now - this.lastPush));
      }
      return;
    }
    this.lastPush = Date.now();
    try {
      this.deps.port.setTooltip(buildTrayTooltip(this.counts));
      this.deps.port.setContextMenu(buildTrayMenuModel(this.counts), (a) => this.run(a));
    } catch {
      // A failed tray update must never take the app down; the next event retries.
    }
  }

  /** Dispatch one menu action (also the seam the click handler uses). */
  run(action: TrayAction): void {
    switch (action) {
      case "startAll":
        void this.deps.supervisor.request("download.startAll", {}).catch(() => undefined);
        break;
      case "pauseAll":
        void this.deps.supervisor.request("download.pauseAll", {}).catch(() => undefined);
        break;
      case "open":
        this.deps.onOpen();
        break;
      case "quit":
        this.deps.onQuit();
        break;
    }
  }

  destroy(): void {
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    try {
      this.deps.port.destroy();
    } catch {
      // best-effort teardown
    }
  }
}
