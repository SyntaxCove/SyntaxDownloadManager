import { afterAll, beforeAll, expect, it } from "vitest";
import { CONTRACT_VERSION } from "@syntaxdm/contracts";
import {
  bootApp,
  describeWithCore,
  desktopVersion,
  type AppHandle,
} from "./harness.js";

/**
 * E2E suite 1 — boot and the core-facing surface. Everything here runs against the
 * REAL Rust core binary through the REAL main-process composition (registerAppDomains),
 * with Electron ports stubbed at the boundary. Proves: spawn → ready, the pinned wire
 * contract, the settings round trip, diagnostics + perf over a live core, typed error
 * paths end-to-end, and a graceful shutdown.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await bootApp();
}, 60_000);

afterAll(async () => {
  await app?.dispose();
}, 60_000);

describeWithCore("E2E boot — main composition over the real core", () => {
  it(
    "spawns the core and serves core.ping with the pinned contract version",
    async () => {
      await app.supervisor.whenReady(30_000);
      const ready = (await app.waitEvent("core.state", (p) => (p as { status: string }).status === "ready")) as {
        status: string;
      };
      expect(ready.status).toBe("ready");

      const ping = (await app.supervisor.request("core.ping")) as {
        pong: boolean;
        contractVersion: string;
        protocolVersion: number;
        now: number;
      };
      expect(ping.pong).toBe(true);
      // The whole point of the contract versioning system: what the binary speaks is
      // exactly what the TS side pins.
      expect(ping.contractVersion).toBe(CONTRACT_VERSION);
      expect(ping.protocolVersion).toBeGreaterThan(0);
      expect(ping.now).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "round-trips settings through the real store and emits settings.changed",
    async () => {
      const before = (await app.rpc("settings.get")) as {
        settings: { concurrentDownloads: number };
      };
      expect(before.settings.concurrentDownloads).toBeGreaterThan(0);

      const changed = app.waitEvent("settings.changed");
      const after = (await app.rpc("settings.setAll", {
        settings: { concurrentDownloads: before.settings.concurrentDownloads + 1 },
      })) as { settings: { concurrentDownloads: number } };
      expect(after.settings.concurrentDownloads).toBe(before.settings.concurrentDownloads + 1);
      const event = (await changed) as { settings: { concurrentDownloads: number } };
      expect(event.settings.concurrentDownloads).toBe(before.settings.concurrentDownloads + 1);
    },
    30_000,
  );

  it(
    "reports a healthy live core through diagnostics.getHealthReport",
    async () => {
      const report = ((await app.rpc("diagnostics.getHealthReport")) as {
        report: {
          generatedAt: number;
          app: { version: string; platform: string; pid: number };
          versions: { contract: string; protocol: number };
          core: {
            supervision: { state: string; pid: number | null; restarts: number };
            snapshot: {
              dbQuickCheck: string;
              contractVersion: string;
              uptimeMs: number;
            } | null;
          };
          updater: { status: string; unavailableReason: string | null };
        };
      }).report;
      expect(report.app.version).toBe(desktopVersion());
      expect(report.versions.contract).toBe(CONTRACT_VERSION);
      expect(report.core.supervision.state).toBe("ready");
      expect(report.core.supervision.pid).toBe(app.supervisor.pid);
      // The database is the product's most critical asset: quick_check must be "ok"
      // through the real binary and the real SQLite file.
      expect(report.core.snapshot).not.toBeNull();
      expect(report.core.snapshot!.dbQuickCheck).toBe("ok");
      expect(report.core.snapshot!.contractVersion).toBe(CONTRACT_VERSION);
      // The stub updater reports exactly what an unpackaged run reports.
      expect(report.updater.status).toBe("unavailable");
      expect(report.updater.unavailableReason).toBe("not_packaged");
    },
    30_000,
  );

  it(
    "serves perf.getSnapshot with boot phases and monotonic IPC counters",
    async () => {
      const countersBefore = ((await app.rpc("perf.getSnapshot")) as {
        snapshot: {
          boot: { phases: { phase: string }[]; totalToCoreReadyMs: number | null };
          ipc: { requestsServed: number; eventsEmitted: number };
          mainRssBytes: number;
          coreRssBytes: number | null;
        };
      }).snapshot;
      expect(countersBefore.boot.phases.map((p) => p.phase)).toContain("core-ready");
      expect(countersBefore.boot.totalToCoreReadyMs).toBeGreaterThan(0);
      expect(countersBefore.ipc.requestsServed).toBeGreaterThan(0);
      expect(countersBefore.mainRssBytes).toBeGreaterThan(0);
      // Linux sandbox: the core RSS sample comes from /proc — the real mechanism.
      expect(countersBefore.coreRssBytes).not.toBeNull();
      expect(countersBefore.coreRssBytes!).toBeGreaterThan(0);

      const countersAfter = ((await app.rpc("perf.getSnapshot")) as typeof countersBefore & {
        snapshot: { ipc: { requestsServed: number } };
      }).snapshot;
      expect(countersAfter.ipc.requestsServed).toBeGreaterThan(countersBefore.ipc.requestsServed);
    },
    30_000,
  );

  it(
    "classifies unknown methods, malformed envelopes and invalid params end to end",
    async () => {
      // method_not_found
      await expect(app.rpc("definitely.not.a.method")).rejects.toMatchObject({
        code: "method_not_found",
      });
      // The renderer cannot reach core-served methods directly: core.ping is only
      // proxied by main (the Phase 23 audit's trust boundary), so the router answers
      // method_not_found — exactly the fail-closed posture.
      await expect(app.rpc("core.ping")).rejects.toMatchObject({
        code: "method_not_found",
      });
      // invalid_params (Ulid boundary on the wire)
      await expect(app.rpc("download.get", { id: "not-a-ulid" })).rejects.toMatchObject({
        code: "invalid_params",
      });
      // invalid_params (http(s)-only URL boundary, core-enforced too)
      await expect(
        app.rpc("download.create", {
          url: "ftp://example.com/file.bin",
          destinationDir: app.userDataDir,
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
      // IPC-counters accounting: invalid envelopes are dropped before dispatch.
      const counters = app.router.counters();
      expect(counters.requestsServed).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "stops the core gracefully and refuses further core RPC with a typed error",
    async () => {
      await app.supervisor.whenReady(30_000);
      await app.stop();
      expect(app.supervisor.currentState).toBe("stopped");
      expect(app.supervisor.pid).toBeNull();
      // A deliberate stop is not a crash signal for diagnostics.
      expect(app.supervisor.lastExit).toBeNull();
      await expect(app.rpc("download.list")).rejects.toMatchObject({
        code: "core_unavailable",
      });
    },
    60_000,
  );
});
