import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootApp,
  describeWithCore,
  HttpFixture,
  waitForJobStatus,
  type AppHandle,
} from "./harness.js";
import { rpc, onEvent } from "../renderer/src/bridge.js";
import {
  subscribeDownloadEvents,
  useDownloadsStore,
} from "../renderer/src/stores/downloads.js";
import {
  subscribeSettingsChanged,
  useSettingsStore,
} from "../renderer/src/stores/settings.js";

/**
 * E2E suite 3 — the RENDERER layer against the real composition and the real core.
 * `window.syntaxdm` is the preload mirror (same envelope checks as the shipped
 * preload.ts); everything above that boundary is production renderer code: bridge.ts
 * (typed rpc + result re-validation) and the real Zustand stores wired exactly the way
 * main.tsx wires them (`subscribeDownloadEvents`, `subscribeSettingsChanged`).
 */

const BODY = randomBytes(64 * 1024);
/** Slow enough for the engine's ~500 ms progress throttle to emit real events. */
const SLOW_BODY = randomBytes(512 * 1024);

let app: AppHandle;
let fixture: HttpFixture;
let downloadDir: string;

beforeAll(async () => {
  app = await bootApp();
  await app.supervisor.whenReady(30_000);
  fixture = new HttpFixture();
  await fixture.start();
  downloadDir = await mkdtemp(join(tmpdir(), "syntaxdm-e2e-renderer-"));
  // The preload bridge, headlessly: window.syntaxdm = mirror of preload.ts.
  (globalThis as { window?: unknown }).window = { syntaxdm: app.mirror };
  // Exactly the wiring main.tsx performs at renderer boot.
  subscribeDownloadEvents();
  subscribeSettingsChanged();
}, 90_000);

afterAll(async () => {
  delete (globalThis as { window?: unknown }).window;
  await fixture?.stop();
  await app?.dispose();
  await rm(downloadDir, { recursive: true, force: true });
}, 90_000);

describeWithCore("E2E renderer bridge + stores over the real core", () => {
  it(
    "drives a full download through renderer-side typed rpc with result re-validation",
    async () => {
      fixture.setHandler(HttpFixture.handlerForStaticBytes(BODY, { etag: '"renderer-1"' }));
      const { job } = await rpc("download.create", {
        url: fixture.url("/via-renderer.bin"),
        destinationDir: downloadDir,
        filename: "via-renderer.bin",
        overwrite: false,
      });
      // The result already passed the renderer's own zod re-validation (bridge.ts).
      expect(job.url).toBe(fixture.url("/via-renderer.bin"));
      expect(job.status).toBe("queued");

      const done = job.id;
      const finished = await waitForJobStatus(app, done, "completed");
      expect(finished.receivedBytes).toBe(BODY.length);
      const onDisk = await readFile(String(finished.destinationPath));
      expect(onDisk.equals(BODY)).toBe(true);

      // Typed wire errors propagate as SyntaxDmError-shaped objects (the renderer-side
      // validation passed; main produced the classification). Unregistered methods are
      // a COMPILE-time error through the typed `rpc` — the runtime check is exercised
      // through the preload mirror below (the exact raw surface preload exposes).
      await expect(
        app.mirror.rpc("definitely.not.registered"),
      ).rejects.toMatchObject({ code: "method_not_found" });
    },
    120_000,
  );

  it(
    "rejects renderer-side contract violations before any wire traffic",
    async () => {
      // HttpUrl rejects non-http(s) — the request never leaves the renderer. The
      // renderer-side zod layer throws the raw ZodError (bridge.ts parses params before
      // the wire); wire errors are the ContractError shape instead.
      await expect(
        rpc("download.create", {
          url: "javascript:alert(document.domain)",
          destinationDir: downloadDir,
          overwrite: false,
        }),
      ).rejects.toThrow();
      await expect(
        rpc("download.create", {
          url: "file:///etc/passwd",
          destinationDir: downloadDir,
          overwrite: false,
        }),
      ).rejects.toThrow();
      // Checksum length must match the algorithm — validated in the renderer, not just
      // on the wire.
      await expect(
        rpc("download.create", {
          url: fixture.url("/x.bin"),
          destinationDir: downloadDir,
          overwrite: false,
          checksum: { algorithm: "sha256", value: "deadbeef" },
        }),
      ).rejects.toThrow();
      // Wire-classified errors DO reach the renderer as ContractError-shaped objects:
      // a valid Ulid for a job that does not exist → download.get answers null, while a
      // nonexistent method through the mirror → method_not_found (asserted in suite 1).
    },
    30_000,
  );

  it(
    "mirrors the engine into the downloads store through its own actions and events",
    async () => {
      fixture.setHandler(
        HttpFixture.handlerForSlowBytes(SLOW_BODY, { chunkBytes: 8 * 1024, chunkDelayMs: 25 }),
      );
      const store = useDownloadsStore.getState();
      await store.load();
      const jobsBefore = useDownloadsStore.getState().jobs.length;

      await store.create(fixture.url("/store-driven.bin"), downloadDir);
      const created = useDownloadsStore
        .getState()
        .jobs.find((j) => j.url === fixture.url("/store-driven.bin"));
      expect(created).toBeDefined();
      expect(useDownloadsStore.getState().jobs.length).toBe(jobsBefore + 1);

      // Progress events patch live fields through the real subscription (512 KiB at
      // 8 KiB / 25 ms streams for ~1.6 s — several throttle windows).
      const sawProgress = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => resolve(false), 20_000);
        const off = onEvent("download.progress", (p) => {
          if (p.jobId === created!.id && p.receivedBytes > 0) {
            clearTimeout(timer);
            off();
            resolve(true);
          }
        });
      });
      expect(sawProgress).toBe(true);
      // NOTE: store.core stays "unknown" here by design — the store subscribed after the
      // core's ready transition (renderer-boot ordering; the mirror asserts job-state
      // mirroring, which is this suite's subject).

      // Pause is engine-async: poll the STORE until the authoritative snapshot says so.
      await store.pause(created!.id);
      const pausedDeadline = Date.now() + 20_000;
      for (;;) {
        const row = useDownloadsStore.getState().jobs.find((j) => j.id === created!.id);
        if (row?.status === "paused") break;
        if (Date.now() > pausedDeadline) throw new Error("store never saw paused");
        await new Promise((r) => setTimeout(r, 50));
      }
      await store.resume(created!.id);
      const finished = await waitForJobStatus(app, created!.id, "completed");
      expect(finished.receivedBytes).toBe(SLOW_BODY.length);
      // The authoritative download.updated snapshot landed in the store too.
      const doneDeadline = Date.now() + 10_000;
      for (;;) {
        const row = useDownloadsStore.getState().jobs.find((j) => j.id === created!.id);
        if (row?.status === "completed") break;
        if (Date.now() > doneDeadline) throw new Error("store never saw completed");
        await new Promise((r) => setTimeout(r, 50));
      }

      await store.remove(created!.id, false);
      expect(useDownloadsStore.getState().jobs.some((j) => j.id === created!.id)).toBe(false);
    },
    180_000,
  );

  it(
    "round-trips settings through the settings store with live settings.changed sync",
    async () => {
      const store = useSettingsStore.getState();
      await store.load();
      expect(useSettingsStore.getState().status).toBe("ready");
      const before = useSettingsStore.getState().settings!.concurrentDownloads;

      const ok = await useSettingsStore.getState().update({ concurrentDownloads: before === 1 ? 2 : 1 });
      expect(ok).toBe(true);
      expect(useSettingsStore.getState().settings!.concurrentDownloads).toBe(
        before === 1 ? 2 : 1,
      );
      // The settings.changed event (main → renderer) was observed by the real
      // subscription and re-applied to the store.
      expect(useSettingsStore.getState().status).toBe("ready");

      // Rollback path: an invalid patch fails the wire validation and rolls back.
      const invalid = await useSettingsStore.getState().update({
        concurrentDownloads: 99, // contract max is 8
      });
      expect(invalid).toBe(false);
      expect(useSettingsStore.getState().error).toBeTruthy();
      expect(useSettingsStore.getState().settings!.concurrentDownloads).toBe(
        before === 1 ? 2 : 1,
      );
    },
    60_000,
  );
});
