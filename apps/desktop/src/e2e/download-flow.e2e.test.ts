import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

/**
 * E2E suite 2 — the download lifecycle over REAL bytes: a real node:http fixture, the
 * real segmented engine inside the real core binary, real files on a real disk. This is
 * the phase-map's first commandment made testable: downloads are persistent resumable
 * jobs, and an expired URL never destroys the job or the bytes already downloaded.
 */

const BODY = randomBytes(256 * 1024);
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");
/** Large enough that a throttled stream is still mid-flight when the test pauses it. */
const SLOW_BODY = randomBytes(1024 * 1024);

let app: AppHandle;
let fixture: HttpFixture;
let downloadDir: string;
let extraDirs: string[] = [];

async function tempDownloadDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syntaxdm-e2e-dl-"));
  extraDirs.push(dir);
  return dir;
}

/** Pause is asynchronous engine-side: poll until the run actually stopped. */
async function pauseAndWait(app: AppHandle, jobId: string): Promise<{
  status: string;
  receivedBytes: number;
  destinationPath: string | null;
}> {
  await app.rpc("download.pause", { id: jobId });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const snap = ((await app.rpc("download.get", { id: jobId })) as {
      job: { status: string; receivedBytes: number; destinationPath: string | null } | null;
    }).job!;
    if (snap.status === "paused") return snap;
    if (snap.status === "completed" || snap.status === "failed" || snap.status === "canceled") {
      throw new Error(`job reached ${snap.status} before the pause landed`);
    }
    if (Date.now() > deadline) throw new Error("job never reached paused");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  app = await bootApp();
  await app.supervisor.whenReady(30_000);
  fixture = new HttpFixture();
  await fixture.start();
  downloadDir = await tempDownloadDir();
}, 90_000);

afterAll(async () => {
  await fixture?.stop();
  await app?.dispose();
  for (const dir of extraDirs) await rm(dir, { recursive: true, force: true });
}, 90_000);

describeWithCore("E2E download lifecycle — real bytes, real engine", () => {
  it(
    "downloads real bytes to completion with a verified checksum and OS notification",
    async () => {
      fixture.setHandler(
        HttpFixture.handlerForStaticBytes(BODY, {
          etag: '"abc123"',
          lastModified: "Mon, 19 Oct 2026 00:00:00 GMT",
          contentType: "application/octet-stream",
          disposition: 'attachment; filename="payload.bin"',
        }),
      );
      fixture.requests.length = 0;

      const completedEvent = app.waitEvent(
        "download.updated",
        (p) => (p as { job?: { status?: string } }).job?.status === "completed",
      );
      const created = (await app.rpc("download.create", {
        url: fixture.url("/payload.bin"),
        destinationDir: downloadDir,
        checksum: { algorithm: "sha256", value: BODY_SHA256 },
      })) as { job: { id: string; status: string; segmentCount: number | null } };
      expect(created.job.status).toBe("queued");

      const job = await waitForJobStatus(app, created.job.id, "completed");
      // Segment planning happened in the real engine (multi-connection ceiling from
      // settings; a single window for a 256 KiB body is the correct plan).
      expect(job.segmentCount).not.toBeNull();
      // The file on disk is byte-identical to what the fixture served.
      expect(job.destinationPath).toBeTruthy();
      const onDisk = await readFile(String(job.destinationPath));
      expect(onDisk.equals(BODY)).toBe(true);
      // Streaming digest computed by the engine matches the fixture body, and the
      // expected-vs-actual comparison was carried out and recorded.
      expect(job.checksumActual).toBe(BODY_SHA256);
      expect(job.checksumVerified).toBe(true);
      // Validator signals were captured (resume safety depends on them).
      expect(job.etag).toBe('"abc123"');
      expect(job.totalBytes).toBe(BODY.length);
      expect(job.receivedBytes).toBe(BODY.length);

      // The core emitted authoritative snapshots along the way (created queued,
      // finished completed). Progress events are throttled (~500 ms) — a fast local
      // download legitimately completes without one; the slow drill below observes
      // real progress events.
      const snapshots = app.eventLog.filter(
        (e) => e.name === "download.updated" && (e.payload as { job?: { id?: string } }).job?.id === created.job.id,
      );
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      expect(
        snapshots.some((e) => (e.payload as { job: { status: string } }).job.status === "queued"),
      ).toBe(true);
      expect(
        snapshots.some((e) => (e.payload as { job: { status: string } }).job.status === "completed"),
      ).toBe(true);

      const doneEvent = (await completedEvent) as { job: { id: string; status: string } };
      expect(doneEvent.job.id).toBe(created.job.id);

      // The notify engine turned the queued→completed transition into an OS toast
      // (recorded by the stub port — main behavior, not renderer behavior).
      const notification = app.notifications.find((n) =>
        n.body.includes("payload.bin"),
      );
      expect(notification).toBeDefined();

      // Library listing agrees with the engine.
      const list = (await app.rpc("download.list")) as { jobs: { id: string }[] };
      expect(list.jobs.some((j) => j.id === created.job.id)).toBe(true);
    },
    120_000,
  );

  it(
    "pauses a throttled download, freezes its bytes, resumes via HTTP Range to completion",
    async () => {
      fixture.setHandler(
        HttpFixture.handlerForSlowBytes(SLOW_BODY, { chunkBytes: 8 * 1024, chunkDelayMs: 25 }),
      );
      fixture.requests.length = 0;

      const created = (await app.rpc("download.create", {
        url: fixture.url("/slow.bin"),
        destinationDir: downloadDir,
        filename: "slow.bin",
      })) as { job: { id: string } };

      // Let real bytes flow (1 MiB at 8 KiB / 25 ms ≈ 3 s of stream).
      const streamingDeadline = Date.now() + 30_000;
      for (;;) {
        const snap = ((await app.rpc("download.get", { id: created.job.id })) as {
          job: { status: string; receivedBytes: number } | null;
        }).job!;
        if (snap.status === "downloading" && snap.receivedBytes > 128 * 1024) break;
        if (Date.now() > streamingDeadline) throw new Error("job never started streaming");
        await new Promise((r) => setTimeout(r, 100));
      }

      const paused = await pauseAndWait(app, created.job.id);
      expect(paused.status).toBe("paused");
      expect(paused.receivedBytes).toBeGreaterThan(0);
      expect(paused.receivedBytes).toBeLessThan(SLOW_BODY.length);

      // Bytes are frozen while paused (two samples, 400 ms apart, must agree).
      await new Promise((r) => setTimeout(r, 400));
      const frozen = ((await app.rpc("download.get", { id: created.job.id })) as {
        job: { receivedBytes: number };
      }).job;
      expect(frozen.receivedBytes).toBe(paused.receivedBytes);

      const resumed = ((await app.rpc("download.resume", { id: created.job.id })) as {
        job: { status: string };
      }).job;
      expect(["queued", "probing", "downloading"]).toContain(resumed.status);

      const job = await waitForJobStatus(app, created.job.id, "completed");
      const onDisk = await readFile(String(job.destinationPath));
      expect(onDisk.equals(SLOW_BODY)).toBe(true);
      // Resume re-anchored onto the same source with a Range request — the recovery
      // engine's gap-fill over the real wire.
      const rangeRequests = fixture.requests.filter((r) => r.headers.range !== undefined);
      expect(rangeRequests.length).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "lands a dead-URL job in failed with a typed error code and keeps the job row",
    async () => {
      fixture.setHandler(HttpFixture.handlerForNotFound());
      const created = (await app.rpc("download.create", {
        url: fixture.url("/missing.bin"),
        destinationDir: downloadDir,
      })) as { job: { id: string } };
      const job = await waitForJobStatus(app, created.job.id, "failed");
      expect(typeof job.errorCode).toBe("string");
      expect(String(job.errorCode).length).toBeGreaterThan(0);
      // The first commandment: the expired URL never destroys the job.
      const list = (await app.rpc("download.list")) as { jobs: { id: string; status: string }[] };
      const row = list.jobs.find((j) => j.id === created.job.id);
      expect(row).toBeDefined();
      expect(row!.status).toBe("failed");
      // The failure is user-visible through the notify engine (body carries the
      // classified error code, per describeTransition).
      expect(
        app.notifications.some((n) => n.body.includes(String(job.errorCode))),
      ).toBe(true);
    },
    120_000,
  );

  it(
    "removes a paused job and its partial sidecar file (the artifact never existed)",
    async () => {
      fixture.setHandler(
        HttpFixture.handlerForSlowBytes(SLOW_BODY, { chunkBytes: 8 * 1024, chunkDelayMs: 40 }),
      );
      const created = (await app.rpc("download.create", {
        url: fixture.url("/removable.bin"),
        destinationDir: downloadDir,
        filename: "removable.bin",
      })) as { job: { id: string } };
      // Stream first so the pause lands mid-flight with a genuinely partial cursor.
      const streamingDeadline = Date.now() + 30_000;
      for (;;) {
        const snap = ((await app.rpc("download.get", { id: created.job.id })) as {
          job: { status: string; receivedBytes: number } | null;
        }).job!;
        if (snap.status === "downloading" && snap.receivedBytes > 128 * 1024) break;
        if (Date.now() > streamingDeadline) throw new Error("job never started streaming");
        await new Promise((r) => setTimeout(r, 100));
      }
      const paused = await pauseAndWait(app, created.job.id);
      const partPath = `${paused.destinationPath ?? ""}.part`;
      // The pause landed mid-stream: the durable cursor is genuinely partial (the part
      // file itself is preallocated to full size by the engine — fragmentation control).
      expect(paused.receivedBytes).toBeGreaterThan(0);
      expect(paused.receivedBytes).toBeLessThan(SLOW_BODY.length);
      // The partial bytes genuinely sit on disk while paused — the deletion below has
      // something real to delete.
      const partial = await stat(partPath);
      expect(partial.size).toBeGreaterThan(0);

      await app.rpc("download.remove", { id: created.job.id, deletePartialFile: true });
      const list = (await app.rpc("download.list")) as { jobs: { id: string }[] };
      expect(list.jobs.some((j) => j.id === created.job.id)).toBe(false);
      const listed = ((await app.rpc("download.get", { id: created.job.id })) as {
        job: unknown;
      }).job;
      expect(listed).toBeNull();
      // The partial sidecar is gone from the disk, not just from the table.
      await expect(stat(partPath)).rejects.toThrow();
    },
    120_000,
  );

  it(
    "persists completed jobs across core death — a fresh boot on the same database keeps bytes and integrity facts",
    async () => {
      fixture.setHandler(
        HttpFixture.handlerForStaticBytes(BODY, {
          etag: '"persist-1"',
          disposition: 'attachment; filename="durable.bin"',
        }),
      );
      const dir = await tempDownloadDir();
      const first = await bootApp({ userDataDir: dir });
      await first.supervisor.whenReady(30_000);
      const created = (await first.rpc("download.create", {
        url: fixture.url("/durable.bin"),
        destinationDir: dir,
        checksum: { algorithm: "sha256", value: BODY_SHA256 },
      })) as { job: { id: string } };
      const jobBefore = await waitForJobStatus(first, created.job.id, "completed");
      expect(jobBefore.checksumVerified).toBe(true);

      // Full graceful stop (core.shutdown → SIGTERM escalation path) — stop() only,
      // the directory (and the database inside it) must survive.
      await first.stop();

      // A brand new supervisor + router + composition over the same SQLite database:
      // the shipped restart path, exercised for real.
      const second = await bootApp({ userDataDir: dir });
      try {
        await second.supervisor.whenReady(30_000);
        const list = (await second.rpc("download.list")) as {
          jobs: Array<{
            id: string;
            status: string;
            receivedBytes: number;
            etag: string | null;
            checksumActual: string | null;
            checksumVerified: boolean | null;
            destinationPath: string | null;
          }>;
        };
        const row = list.jobs.find((j) => j.id === created.job.id);
        expect(row).toBeDefined();
        expect(row!.status).toBe("completed");
        expect(row!.receivedBytes).toBe(BODY.length);
        expect(row!.etag).toBe('"persist-1"');
        expect(row!.checksumActual).toBe(BODY_SHA256);
        expect(row!.checksumVerified).toBe(true);
        // The artifact itself survived with the row.
        expect(row!.destinationPath).toBe(jobBefore.destinationPath);
        const onDisk = await readFile(String(row!.destinationPath));
        expect(onDisk.equals(BODY)).toBe(true);
      } finally {
        await second.stop();
      }
    },
    180_000,
  );
});
