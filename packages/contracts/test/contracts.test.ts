import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DownloadJob, DownloadProgress, DownloadCreateParams, BrowserTab, AppSettings, MediaManifest,
  RequestEnvelope, SuccessEnvelope, ErrorEnvelope, EventEnvelope,
  METHODS, EVENTS, CONTRACT_VERSION, PROTOCOL_VERSION, ErrorCodes,
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

describe("v1.1 segmented engine + integrity (Phase 6)", () => {
  it("parses the segmented job fixture (segmentCount + checksum fields)", () => {
    const job = DownloadJob.parse(domainFixture.downloadJobSegmented);
    expect(job.segmentCount).toBe(4);
    expect(job.checksumAlgorithm).toBe("sha256");
    expect(job.checksumExpected).toMatch(/^[0-9a-f]{64}$/);
    expect(job.checksumActual).toBeNull();
    expect(job.checksumVerified).toBeNull();
  });

  it("still parses the legacy v1 job fixture (new keys nullable/absent)", () => {
    const job = DownloadJob.parse(domainFixture.downloadJob);
    expect(job.segmentCount).toBeNull();
    expect(job.checksumAlgorithm).toBeUndefined();
    expect(job.checksumActual).toBeNull();
    expect(job.checksumVerified).toBeNull();
  });

  it("accepts create params with a valid checksum", () => {
    const params = DownloadCreateParams.parse({
      url: "https://example.com/setup.zip",
      destinationDir: "/home/user/Downloads",
      checksum: { algorithm: "sha256", value: "ab".repeat(32) },
    });
    expect(params.checksum?.algorithm).toBe("sha256");
    expect(params.checksum?.value).toBe("ab".repeat(32));
  });

  it("rejects checksums whose hex length does not match the algorithm", () => {
    const bad = {
      url: "https://example.com/setup.zip",
      destinationDir: "/home/user/Downloads",
      checksum: { algorithm: "sha256", value: "ab".repeat(16) },
    };
    expect(DownloadCreateParams.safeParse(bad).success).toBe(false);
    const nonHex = {
      url: "https://example.com/setup.zip",
      destinationDir: "/home/user/Downloads",
      checksum: { algorithm: "md5", value: "zz".repeat(16) },
    };
    expect(DownloadCreateParams.safeParse(nonHex).success).toBe(false);
  });

  it("setConcurrency accepts the optional maxConnectionsPerDownload", () => {
    const entry = METHODS["download.setConcurrency"];
    const ok = entry.params.parse({ max: 3, maxConnectionsPerDownload: 8 });
    expect(ok.maxConnectionsPerDownload).toBe(8);
    const legacy = entry.params.parse({ max: 3 });
    expect(legacy.maxConnectionsPerDownload).toBeUndefined();
    expect(
      entry.params.safeParse({ max: 3, maxConnectionsPerDownload: 0 }).success,
    ).toBe(false);
    expect(
      entry.params.safeParse({ max: 3, maxConnectionsPerDownload: 17 }).success,
    ).toBe(false);
  });

  it("appSettings default maxConnectionsPerDownload = 4 and rejects out-of-range", () => {
    expect(AppSettings.parse({}).maxConnectionsPerDownload).toBe(4);
    expect(AppSettings.safeParse({ maxConnectionsPerDownload: 0 }).success).toBe(false);
    expect(AppSettings.safeParse({ maxConnectionsPerDownload: 17 }).success).toBe(false);
    expect(AppSettings.parse(domainFixture.appSettings).maxConnectionsPerDownload).toBe(4);
  });
});

describe("v1.2 recovery engine (Phase 7)", () => {
  it("parses the recovered job fixture (recoveryCount + reboundAt set)", () => {
    const job = DownloadJob.parse(domainFixture.downloadJobRecovered);
    expect(job.recoveryCount).toBe(2);
    expect(job.reboundAt).toBe(1735689960000);
    expect(job.status).toBe("paused");
  });

  it("parses legacy fixtures with null recovery fields (always serialized)", () => {
    for (const key of ["downloadJob", "downloadJobSegmented"] as const) {
      const job = DownloadJob.parse(domainFixture[key]);
      expect(job.recoveryCount).toBeNull();
      expect(job.reboundAt).toBeNull();
    }
  });

  it("rejects negative or non-integer recoveryCount", () => {
    expect(
      DownloadJob.safeParse({ ...domainFixture.downloadJob, recoveryCount: -1 }).success,
    ).toBe(false);
    expect(
      DownloadJob.safeParse({ ...domainFixture.downloadJob, recoveryCount: 1.5 }).success,
    ).toBe(false);
  });

  it("registers the recovery methods with validated params", () => {
    for (const method of ["download.recover", "download.retry"] as const) {
      const entry = METHODS[method];
      expect(entry.server).toBe("core");
      expect(entry.params.parse({ id: domainFixture.downloadJob.id })).toBeTruthy();
      expect(entry.params.safeParse({ id: "nope" }).success).toBe(false);
    }
    const replace = METHODS["download.replaceUrl"];
    expect(replace.server).toBe("core");
    expect(
      replace.params.parse({ id: domainFixture.downloadJob.id, url: "https://mirror.example.com/f.zip" }),
    ).toBeTruthy();
    expect(
      replace.params.safeParse({ id: domainFixture.downloadJob.id, url: "ftp://x/f.zip" }).success,
    ).toBe(false);
  });

  it("error code registry includes the recovery codes (append-only)", () => {
    expect(ErrorCodes).toContain("source_gone");
    expect(ErrorCodes).toContain("source_forbidden");
    expect(ErrorCodes).toContain("source_changed");
  });
});
