import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DownloadJob, DownloadProgress, DownloadCreateParams, BrowserTab, AppSettings, MediaManifest,
  MediaInspectParams, MediaJob, MediaDownloadParams, MediaProgress, MediaContainer,
  MediaSubtitleSelection,
  RequestEnvelope, SuccessEnvelope, ErrorEnvelope, EventEnvelope,
  METHODS, EVENTS, CONTRACT_VERSION, PROTOCOL_VERSION, ErrorCodes,
  newUlid, ulidTime, normalizeUlid, Ulid, makeRequest, makeSuccess, makeError, makeEvent,
  ProxyProfileInput, ProxyProfilePublic, ProxyEndpoint, ProxyTestResult, DownloadSetProxyParams,
  TabSetProxyParams,
  ToolkitManifest, ToolkitStatusResult, ToolkitSetPathsParams, ToolkitToolStatus,
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

describe("v1.3 queue + bandwidth policy (Phase 8)", () => {
  it("parses the queued job fixture (queuePosition set, speedLimitKBps present)", () => {
    const job = DownloadJob.parse(domainFixture.downloadJobQueued);
    expect(job.status).toBe("queued");
    expect(job.queuePosition).toBe(2);
    expect(job.speedLimitKBps).toBe(512);
  });

  it("parses legacy fixtures with a null queuePosition (always serialized)", () => {
    for (const key of ["downloadJob", "downloadJobSegmented", "downloadJobRecovered"] as const) {
      const job = DownloadJob.parse(domainFixture[key]);
      expect(job.queuePosition).toBeNull();
      expect(job.speedLimitKBps).toBeUndefined();
    }
  });

  it("rejects negative or non-integer queuePosition / speedLimitKBps", () => {
    expect(
      DownloadJob.safeParse({ ...domainFixture.downloadJob, queuePosition: -1 }).success,
    ).toBe(false);
    expect(
      DownloadJob.safeParse({ ...domainFixture.downloadJob, speedLimitKBps: -5 }).success,
    ).toBe(false);
  });

  it("registers the queue/bandwidth methods with validated params", () => {
    const move = METHODS["download.queueMove"];
    expect(move.server).toBe("core");
    expect(move.params.parse({ id: domainFixture.downloadJob.id, direction: "top" })).toBeTruthy();
    expect(move.params.safeParse({ id: domainFixture.downloadJob.id, direction: "sideways" }).success).toBe(false);

    const limit = METHODS["download.setSpeedLimit"];
    expect(limit.server).toBe("core");
    expect(limit.params.parse({ id: domainFixture.downloadJob.id, kbps: 0 })).toBeTruthy();
    expect(limit.params.safeParse({ id: domainFixture.downloadJob.id, kbps: -1 }).success).toBe(false);

    const startAll = METHODS["download.startAll"];
    const pauseAll = METHODS["download.pauseAll"];
    expect(startAll.server).toBe("core");
    expect(pauseAll.server).toBe("core");
    expect(startAll.params.parse({})).toEqual({});
  });

  it("download.setPolicy validates the full payload envelope", () => {
    const policy = METHODS["download.setPolicy"];
    expect(policy.server).toBe("core");
    const valid = {
      autoStartNew: true,
      scheduleMode: "window",
      windowStartMinute: 1320,
      windowEndMinute: 360,
      speedLimitKBps: 512,
      tzOffsetMinutes: 210,
    };
    expect(policy.params.parse(valid)).toBeTruthy();
    expect(policy.params.safeParse({ ...valid, scheduleMode: "sometimes" }).success).toBe(false);
    expect(policy.params.safeParse({ ...valid, windowStartMinute: 1440 }).success).toBe(false);
    expect(policy.params.safeParse({ ...valid, tzOffsetMinutes: 900 }).success).toBe(false);
  });

  it("appSettings gains the queue/scheduler fields with behavior-preserving defaults", () => {
    const parsed = AppSettings.parse({});
    expect(parsed.speedLimitKBps).toBe(0);
    expect(parsed.autoStartNewDownloads).toBe(true);
    expect(parsed.scheduleEnabled).toBe(false);
    expect(parsed.scheduleStart).toBe("00:00");
    expect(parsed.scheduleEnd).toBe("00:00");
    // HH:MM validation (24h)
    expect(AppSettings.safeParse({ scheduleStart: "7:30" }).success).toBe(false);
    expect(AppSettings.safeParse({ scheduleStart: "24:00" }).success).toBe(false);
    expect(AppSettings.safeParse({ scheduleEnd: "06:00" }).success).toBe(true);
  });

  it("contract version is at least 1.4.0 (Phase 9 proxy routing is additive)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(4);
    else expect(maj).toBeGreaterThan(1);
  });
});

describe("v1.4 proxy routing (Phase 9)", () => {
  const pid = domainFixture.proxyProfile.id;

  it("parses the proxyProfile fixture and enforces redaction on the public shape", () => {
    const pub_ = ProxyProfilePublic.parse(domainFixture.proxyProfile);
    expect(pub_.password).toBeNull();
    // A public profile carrying a secret is invalid — main must redact.
    expect(ProxyProfilePublic.safeParse({ ...domainFixture.proxyProfile, password: "x" }).success)
      .toBe(false);
  });

  it("input schema accepts secrets the public schema forbids", () => {
    const input = { ...domainFixture.proxyProfile, password: "s3cret" };
    expect(ProxyProfileInput.parse(input).password).toBe("s3cret");
    delete (input as { password?: unknown }).password;
    input.username = null;
    input.password = null;
    expect(ProxyProfileInput.safeParse(input).success).toBe(true);
  });

  it("parses the proxied-job fixture; existing jobs carry proxyProfileId null", () => {
    const job = DownloadJob.parse(domainFixture.downloadJobProxied);
    expect(job.proxyProfileId).toBe(pid);
    expect(job.errorCode).toBe("proxy_profile_not_found");
    expect(DownloadJob.parse(domainFixture.downloadJob).proxyProfileId).toBeNull();
  });

  it("ProxyEndpoint carries secrets for the main→core push only", () => {
    const ep = ProxyEndpoint.parse({ ...domainFixture.proxyProfile, password: "pw" });
    expect(ep.password).toBe("pw");
    expect(ProxyEndpoint.safeParse({ ...domainFixture.proxyProfile, scheme: "ftp" }).success)
      .toBe(false);
  });

  it("proxy.test result validates the latency/exitIp/status/errorCode shape", () => {
    expect(ProxyTestResult.parse({ ok: true, latencyMs: 42, exitIp: "203.0.113.9", status: 200, errorCode: null }).ok)
      .toBe(true);
    expect(ProxyTestResult.parse({ ok: false, latencyMs: null, exitIp: null, status: null, errorCode: "network_error" }).ok)
      .toBe(false);
    expect(ProxyTestResult.safeParse({ ok: true, latencyMs: -1, exitIp: null, status: null, errorCode: null }).success)
      .toBe(false);
  });

  it("registers the Phase 9 methods on the correct servers", () => {
    for (const m of ["proxy.list", "proxy.create", "proxy.update", "proxy.remove", "browser.tab.setProxy"]) {
      expect(METHODS[m as keyof typeof METHODS].server).toBe("main");
    }
    for (const m of ["download.setProxy", "proxy.setRuntime", "proxy.test"]) {
      expect(METHODS[m as keyof typeof METHODS].server).toBe("core");
    }
  });

  it("setProxy params accept null (direct) and reject junk", () => {
    expect(DownloadSetProxyParams.safeParse({ id: newUlid(), proxyProfileId: null }).success).toBe(true);
    expect(DownloadSetProxyParams.safeParse({ id: newUlid(), proxyProfileId: pid }).success).toBe(true);
    expect(DownloadSetProxyParams.safeParse({ id: newUlid(), proxyProfileId: "" }).success).toBe(false);
    expect(TabSetProxyParams.safeParse({ id: newUlid(), proxyProfileId: null }).success).toBe(true);
  });

  it("error codes stay append-only and gained the proxy codes", () => {
    expect(ErrorCodes).toContain("proxy_keychain_unavailable");
    expect(ErrorCodes).toContain("proxy_profile_not_found");
    expect(ErrorCodes).toContain("proxy_in_use");
  });
});

describe("v1.5 bundled media toolkit (Phase 10)", () => {
  it("parses the manifest fixture and normalizes platform keys", () => {
    const manifest = ToolkitManifest.parse(domainFixture.toolkitManifest);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.tools[0].id).toBe("yt-dlp");
    expect(manifest.tools[0].platforms["win32-x64"].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.tools[0].platforms["linux-x64"].archiveType).toBe("none");
  });

  it("rejects insecure (http) artifact URLs and non-hex sha256", () => {
    const http = structuredClone(domainFixture.toolkitManifest);
    http.tools[0].platforms["win32-x64"].url = "http://example.com/yt-dlp.exe";
    expect(ToolkitManifest.safeParse(http).success).toBe(false);
    const badHash = structuredClone(domainFixture.toolkitManifest);
    badHash.tools[0].platforms["linux-x64"].sha256 = "ZZ".repeat(32);
    expect(ToolkitManifest.safeParse(badHash).success).toBe(false);
    const shortHash = structuredClone(domainFixture.toolkitManifest);
    shortHash.tools[0].platforms["linux-x64"].sha256 = "ab".repeat(16);
    expect(ToolkitManifest.safeParse(shortHash).success).toBe(false);
  });

  it("rejects path traversal in execPath / extraExecs", () => {
    const evil = structuredClone(domainFixture.toolkitManifest);
    evil.tools[0].platforms["win32-x64"].execPath = "../yt-dlp.exe";
    expect(ToolkitManifest.safeParse(evil).success).toBe(false);
    const absolute = structuredClone(domainFixture.toolkitManifest);
    absolute.tools[0].platforms["win32-x64"].execPath = "C:\\Windows\\yt-dlp.exe";
    expect(ToolkitManifest.safeParse(absolute).success).toBe(false);
  });

  it("parses the status fixture with ready + failed states", () => {
    const status = ToolkitStatusResult.parse(domainFixture.toolkitStatus);
    expect(status.platform).toBe("linux-x64");
    expect(status.tools[0].state).toBe("ready");
    expect(status.tools[0].path).toContain("yt-dlp");
    expect(status.tools[1].state).toBe("failed");
    expect(status.tools[1].errorCode).toBe("toolkit_checksum_mismatch");
    expect(status.tools[1].path).toBeNull();
  });

  it("rejects unknown tool ids and unknown states", () => {
    expect(
      ToolkitToolStatus.safeParse({
        ...domainFixture.toolkitStatus.tools[0],
        id: "winrar",
      }).success,
    ).toBe(false);
    expect(
      ToolkitToolStatus.safeParse({
        ...domainFixture.toolkitStatus.tools[0],
        state: "downloading-to-the-moon",
      }).success,
    ).toBe(false);
  });

  it("toolkit.setPaths validates id/version/path entries", () => {
    const parsed = ToolkitSetPathsParams.parse(domainFixture.toolkitPaths);
    expect(parsed.tools).toHaveLength(3);
    expect(parsed.tools[0].id).toBe("yt-dlp");
    expect(
      ToolkitSetPathsParams.safeParse({
        tools: [{ id: "deno", version: "2.1.5", path: "" }],
      }).success,
    ).toBe(false);
    expect(
      ToolkitSetPathsParams.safeParse({
        tools: [{ id: "bash", version: "5", path: "/bin/bash" }],
      }).success,
    ).toBe(false);
  });

  it("registers the Phase 10 methods on the correct servers", () => {
    for (const m of ["toolkit.getStatus", "toolkit.ensureAll", "toolkit.ensure", "toolkit.cancel"]) {
      expect(METHODS[m as keyof typeof METHODS].server).toBe("main");
    }
    expect(METHODS["toolkit.setPaths"].server).toBe("core");
  });

  it("appSettings gains mediaToolsAutoFetch defaulting to true", () => {
    expect(AppSettings.parse({}).mediaToolsAutoFetch).toBe(true);
    expect(AppSettings.safeParse({ mediaToolsAutoFetch: "yes" }).success).toBe(false);
  });

  it("error codes stay append-only and gained the toolkit codes", () => {
    expect(ErrorCodes).toContain("toolkit_unsupported_platform");
    expect(ErrorCodes).toContain("toolkit_manifest_invalid");
    expect(ErrorCodes).toContain("toolkit_fetch_failed");
    expect(ErrorCodes).toContain("toolkit_extract_failed");
    expect(ErrorCodes).toContain("toolkit_checksum_mismatch");
  });

  it("contract version is at least 1.5.0 (Phase 10 toolkit is additive)", () => {
    expect(CONTRACT_VERSION >= "1.5.0").toBe(true);
  });
});

describe("v1.6 media inspector (Phase 11)", () => {
  it("parses the refreshed mediaManifest fixture (isLive + progressive acodec)", () => {
    const manifest = MediaManifest.parse(domainFixture.mediaManifest);
    expect(manifest.isLive).toBe(false);
    expect(manifest.videos[0].acodec).toBeNull();
  });

  it("accepts a progressive video (acodec present) and a live manifest", () => {
    const progressive = MediaManifest.parse({
      ...domainFixture.mediaManifest,
      isLive: true,
      videos: [{ ...domainFixture.mediaManifest.videos[0], acodec: "mp4a.40.2" }],
    });
    expect(progressive.isLive).toBe(true);
    expect(progressive.videos[0].acodec).toBe("mp4a.40.2");
    expect(MediaManifest.safeParse({ ...domainFixture.mediaManifest, isLive: "no" }).success).toBe(
      false,
    );
    expect(
      MediaManifest.safeParse({
        ...domainFixture.mediaManifest,
        videos: [{ ...domainFixture.mediaManifest.videos[0], acodec: 42 }],
      }).success,
    ).toBe(false);
  });

  it("media.inspect params validate url and optional proxyProfileId", () => {
    expect(MediaInspectParams.safeParse({ url: "https://example.com/watch/abc" }).success).toBe(
      true,
    );
    expect(
      MediaInspectParams.safeParse({
        url: "https://example.com/watch/abc",
        proxyProfileId: newUlid(),
      }).success,
    ).toBe(true);
    expect(MediaInspectParams.safeParse({ url: "" }).success).toBe(false);
    expect(
      MediaInspectParams.safeParse({ url: "https://x.example", proxyProfileId: "" }).success,
    ).toBe(false);
  });

  it("registers media.inspect on the core server only", () => {
    expect(METHODS["media.inspect"].server).toBe("core");
  });

  it("error codes stay append-only and gained the media codes", () => {
    expect(ErrorCodes).toContain("media_tool_missing");
    expect(ErrorCodes).toContain("media_extract_failed");
    expect(ErrorCodes).toContain("media_playlist_unsupported");
    expect(ErrorCodes).toContain("media_invalid_response");
  });

  it("contract version is at least 1.6.0 (Phase 11 media inspector is additive)", () => {
    expect(CONTRACT_VERSION >= "1.6.0").toBe(true);
  });
});

describe("v1.7 media pipeline (Phase 12)", () => {
  it("parses the mediaJob fixture", () => {
    const job = MediaJob.parse(domainFixture.mediaJob);
    expect(job.status).toBe("downloading");
    expect(job.container).toBe("mkv");
    expect(job.subtitles).toHaveLength(1);
    expect(job.destinationPath).toBeNull();
  });

  it("media.download params require at least one format and gate subtitles on video", () => {
    const base = {
      url: "https://example.com/watch/abc",
      destinationDir: "/home/user/Downloads",
    };
    expect(MediaDownloadParams.safeParse(base).success).toBe(false);
    expect(
      MediaDownloadParams.safeParse({ ...base, videoFormatId: "137", audioFormatId: "140" })
        .success,
    ).toBe(true);
    // container defaults to mkv
    expect(
      MediaDownloadParams.parse({ ...base, audioFormatId: "140" }).container,
    ).toBe("mkv");
    // subtitles without a video selection are refused
    const subs: MediaSubtitleSelection[] = [
      { language: "en", extension: "vtt", isAutoGenerated: false },
    ];
    expect(
      MediaDownloadParams.safeParse({ ...base, audioFormatId: "140", subtitles: subs }).success,
    ).toBe(false);
    expect(
      MediaDownloadParams.safeParse({ ...base, videoFormatId: "137", subtitles: subs }).success,
    ).toBe(true);
    // max 8 subtitle tracks
    const many = Array.from({ length: 9 }, (_, i) => ({
      language: `l${i}`,
      extension: "vtt",
      isAutoGenerated: false,
    }));
    expect(
      MediaDownloadParams.safeParse({ ...base, videoFormatId: "137", subtitles: many }).success,
    ).toBe(false);
  });

  it("container and job status enums are closed", () => {
    expect(MediaContainer.options).toEqual(["mkv", "mp4"]);
    expect(
      MediaJob.safeParse({ ...domainFixture.mediaJob, status: "teleporting" }).success,
    ).toBe(false);
    expect(
      MediaJob.safeParse({ ...domainFixture.mediaJob, container: "avi" }).success,
    ).toBe(false);
  });

  it("media.* methods register on the core server", () => {
    for (const m of [
      "media.download", "media.list", "media.get", "media.pause",
      "media.resume", "media.cancel", "media.remove",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
    }
  });

  it("media events register with core source", () => {
    expect(EVENTS["media.progress"].source).toBe("core");
    expect(EVENTS["media.updated"].source).toBe("core");
    const p = MediaProgress.parse(domainFixture.mediaProgress);
    expect(p.phase).toBe("downloading");
  });

  it("error codes stay append-only and gained the media pipeline codes", () => {
    expect(ErrorCodes).toContain("media_download_failed");
    expect(ErrorCodes).toContain("media_mux_failed");
    expect(ErrorCodes).toContain("media_format_not_found");
    expect(ErrorCodes).toContain("media_live_unsupported");
  });

  it("contract version advanced to 1.7.0", () => {
    expect(CONTRACT_VERSION).toBe("1.7.0");
  });
});
