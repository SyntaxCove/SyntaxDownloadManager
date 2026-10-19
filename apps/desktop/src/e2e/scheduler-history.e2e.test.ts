import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootApp,
  describeWithCore,
  type AppHandle,
} from "./harness.js";

/**
 * E2E suite 4 — the browser-data and scheduler domains over the real core binary and
 * its SQLite storage: scheduler rows + runNow outcomes with scheduler.updated events,
 and history/bookmark CRUD through the full wire path.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await bootApp();
  await app.supervisor.whenReady(30_000);
}, 60_000);

afterAll(async () => {
  await app?.dispose();
}, 60_000);

describeWithCore("E2E scheduler + browser data over the real core", () => {
  it(
    "creates a scheduler job, fires it with runNow, records the outcome and emits scheduler.updated",
    async () => {
      const updated = app.waitEvent("scheduler.updated");
      const created = (await app.rpc("scheduler.create", {
        kind: "download.pauseAll",
        payload: {},
        startAt: Date.now() + 3_600_000, // future anchor
        repeat: "none",
        enabled: true,
      })) as { job: { id: string; kind: string; nextRunAt: number | null; lastFiredAt: string | null } };
      expect(created.job.kind).toBe("download.pauseAll");
      expect(created.job.nextRunAt).not.toBeNull();
      expect(created.job.lastFiredAt).toBeNull();
      (await updated) as unknown; // create itself snapshots the row

      const runNow = (await app.rpc("scheduler.runNow", { id: created.job.id })) as {
        job: { lastFiredAt: number | null; lastResultCode: string | null; nextRunAt: number | null };
      };
      // One-shot fired: outcome recorded on the row. Per the contract, runNow leaves
      // the schedule itself untouched — the row's next occurrence only advances at the
      // engine's own tick, so nextRunAt stays anchored as created.
      expect(runNow.job.lastFiredAt).not.toBeNull();
      expect(runNow.job.lastResultCode).toBe("ok");
      expect(runNow.job.nextRunAt).toBe(created.job.nextRunAt);

      const listed = (await app.rpc("scheduler.list")) as {
        jobs: { id: string; lastResultCode: string | null }[];
      };
      const row = listed.jobs.find((j) => j.id === created.job.id);
      expect(row).toBeDefined();
      expect(row!.lastResultCode).toBe("ok");

      const events = app.eventLog.filter((e) => e.name === "scheduler.updated");
      expect(events.length).toBeGreaterThanOrEqual(2); // create snapshot + fire snapshot

      const removed = (await app.rpc("scheduler.remove", { id: created.job.id })) as {
        removed: boolean;
      };
      expect(removed.removed).toBe(true);
      const afterRemove = (await app.rpc("scheduler.list")) as { jobs: { id: string }[] };
      expect(afterRemove.jobs.some((j) => j.id === created.job.id)).toBe(false);
    },
    60_000,
  );

  it(
    "rejects a scheduler payload that does not match the target method's schema",
    async () => {
      await expect(
        app.rpc("scheduler.create", {
          kind: "download.create",
          payload: { url: "not-a-url" },
          startAt: Date.now(),
          repeat: "none",
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    },
    30_000,
  );

  it(
    "records, lists, searches, deletes and clears history through the real storage",
    async () => {
      expect((await app.rpc("browser.history.record", {
        url: "https://example.com/alpha",
        title: "Alpha page",
        visitedAt: Date.now() - 5_000,
      })) as { recorded: true }).toEqual({ recorded: true });
      await app.rpc("browser.history.record", {
        url: "https://example.com/beta",
        title: "Beta page",
        visitedAt: Date.now(),
      });

      const list = (await app.rpc("browser.history.list")) as {
        entries: { id: string; url: string; title: string | null }[];
      };
      expect(list.entries.some((e) => e.url === "https://example.com/alpha")).toBe(true);
      expect(list.entries.some((e) => e.url === "https://example.com/beta")).toBe(true);

      const search = (await app.rpc("browser.history.list", { query: "alpha" })) as {
        entries: { url: string }[];
      };
      expect(search.entries.every((e) => e.url === "https://example.com/alpha")).toBe(true);

      const alpha = list.entries.find((e) => e.url === "https://example.com/alpha")!;
      const deleted = (await app.rpc("browser.history.delete", { id: alpha.id })) as {
        deleted: boolean;
      };
      expect(deleted.deleted).toBe(true);

      const cleared = (await app.rpc("browser.history.clear")) as { cleared: number };
      expect(cleared.cleared).toBeGreaterThan(0);
      const empty = (await app.rpc("browser.history.list")) as { entries: unknown[] };
      expect(empty.entries).toHaveLength(0);
    },
    60_000,
  );

  it(
    "rejects non-http(s) history records at the core boundary",
    async () => {
      await expect(
        app.rpc("browser.history.record", { url: "file:///etc/passwd" }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    },
    30_000,
  );

  it(
    "creates, finds, updates, lists and removes bookmarks through the real storage",
    async () => {
      const created = (await app.rpc("browser.bookmark.create", {
        url: "https://docs.example/guide",
        title: "The Guide",
      })) as { bookmark: { id: string; title: string; position: number } };
      expect(created.bookmark.title).toBe("The Guide");

      const byUrl = (await app.rpc("browser.bookmark.getByUrl", {
        url: "https://docs.example/guide",
      })) as { bookmark: { id: string } | null };
      expect(byUrl.bookmark).not.toBeNull();
      expect(byUrl.bookmark!.id).toBe(created.bookmark.id);

      const miss = (await app.rpc("browser.bookmark.getByUrl", {
        url: "https://docs.example/absent",
      })) as { bookmark: unknown };
      expect(miss.bookmark).toBeNull();

      const updated = (await app.rpc("browser.bookmark.update", {
        id: created.bookmark.id,
        title: "The Guide (updated)",
      })) as { bookmark: { title: string } };
      expect(updated.bookmark.title).toBe("The Guide (updated)");

      const list = (await app.rpc("browser.bookmark.list")) as {
        bookmarks: { id: string }[];
      };
      expect(list.bookmarks.some((b) => b.id === created.bookmark.id)).toBe(true);

      const removed = (await app.rpc("browser.bookmark.remove", { id: created.bookmark.id })) as {
        removed: boolean;
      };
      expect(removed.removed).toBe(true);
      const afterRemove = (await app.rpc("browser.bookmark.getByUrl", {
        url: "https://docs.example/guide",
      })) as { bookmark: unknown };
      expect(afterRemove.bookmark).toBeNull();
    },
    60_000,
  );
});
