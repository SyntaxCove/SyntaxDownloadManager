import type { UpdateProgress, UpdateState, UpdateStatus, UpdateUnavailableReason } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";

/**
 * Phase 18: auto-update channel — the pure, headless-testable engine.
 *
 * Split (the codebase's port/adapter shape):
 *  - this file: feed resolution (fail-closed), the UpdateController state machine over an
 *    injectable UpdatePort, progress throttling, release-notes sanitization. No Electron,
 *    no electron-updater imports — fully unit-testable.
 *  - `updates-adapter.ts`: the thin electron-updater glue (untested, main-runtime only).
 *
 * Ground rules (plan §Design decisions):
 *  - a check NEVER downloads (consent-gated lifecycle end to end);
 *  - a stale check result must not clobber a downloading/downloaded state;
 *  - install runs the same teardown as a real quit BEFORE the installer spawns
 *    (quitAndInstall may not run `before-quit` on every electron-updater version, and the
 *    Phase 17 close-to-tray handler would otherwise hide instead of closing);
 *  - the renderer sees sanitized state shapes only — never a feed URL, never a path.
 */

/** The main-process surface the adapter implements over electron-updater. */
export interface UpdatePort {
  /** Triggers a feed check; outcomes arrive via the controller's on* callbacks. */
  check(): void;
  /** Starts downloading the found update (electron-updater caches the feed result). */
  download(): void;
  /** Quits the app and spawns the installer (call ONLY after controller teardown). */
  install(): void;
}

/** Why no feed is configured (fail-closed classification, not an error). */
export type ResolvedFeed =
  | { kind: "env"; url: string }
  | { kind: "app-update" }
  | { kind: "none"; reason: UpdateUnavailableReason }
  | { kind: "invalid"; code: "update_feed_invalid"; detail: string };

/**
 * Resolve the update feed. Precedence: env override (must parse as an https URL) →
 * packaged resources/app-update.yml (electron-builder, Phase 19) → none. Unpackaged runs
 * report `not_packaged` even with an env URL set (the dev shell must never self-update —
 * an installer over a dev checkout would destroy the workspace).
 */
export function resolveUpdateFeed(opts: {
  isPackaged: boolean;
  envFeedUrl: string | undefined | null;
  resourcesAppUpdateYmlExists: boolean;
}): ResolvedFeed {
  if (!opts.isPackaged) {
    return { kind: "none", reason: "not_packaged" };
  }
  const env = opts.envFeedUrl?.trim() ?? "";
  if (env) {
    if (!/^https:\/\//i.test(env)) {
      return {
        kind: "invalid",
        code: "update_feed_invalid",
        detail: "SYNTAXDM_UPDATE_FEED_URL must be an https URL",
      };
    }
    try {
      const parsed = new URL(env);
      // A URL that only parsed because the https prefix was forced (spaces, control
      // chars) is still not a feed — require a hostname as the honest bar.
      if (!parsed.hostname) throw new Error("missing hostname");
      return { kind: "env", url: parsed.toString() };
    } catch {
      return {
        kind: "invalid",
        code: "update_feed_invalid",
        detail: "SYNTAXDM_UPDATE_FEED_URL is not a valid URL",
      };
    }
  }
  if (opts.resourcesAppUpdateYmlExists) {
    return { kind: "app-update" };
  }
  return { kind: "none", reason: "no_feed" };
}

/** Cap release notes; electron-updater may hand over a string or a structured array —
 *  anything but a string is dropped rather than coerced (sanitize, don't guess). */
export function sanitizeReleaseNotes(notes: unknown): string | null {
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  if (!trimmed) return null;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}` : trimmed;
}

export function sanitizeMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
}

export interface UpdateControllerDeps {
  readonly port: UpdatePort;
  readonly feed: ResolvedFeed;
  readonly currentVersion: string;
  /** Full state snapshot sink (router.emit in main; a recorder in tests). */
  readonly emit: (state: UpdateState) => void;
  /**
   * Runs the quit-for-install teardown (quitting flag, tray destroy, supervisor stop)
   * BEFORE port.install() — the controller calls it first, then port.install().
   */
  readonly onQuitForInstall: () => void;
  /** Live settings gate for background checks (read at fire time). */
  readonly autoCheckEnabled: () => boolean;
  /** Injectable clock for lastCheckedAt. */
  readonly now?: () => number;
}

const PROGRESS_THROTTLE_MS = 500;
/** First background check: 2 min after ready (never delay boot for an update check). */
export const AUTO_CHECK_DELAY_MS = 2 * 60 * 1000;
/** Periodic background check cadence. */
export const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * The updater state machine. Inputs (adapter → controller) are the on* callbacks; user
 * actions (renderer → controller via the update.* methods) are check/download/install.
 * Every transition emits the FULL UpdateState snapshot — the renderer store is a mirror.
 */
export class UpdateController {
  private state: UpdateState;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressEmit = 0;
  private stopped = false;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.state = this.initialState();
  }

  private initialState(): UpdateState {
    if (this.deps.feed.kind === "none") {
      return {
        status: "unavailable",
        unavailableReason: this.deps.feed.reason,
        currentVersion: this.deps.currentVersion,
        availableVersion: null,
        releaseDate: null,
        releaseNotes: null,
        progress: null,
        errorCode: null,
        message: null,
        lastCheckedAt: null,
      };
    }
    if (this.deps.feed.kind === "invalid") {
      return {
        status: "error",
        errorCode: this.deps.feed.code,
        message: sanitizeMessage(this.deps.feed.detail),
        unavailableReason: null,
        currentVersion: this.deps.currentVersion,
        availableVersion: null,
        releaseDate: null,
        releaseNotes: null,
        progress: null,
        lastCheckedAt: null,
      };
    }
    return {
      status: "idle",
      unavailableReason: null,
      currentVersion: this.deps.currentVersion,
      availableVersion: null,
      releaseDate: null,
      releaseNotes: null,
      progress: null,
      errorCode: null,
      message: null,
      lastCheckedAt: null,
    };
  }

  /** The previous state is always a FULL snapshot (initialState guarantees it), so a
   *  patch merge can never leave a key undefined. */
  private snapshot(patch: Partial<UpdateState> & { status: UpdateStatus }): UpdateState {
    return { ...this.state, ...patch };
  }

  private setState(patch: Partial<UpdateState> & { status: UpdateStatus }): void {
    this.state = this.snapshot(patch);
    this.deps.emit(this.state);
  }

  getState(): UpdateState {
    return this.state;
  }

  // ---- user actions (renderer consent points) ----

  /** Manual check from the Settings page. Background checks go through runAutoCheck(). */
  check(): { started: boolean } {
    if (this.deps.feed.kind !== "env" && this.deps.feed.kind !== "app-update") {
      // Honest precondition failure: unavailable/invalid state is already the snapshot;
      // re-emit so a fresh renderer learns why nothing happened.
      this.deps.emit(this.state);
      return { started: false };
    }
    if (["checking", "downloading", "installing"].includes(this.state.status)) {
      return { started: false };
    }
    this.setState({ status: "checking" });
    try {
      this.deps.port.check();
    } catch (err) {
      // A synchronous port failure is still a classified check round.
      this.onError("update_check_failed", err);
    }
    return { started: true };
  }

  /** Consent point #2: download a found update. */
  download(): { started: boolean } {
    if (["checking", "downloading", "installing"].includes(this.state.status)) {
      return { started: false };
    }
    if (this.state.status !== "available") {
      this.setState({
        status: "error",
        errorCode: "invalid_state",
        message: "No update is available to download — check for updates first.",
      });
      return { started: false };
    }
    this.setState({ status: "downloading", progress: { percent: 0, transferredBytes: 0, totalBytes: null, bytesPerSecond: 0 } });
    try {
      this.deps.port.download();
    } catch (err) {
      this.onError("update_download_failed", err);
    }
    return { started: true };
  }

  /** Consent point #3: quit + install. Teardown ALWAYS precedes the installer spawn. */
  install(): { accepted: boolean } {
    if (this.state.status !== "downloaded") {
      this.setState({
        status: "error",
        errorCode: "update_not_downloaded",
        message: "No downloaded update to install.",
      });
      return { accepted: false };
    }
    this.setState({ status: "installing" });
    // Same teardown as a real quit (quitting flag + tray destroy + supervisor stop),
    // THEN the installer. The renderer may never see this event over a dying channel —
    // its UI treats the install.accepted response as the terminal signal.
    this.deps.onQuitForInstall();
    try {
      this.deps.port.install();
    } catch (err) {
      this.onError("update_install_failed", err);
    }
    return { accepted: true };
  }

  // ---- adapter inputs (electron-updater events) ----

  onChecking(): void {
    // Only a fresh check opens the checking window (never clobber downloading states).
    if (this.isStaleCheckContext()) return;
    this.setState({ status: "checking" });
  }

  onAvailable(info: { version: string; releaseDate?: unknown; releaseNotes?: unknown }): void {
    if (this.isStaleCheckContext()) return;
    if (!info || typeof info.version !== "string" || !info.version) {
      this.onError("update_check_failed", "feed returned a version-less update entry");
      return;
    }
    if (info.version === this.deps.currentVersion) {
      // Belt & braces: an equal version is NOT an update even if the feed says available.
      this.onNotAvailable();
      return;
    }
    this.setState({
      status: "available",
      availableVersion: info.version,
      releaseDate: typeof info.releaseDate === "string" ? info.releaseDate.slice(0, 64) : null,
      releaseNotes: sanitizeReleaseNotes(info.releaseNotes),
      lastCheckedAt: (this.deps.now ?? Date.now)(),
    });
  }

  onNotAvailable(): void {
    if (this.isStaleCheckContext()) return;
    this.setState({
      status: "not-available",
      availableVersion: null,
      lastCheckedAt: (this.deps.now ?? Date.now)(),
    });
  }

  onProgress(progress: UpdateProgress): void {
    if (this.state.status !== "downloading") return;
    const now = (this.deps.now ?? Date.now)();
    const complete = progress.percent >= 100;
    if (!complete && now - this.lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    this.lastProgressEmit = now;
    this.setState({ status: "downloading", progress });
  }

  onDownloaded(): void {
    if (this.state.status !== "downloading") return;
    // Final snapshot flushes percent 100 regardless of throttle windows.
    const progress = this.state.progress;
    this.setState({
      status: "downloaded",
      progress: progress ? { ...progress, percent: 100 } : null,
    });
  }

  /** Classified failure for the current phase (check / download / install). */
  onError(code: UpdateErrorCode, err: unknown): void {
    const inFlight = this.state.status;
    if (inFlight !== "checking" && inFlight !== "downloading" && inFlight !== "installing") return;
    const message = err instanceof Error ? err.message : sanitizeMessage(String(err)) ?? "";
    this.setState({ status: "error", errorCode: code, message: sanitizeMessage(message) });
  }

  /** Adapter convenience: classify an electron-updater `error` event by current phase. */
  onUpdaterError(err: unknown): void {
    const inFlight = this.state.status;
    const code: UpdateErrorCode =
      inFlight === "downloading"
        ? "update_download_failed"
        : inFlight === "installing"
          ? "update_install_failed"
          : "update_check_failed";
    this.onError(code, err);
  }

  /** A check result is stale when the user already moved on (download consented). */
  private isStaleCheckContext(): boolean {
    return (
      this.state.status === "downloading" ||
      this.state.status === "downloaded" ||
      this.state.status === "installing"
    );
  }

  // ---- background checks ----

  /** Startup + 12 h periodic checks, live-gated on the settings flag. Test-stoppable. */
  startAutoChecks(): void {
    if (this.stopped) return;
    const delay = setTimeout(() => {
      this.runAutoCheck();
      this.intervalTimer = setInterval(() => this.runAutoCheck(), AUTO_CHECK_INTERVAL_MS);
      this.timers.push(this.intervalTimer as unknown as ReturnType<typeof setTimeout>);
    }, AUTO_CHECK_DELAY_MS);
    this.timers.push(delay);
  }

  stopAutoChecks(): void {
    this.stopped = true;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.length = 0;
    this.intervalTimer = null;
  }

  runAutoCheck(): void {
    if (!this.deps.autoCheckEnabled()) return;
    if (this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "downloaded" || this.state.status === "installing") {
      return; // never interrupt an in-flight lifecycle for a background refresh
    }
    if (this.deps.feed.kind !== "env" && this.deps.feed.kind !== "app-update") return;
    this.setState({ status: "checking" });
    try {
      this.deps.port.check();
    } catch (err) {
      this.onError("update_check_failed", err);
    }
  }
}

export type UpdateErrorCode =
  | "update_feed_invalid"
  | "update_check_failed"
  | "update_download_failed"
  | "update_install_failed"
  | "update_not_downloaded";

/**
 * Register the four update.* methods on the renderer router. The controller is fully
 * constructed beforehand (feed resolved, port adapted, emit wired to router.emit in
 * main.ts); this is pure surface glue.
 */
export function registerUpdateDomain(router: IpcRouter, controller: UpdateController): void {
  router.handle("update.getState", {
    handler: async () => ({ state: controller.getState() }),
  });
  router.handle("update.check", {
    handler: async () => controller.check(),
  });
  router.handle("update.download", {
    handler: async () => controller.download(),
  });
  router.handle("update.install", {
    handler: async () => controller.install(),
  });
}
