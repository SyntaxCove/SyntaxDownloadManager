import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateState, makeRequest } from "@syntaxdm/contracts";
import {
  AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  resolveUpdateFeed,
  sanitizeMessage,
  sanitizeReleaseNotes,
  registerUpdateDomain,
  UpdateController,
  type UpdatePort,
} from "../domains/updates.js";
import { IpcRouter } from "../ipc/router.js";

/**
 * Phase 18 — the auto-update engine against a fake port. The electron-updater adapter is
 * main-runtime glue and stays untested; everything that DECIDES lives here: feed
 * resolution (fail-closed), the consent-gated state machine, stale-check protection,
 * progress throttling, install-before-teardown ordering, and the live-gated auto checks.
 */

// ---- harness ----

interface FakePort extends UpdatePort {
  checks: number;
  downloads: number;
  installs: number;
  failCheckWith: Error | null;
  failDownloadWith: Error | null;
}

interface Harness {
  controller: UpdateController;
  port: FakePort;
  emitted: ReturnType<UpdateController["getState"]>[];
  order: string[];
  setAutoCheck: (enabled: boolean) => void;
  now: () => number;
  advanceTime: (ms: number) => void;
}

function make(opts?: {
  feedKind?: "env" | "app-update" | { kind: "none"; reason: "not_packaged" | "no_feed" } | { kind: "invalid"; code: "update_feed_invalid"; detail: string };
  currentVersion?: string;
}): Harness {
  const emitted: UpdateState[] = [];
  const order: string[] = [];
  let autoCheck = true;
  let clock = 1_000_000;
  const port: FakePort = {
    checks: 0,
    downloads: 0,
    installs: 0,
    failCheckWith: null,
    failDownloadWith: null,
    check() {
      this.checks++;
      if (this.failCheckWith) throw this.failCheckWith;
    },
    download() {
      this.downloads++;
      if (this.failDownloadWith) throw this.failDownloadWith;
    },
    install() {
      order.push("port.install");
      this.installs++;
    },
  };
  const fk = opts?.feedKind ?? "env";
  const feed =
    typeof fk === "string"
      ? fk === "env"
        ? ({ kind: "env", url: "https://example.com/updates/" } as const)
        : ({ kind: "app-update" } as const)
      : fk;
  const controller = new UpdateController({
    port,
    feed,
    currentVersion: opts?.currentVersion ?? "0.5.0",
    emit: (state) => {
      // Every emitted snapshot must be contract-valid — this is what crosses IPC.
      const parsed = UpdateState.parse(state);
      emitted.push(parsed);
    },
    onQuitForInstall: () => order.push("teardown"),
    autoCheckEnabled: () => autoCheck,
    now: () => clock,
  });
  return {
    controller,
    port,
    emitted,
    order,
    setAutoCheck: (enabled) => {
      autoCheck = enabled;
    },
    now: () => clock,
    advanceTime: (ms) => {
      clock += ms;
    },
  };
}

// ---- feed resolution ----

describe("resolveUpdateFeed (fail-closed)", () => {
  it("unpackaged runs are not_packaged even with an env URL set (dev never self-updates)", () => {
    const feed = resolveUpdateFeed({
      isPackaged: false,
      envFeedUrl: "https://example.com/updates/",
      resourcesAppUpdateYmlExists: true,
    });
    expect(feed).toEqual({ kind: "none", reason: "not_packaged" });
  });

  it("an https env override wins over app-update.yml", () => {
    const feed = resolveUpdateFeed({
      isPackaged: true,
      envFeedUrl: "https://feed.syntaxdm.app/latest/",
      resourcesAppUpdateYmlExists: true,
    });
    expect(feed).toEqual({ kind: "env", url: "https://feed.syntaxdm.app/latest/" });
  });

  it("an http env override is classified invalid — never a silent direct fallback", () => {
    const feed = resolveUpdateFeed({
      isPackaged: true,
      envFeedUrl: "http://feed.syntaxdm.app/latest/",
      resourcesAppUpdateYmlExists: false,
    });
    expect(feed.kind).toBe("invalid");
    expect(feed.kind === "invalid" && feed.code).toBe("update_feed_invalid");
  });

  it("an unparsable env override is classified invalid", () => {
    const feed = resolveUpdateFeed({
      isPackaged: true,
      envFeedUrl: "not a url at all",
      resourcesAppUpdateYmlExists: false,
    });
    expect(feed.kind).toBe("invalid");
  });

  it("packaged without env uses the electron-builder app-update.yml when present", () => {
    const feed = resolveUpdateFeed({
      isPackaged: true,
      envFeedUrl: undefined,
      resourcesAppUpdateYmlExists: true,
    });
    expect(feed).toEqual({ kind: "app-update" });
  });

  it("packaged with no env and no app-update.yml is honestly no_feed", () => {
    const feed = resolveUpdateFeed({
      isPackaged: true,
      envFeedUrl: null,
      resourcesAppUpdateYmlExists: false,
    });
    expect(feed).toEqual({ kind: "none", reason: "no_feed" });
  });
});

// ---- sanitizers ----

describe("release notes / message sanitization", () => {
  it("strings are trimmed and capped; every other shape is dropped", () => {
    expect(sanitizeReleaseNotes("  hello  ")).toBe("hello");
    expect(sanitizeReleaseNotes("x".repeat(4000))).toHaveLength(4000);
    expect(sanitizeReleaseNotes("x".repeat(5000))).toHaveLength(4000);
    expect(sanitizeReleaseNotes([{ text: "structured" }])).toBeNull();
    expect(sanitizeReleaseNotes(null)).toBeNull();
    expect(sanitizeReleaseNotes("   ")).toBeNull();
  });

  it("messages are capped at 500 and null-safe", () => {
    expect(sanitizeMessage("boom")).toBe("boom");
    expect(sanitizeMessage("x".repeat(600))).toHaveLength(500);
    expect(sanitizeMessage(undefined)).toBeNull();
    expect(sanitizeMessage(42)).toBeNull();
  });
});

// ---- controller state machine ----

describe("UpdateController", () => {
  it("starts unavailable for no-feed installs and never calls the port", () => {
    const h = make({ feedKind: { kind: "none", reason: "no_feed" } });
    expect(h.controller.getState().status).toBe("unavailable");
    expect(h.controller.getState().unavailableReason).toBe("no_feed");
    expect(h.port.checks).toBe(0);
  });

  it("starts unavailable with not_packaged taking precedence", () => {
    const h = make({ feedKind: { kind: "none", reason: "not_packaged" } });
    expect(h.controller.getState().unavailableReason).toBe("not_packaged");
  });

  it("an invalid feed is an honest error state with the classified code", () => {
    const h = make({
      feedKind: { kind: "invalid", code: "update_feed_invalid", detail: "SYNTAXDM_UPDATE_FEED_URL must be an https URL" },
    });
    expect(h.controller.getState().status).toBe("error");
    expect(h.controller.getState().errorCode).toBe("update_feed_invalid");
    expect(h.controller.getState().message).toContain("https");
  });

  it("manual check on a no-feed install is rejected and re-emits the reason", () => {
    const h = make({ feedKind: { kind: "none", reason: "no_feed" } });
    const before = h.emitted.length;
    expect(h.controller.check().started).toBe(false);
    expect(h.emitted.length).toBe(before + 1); // re-emit so a fresh renderer learns why
    expect(h.port.checks).toBe(0);
  });

  it("happy path: check → available with sanitized metadata and lastCheckedAt", () => {
    const h = make();
    h.advanceTime(500);
    expect(h.controller.check()).toEqual({ started: true });
    expect(h.controller.getState().status).toBe("checking");
    expect(h.port.checks).toBe(1);
    h.controller.onAvailable({
      version: "0.6.0",
      releaseDate: "2026-10-14T00:00:00.000Z",
      releaseNotes: "  fixed things  ",
    });
    const s = h.controller.getState();
    expect(s.status).toBe("available");
    expect(s.availableVersion).toBe("0.6.0");
    expect(s.releaseNotes).toBe("fixed things");
    expect(s.lastCheckedAt).toBe(1_000_500);
    expect(s.errorCode).toBeNull();
  });

  it("an equal version is NOT an update (belt & braces against feed drift)", () => {
    const h = make({ currentVersion: "0.6.0" });
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    expect(h.controller.getState().status).toBe("not-available");
    expect(h.controller.getState().lastCheckedAt).toBe(1_000_000);
  });

  it("check → not-available records the round", () => {
    const h = make();
    h.controller.check();
    h.controller.onNotAvailable();
    expect(h.controller.getState().status).toBe("not-available");
    expect(h.controller.getState().lastCheckedAt).toBe(1_000_000);
  });

  it("a version-less available entry is a classified check failure", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "" });
    expect(h.controller.getState().status).toBe("error");
    expect(h.controller.getState().errorCode).toBe("update_check_failed");
  });

  it("check re-entry while checking is rejected without touching the port", () => {
    const h = make();
    expect(h.controller.check().started).toBe(true);
    expect(h.controller.check().started).toBe(false);
    expect(h.port.checks).toBe(1);
  });

  it("download is consent-gated on available; from idle it is invalid_state", () => {
    const h = make();
    expect(h.controller.download()).toEqual({ started: false });
    expect(h.controller.getState().status).toBe("error");
    expect(h.controller.getState().errorCode).toBe("invalid_state");
    expect(h.port.downloads).toBe(0);
  });

  it("download from available starts the transfer with zeroed progress; re-entry rejected", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    expect(h.controller.download()).toEqual({ started: true });
    expect(h.controller.getState().status).toBe("downloading");
    expect(h.controller.getState().progress?.percent).toBe(0);
    expect(h.port.downloads).toBe(1);
    expect(h.controller.download()).toEqual({ started: false });
    expect(h.port.downloads).toBe(1);
  });

  it("a sync port failure during download is classified update_download_failed", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.port.failDownloadWith = new Error("disk exploded");
    expect(h.controller.download()).toEqual({ started: true });
    expect(h.controller.getState().status).toBe("error");
    expect(h.controller.getState().errorCode).toBe("update_download_failed");
    expect(h.controller.getState().message).toBe("disk exploded");
  });

  it("progress is throttled to a 500 ms floor and flushed at 100 on downloaded", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.controller.download();
    const base = h.emitted.length;
    h.advanceTime(0);
    h.controller.onProgress({ percent: 10, transferredBytes: 1, totalBytes: 10, bytesPerSecond: 5 });
    expect(h.emitted.length).toBe(base + 1);
    h.advanceTime(300);
    h.controller.onProgress({ percent: 20, transferredBytes: 2, totalBytes: 10, bytesPerSecond: 5 });
    expect(h.emitted.length).toBe(base + 1); // suppressed inside the window
    h.advanceTime(300); // now 600 ms past the last emit
    h.controller.onProgress({ percent: 30, transferredBytes: 3, totalBytes: 10, bytesPerSecond: 5 });
    expect(h.emitted.length).toBe(base + 2);
    expect(h.controller.getState().progress?.percent).toBe(30);
    h.controller.onDownloaded();
    expect(h.controller.getState().status).toBe("downloaded");
    expect(h.controller.getState().progress?.percent).toBe(100);
  });

  it("onDownloaded outside a download window is ignored (no fabricated state)", () => {
    const h = make();
    const before = h.emitted.length;
    h.controller.onDownloaded();
    expect(h.emitted.length).toBe(before);
    expect(h.controller.getState().status).toBe("idle");
  });

  it("a stale check result never clobbers downloading/downloaded/installing", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.controller.download();
    h.controller.onDownloaded();
    const before = h.emitted.length;
    h.controller.onAvailable({ version: "0.7.0" });
    h.controller.onNotAvailable();
    h.controller.onChecking();
    expect(h.emitted.length).toBe(before);
    expect(h.controller.getState().status).toBe("downloaded");
    expect(h.controller.getState().availableVersion).toBe("0.6.0");
  });

  it("install is consent-gated on downloaded; from idle it fails with update_not_downloaded", () => {
    const h = make();
    expect(h.controller.install()).toEqual({ accepted: false });
    expect(h.controller.getState().errorCode).toBe("update_not_downloaded");
    expect(h.order).toEqual([]); // teardown must NOT run for a rejected install
    expect(h.port.installs).toBe(0);
  });

  it("install runs the quit teardown BEFORE the installer spawns (trap-closing order)", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.controller.download();
    h.controller.onDownloaded();
    expect(h.controller.install()).toEqual({ accepted: true });
    // The ONE pinned ordering: quit teardown strictly precedes the installer spawn.
    expect(h.order).toEqual(["teardown", "port.install"]);
    expect(h.controller.getState().status).toBe("installing");
  });

  it("no new lifecycle starts while installing (check/download are dead ends there)", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.controller.download();
    h.controller.onDownloaded();
    h.controller.install();
    const before = h.emitted.length;
    expect(h.controller.check()).toEqual({ started: false });
    expect(h.controller.download()).toEqual({ started: false });
    expect(h.port.checks).toBe(1);
    expect(h.port.downloads).toBe(1);
    expect(h.emitted.length).toBe(before); // no state churn mid-teardown
  });

  it("onUpdaterError classifies by phase and ignores out-of-phase errors", () => {
    const h = make();
    h.controller.onUpdaterError(new Error("idle noise"));
    expect(h.controller.getState().status).toBe("idle");

    h.controller.check();
    h.controller.onUpdaterError(new Error("feed unreachable"));
    expect(h.controller.getState().errorCode).toBe("update_check_failed");
    expect(h.controller.getState().message).toBe("feed unreachable");

    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.controller.download();
    h.controller.onUpdaterError(new Error("dropped mid-transfer"));
    expect(h.controller.getState().errorCode).toBe("update_download_failed");
  });

  it("every emitted snapshot is contract-valid (the router would drop anything else)", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0", releaseNotes: "notes" });
    h.controller.download();
    h.controller.onProgress({ percent: 42, transferredBytes: 4, totalBytes: 10, bytesPerSecond: 1 });
    h.controller.onDownloaded();
    expect(h.emitted.length).toBeGreaterThanOrEqual(5);
    for (const s of h.emitted) {
      expect(() => UpdateState.parse(s)).not.toThrow();
    }
  });
});

// ---- auto checks ----

describe("background auto checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires 2 minutes after startup, then every 12 hours (live-gated)", () => {
    const h = make();
    h.controller.startAutoChecks();
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS - 1);
    expect(h.port.checks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.port.checks).toBe(1);
    expect(h.controller.getState().status).toBe("checking");
    h.controller.onNotAvailable(); // close the round; the fake port drives no events
    vi.advanceTimersByTime(AUTO_CHECK_INTERVAL_MS - 1);
    expect(h.port.checks).toBe(1);
    vi.advanceTimersByTime(1);
    expect(h.port.checks).toBe(2);
  });

  it("a disabled settings gate suppresses the rounds without unregistering them", () => {
    const h = make();
    h.controller.startAutoChecks();
    h.setAutoCheck(false);
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS * 2);
    expect(h.port.checks).toBe(0);
    h.setAutoCheck(true);
    vi.advanceTimersByTime(AUTO_CHECK_INTERVAL_MS);
    expect(h.port.checks).toBe(1);
  });

  it("stopAutoChecks kills the timers (before-quit hygiene)", () => {
    const h = make();
    h.controller.startAutoChecks();
    h.controller.stopAutoChecks();
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS * 3);
    expect(h.port.checks).toBe(0);
  });

  it("background checks never interrupt an in-flight lifecycle", () => {
    const h = make();
    h.controller.check();
    h.controller.onAvailable({ version: "0.6.0" });
    h.controller.download();
    h.controller.startAutoChecks();
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(h.port.checks).toBe(1); // only the manual check round; downloads are untouched
    expect(h.controller.getState().status).toBe("downloading");
  });

  it("background checks skip no-feed installs", () => {
    const h = make({ feedKind: { kind: "none", reason: "no_feed" } });
    h.controller.startAutoChecks();
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(h.port.checks).toBe(0);
  });
});

// ---- method surface ----

describe("registerUpdateDomain", () => {
  it("registers the four main-served methods; getState mirrors the snapshot", async () => {
    const h = make();
    const router = new IpcRouter();
    registerUpdateDomain(router, h.controller);
    for (const m of ["update.getState", "update.check", "update.download", "update.install"]) {
      expect(router.has(m)).toBe(true);
    }
    const res = await router.handleRequest(makeRequest("1", "update.getState", {}), {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { state: { status: string } }).state.status).toBe("idle");
    }
    const started = await router.handleRequest(makeRequest("2", "update.check", {}), {});
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect((started.result as { started: boolean }).started).toBe(true);
      expect(h.port.checks).toBe(1);
    }
  });
});
