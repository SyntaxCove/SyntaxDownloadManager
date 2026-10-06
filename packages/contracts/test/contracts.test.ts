import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DownloadJob, DownloadProgress, BrowserTab, AppSettings, MediaManifest,
  RequestEnvelope, SuccessEnvelope, ErrorEnvelope, EventEnvelope,
  METHODS, EVENTS, CONTRACT_VERSION, PROTOCOL_VERSION,
  newUlid, ulidTime, normalizeUlid, Ulid, makeRequest, makeSuccess, makeError, makeEvent,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const domainFixture = JSON.parse(readFileSync(join(fixturesDir, "domain.json"), "utf8"));
const envelopesFixture = JSON.parse(readFileSync(join(fixturesDir, "envelopes.json"), "utf8"));

describe("ulid", () => {
  it("generates valid, sortable, monotonic ULIDs", () => {
    const ids = Array.from({ length: 1000 }, () => newUlid());
    for (const id of ids) expect(Ulid.safeParse(id).success).toBe(true);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids); // monotonic: generation order == lexicographic order
  });

  it("decodes timestamps and normalizes Crockford misreads", () => {
    const id = newUlid();
    const t = ulidTime(id)!;
    expect(Math.abs(Date.now() - t)).toBeLessThan(5_000);
    expect(ulidTime(normalizeUlid(id.replace(/0/g, "o")))).toBe(t);
    expect(ulidTime("nope")).toBeNull();
  });
});

describe("domain schemas against fixtures", () => {
  it("parses DownloadJob", () => {
    const job = DownloadJob.parse(domainFixture.downloadJob);
    expect(job.status).toBe("downloading");
    expect(job.totalBytes).toBe(104857600);
  });
  it("parses DownloadProgress", () => {
    expect(DownloadProgress.parse(domainFixture.downloadProgress).jobId).toBe(
      domainFixture.downloadProgress.jobId,
    );
  });
  it("parses BrowserTab, AppSettings, MediaManifest", () => {
    expect(BrowserTab.parse(domainFixture.browserTab).title).toBe("Example Domain");
    expect(AppSettings.parse(domainFixture.appSettings).language).toBe("fa");
    expect(MediaManifest.parse(domainFixture.mediaManifest).videos).toHaveLength(1);
  });
  it("rejects malformed jobs", () => {
    const bad = { ...domainFixture.downloadJob, totalBytes: -1 };
    expect(DownloadJob.safeParse(bad).success).toBe(false);
    const badId = { ...domainFixture.downloadJob, id: "not-a-ulid" };
    expect(DownloadJob.safeParse(badId).success).toBe(false);
  });
});

describe("envelope schemas against fixtures", () => {
  it("parses request / success / error / event", () => {
    expect(RequestEnvelope.parse(envelopesFixture.request).method).toBe("download.pause");
    expect(SuccessEnvelope.parse(envelopesFixture.success).ok).toBe(true);
    expect(ErrorEnvelope.parse(envelopesFixture.error).error.code).toBe("invalid_state");
    expect(EventEnvelope.parse(envelopesFixture.event).event).toBe("download.progress");
  });
  it("rejects wrong protocol version", () => {
    expect(RequestEnvelope.safeParse({ ...envelopesFixture.request, v: 99 }).success).toBe(false);
  });
  it("builder helpers round-trip through the schemas", () => {
    const req = makeRequest(newUlid(), "download.list", {});
    const ok = makeSuccess(req.id, { jobs: [domainFixture.downloadJob] });
    const err = makeError(req.id, { code: "storage_error", message: "db locked" });
    const ev = makeEvent("download.updated", { job: domainFixture.downloadJob });
    expect(RequestEnvelope.parse(req).id).toBe(ok.id);
    expect(SuccessEnvelope.parse(ok).result.jobs).toHaveLength(1);
    expect(ErrorEnvelope.parse(err).error.code).toBe("storage_error");
    expect(EventEnvelope.parse(ev).payload).toBeTruthy();
  });
});

describe("registry integrity", () => {
  it("every method entry has params+result schemas and a valid server", () => {
    for (const [name, entry] of Object.entries(METHODS)) {
      expect(entry.server === "main" || entry.server === "core", name).toBe(true);
      if (name !== "core.ping" && name !== "core.shutdown") {
        expect(entry.params, name).toBeDefined();
        expect(entry.result, name).toBeDefined();
      }
    }
  });
  it("every event entry has a payload schema", () => {
    for (const [name, entry] of Object.entries(EVENTS)) {
      expect(entry.payload, name).toBeDefined();
    }
  });
  it("contract/protocol versions are exported", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
