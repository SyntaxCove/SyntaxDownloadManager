import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DownloadJob, DownloadProgress, DownloadCreateParams, BrowserTab, AppSettings, MediaManifest,
  MediaInspectParams, MediaJob, MediaDownloadParams, MediaProgress, MediaContainer,
  MediaSubtitleSelection,
  TorrentJob, TorrentStatus, TorrentAddParams, TorrentProgress,
  RequestEnvelope, SuccessEnvelope, ErrorEnvelope, EventEnvelope,
  METHODS, EVENTS, CONTRACT_VERSION, PROTOCOL_VERSION, ErrorCodes,
  newUlid, ulidTime, normalizeUlid, Ulid, makeRequest, makeSuccess, makeError, makeEvent,
  ProxyProfileInput, ProxyProfilePublic, ProxyEndpoint, ProxyTestResult, DownloadSetProxyParams,
  TabSetProxyParams,
  ToolkitManifest, ToolkitStatusResult, ToolkitSetPathsParams, ToolkitToolStatus,
  HistoryEntry, HistoryListParams, Bookmark, RevealEntryParams,
  SchedulerJob, SchedulerAction, SchedulerRepeat, SchedulerCreateParams, SchedulerUpdateParams,
  SCHEDULER_PAYLOAD_SCHEMAS, SETTINGS_DEFAULTS,
  JobEndTracker, jobEndLabel, coreStateToast,
  UpdateState, UpdateStatus, UpdateUnavailableReason,
  CoreHealthSnapshot, LogRecord, DiagnosticsGetRecentLogsParams,
  DiagnosticsExportLogsParams, DiagnosticsExportLogsResult,
  PerformanceSnapshot, BootTimingReport, IpcCounters, BootPhase,
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
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(5);
    else expect(maj).toBeGreaterThan(1);
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
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(6);
    else expect(maj).toBeGreaterThan(1);
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

  it("contract version is at least 1.7.0 (Phase 12 media pipeline is additive)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(7);
    else expect(maj).toBeGreaterThan(1);
  });
});

describe("v1.8 torrent engine (Phase 13)", () => {
  it("parses the torrentJob fixture", () => {
    const job = TorrentJob.parse(domainFixture.torrentJob);
    expect(job.status).toBe("downloading");
    expect(job.sourceKind).toBe("torrent");
    expect(job.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(job.files).toHaveLength(1);
    expect(job.files[0].path).toBe("Sample Torrent/sample.txt");
    expect(job.errorCode).toBeNull();
  });

  it("torrent.add params require exactly one source kind", () => {
    const base = { destinationDir: "/home/user/Downloads" };
    expect(TorrentAddParams.safeParse(base).success).toBe(false);
    // any non-empty magnet string is accepted by the wire schema; the core classifies parse errors
    expect(
      TorrentAddParams.safeParse({ ...base, magnetUri: "magnet:?xt=urn:btih:X" }).success,
    ).toBe(true);
    expect(
      TorrentAddParams.safeParse({
        ...base,
        magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40),
      }).success,
    ).toBe(true);
    expect(
      TorrentAddParams.safeParse({ ...base, torrentFileB64: "ZGVmYXVsdA==" }).success,
    ).toBe(true);
    // both provided → refused
    expect(
      TorrentAddParams.safeParse({
        ...base,
        magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40),
        torrentFileB64: "ZGVmYXVsdA==",
      }).success,
    ).toBe(false);
  });

  it("torrent status enum is closed and gained queued/canceled", () => {
    expect(TorrentStatus.options).toEqual([
      "queued", "metadata", "downloading", "seeding", "paused", "completed", "failed",
      "canceled",
    ]);
    expect(
      TorrentJob.safeParse({ ...domainFixture.torrentJob, status: "teleporting" }).success,
    ).toBe(false);
    expect(
      TorrentJob.safeParse({ ...domainFixture.torrentJob, infoHash: "nothex" }).success,
    ).toBe(false);
  });

  it("torrent.* methods register on the core server", () => {
    for (const m of [
      "torrent.add", "torrent.list", "torrent.get", "torrent.pause",
      "torrent.resume", "torrent.cancel", "torrent.remove",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
    }
  });

  it("torrent events register with core source", () => {
    expect(EVENTS["torrent.progress"].source).toBe("core");
    expect(EVENTS["torrent.updated"].source).toBe("core");
    const p = TorrentProgress.parse(domainFixture.torrentProgress);
    expect(p.phase).toBe("downloading");
    expect(p.peers).toBe(7);
  });

  it("error codes stay append-only and gained the torrent codes", () => {
    expect(ErrorCodes).toContain("torrent_invalid_metainfo");
    expect(ErrorCodes).toContain("torrent_v2_unsupported");
    expect(ErrorCodes).toContain("torrent_metadata_timeout");
    expect(ErrorCodes).toContain("torrent_proxy_unsupported");
  });

  it("contract version is at least 1.9.0 (v1.10 continues additively)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(9);
    else expect(maj).toBeGreaterThan(1);
  });
});

describe("v1.9 browser history, bookmarks and library (Phase 14)", () => {
  it("the nine core methods and the reveal method are registered", () => {
    for (const m of [
      "browser.history.record",
      "browser.history.list",
      "browser.history.delete",
      "browser.history.clear",
      "browser.bookmark.create",
      "browser.bookmark.list",
      "browser.bookmark.getByUrl",
      "browser.bookmark.update",
      "browser.bookmark.remove",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
    }
    expect(METHODS["app.revealEntry"].server).toBe("main");
  });

  it("HistoryEntry requires a web url and always-serialized nullables", () => {
    expect(
      HistoryEntry.safeParse({
        id: "01JD8W3G5XQ9V4M2K7PZ6N8S0H",
        url: "https://example.com/x",
        title: null,
        faviconUrl: null,
        visitedAt: 1,
      }).success,
    ).toBe(true);
    expect(
      HistoryEntry.safeParse({
        id: "01JD8W3G5XQ9V4M2K7PZ6N8S0H",
        url: "ftp://example.com/x",
        title: null,
        faviconUrl: null,
        visitedAt: 1,
      }).success,
    ).toBe(false);
    expect(HistoryEntry.safeParse({ id: "01JD8W3G5XQ9V4M2K7PZ6N8S0H", url: "https://a.b/" }).success).toBe(false);
  });

  it("Bookmark enforces non-empty title and web url", () => {
    const valid = {
      id: "01JD8W3G5XQ9V4M2K7PZ6N8S0B",
      url: "https://example.com/x",
      title: "X",
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(Bookmark.safeParse(valid).success).toBe(true);
    expect(Bookmark.safeParse({ ...valid, title: "" }).success).toBe(false);
    expect(Bookmark.safeParse({ ...valid, url: "javascript:alert(1)" }).success).toBe(false);
  });

  it("history list params bound limit and require string query", () => {
    expect(HistoryListParams.safeParse({ limit: 500 }).success).toBe(true);
    expect(HistoryListParams.safeParse({ limit: 501 }).success).toBe(false);
    expect(HistoryListParams.safeParse({ query: "" }).success).toBe(false);
    expect(HistoryListParams.safeParse({}).success).toBe(true);
  });

  it("revealEntry params only accept the three kinds and two modes", () => {
    const base = { id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T" };
    expect(RevealEntryParams.safeParse({ ...base, kind: "download", mode: "folder" }).success).toBe(true);
    expect(RevealEntryParams.safeParse({ ...base, kind: "media", mode: "open" }).success).toBe(true);
    expect(RevealEntryParams.safeParse({ ...base, kind: "torrent", mode: "folder" }).success).toBe(true);
    expect(RevealEntryParams.safeParse({ ...base, kind: "other", mode: "folder" }).success).toBe(false);
    expect(RevealEntryParams.safeParse({ ...base, kind: "download", mode: "delete" }).success).toBe(false);
  });

  it("error codes stay append-only and gained the library codes", () => {
    expect(ErrorCodes).toContain("entry_path_unavailable");
    expect(ErrorCodes).toContain("file_missing");
  });

  it("fixtures parse against the new schemas (cross-language parity inputs)", () => {
    expect(HistoryEntry.parse(domainFixture.historyEntry).url).toBe("https://example.com/articles/syntaxdm");
    expect(Bookmark.parse(domainFixture.bookmark).position).toBe(0);
  });
});

describe("v1.10 scheduler jobs + automation (Phase 15)", () => {
  it("parses the schedulerJob fixture (cross-language parity input)", () => {
    const job = SchedulerJob.parse(domainFixture.schedulerJob);
    expect(job.kind).toBe("download.create");
    expect(job.repeat).toBe("daily");
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBe(1735776000000);
    expect(job.lastResultCode).toBe("ok");
    expect((job.payload as Record<string, unknown>).url).toBe("https://example.com/setup.exe");
  });

  it("nullable outcome fields are always serialized (null is valid, missing is not)", () => {
    const base = {
      id: "01K4SCHE0000000000000000AA",
      kind: "download.startAll",
      payload: {},
      startAt: 1000,
      repeat: "none",
      enabled: false,
      nextRunAt: null,
      lastFiredAt: null,
      lastResultCode: null,
      lastResultMessage: null,
      createdAt: 1,
      updatedAt: 2,
    } as const;
    expect(SchedulerJob.safeParse(base).success).toBe(true);
    for (const key of ["nextRunAt", "lastFiredAt", "lastResultCode", "lastResultMessage"]) {
      const { [key]: _omit, ...without } = base as Record<string, unknown>;
      expect(SchedulerJob.safeParse(without).success).toBe(false);
    }
    expect(SchedulerJob.safeParse({ ...base, kind: "media.inspect" }).success).toBe(false);
    expect(SchedulerJob.safeParse({ ...base, repeat: "monthly" }).success).toBe(false);
  });

  it("repeat enum preserves the v1 stub values verbatim", () => {
    expect(SchedulerRepeat.options).toEqual(["none", "daily", "weekly"]);
  });

  it("payload schemas per kind cover the closed action set exactly", () => {
    expect(SchedulerAction.options).toEqual([
      "download.create", "download.startAll", "download.pauseAll", "media.download",
      "torrent.add",
    ]);
    expect(Object.keys(SCHEDULER_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...SchedulerAction.options].sort(),
    );
  });

  it("create validates the payload against the row's kind", () => {
    const base = { startAt: 1735689600000, repeat: "daily" } as const;
    expect(
      SchedulerCreateParams.safeParse({
        ...base,
        kind: "download.create",
        payload: {
          url: "https://example.com/setup.exe",
          destinationDir: "/home/user/Downloads",
        },
      }).success,
    ).toBe(true);
    // a download.create payload missing destinationDir is rejected via superRefine
    expect(
      SchedulerCreateParams.safeParse({
        ...base, kind: "download.create", payload: { url: "https://example.com/x" },
      }).success,
    ).toBe(false);
    // torrent.add refinement: exactly one of magnetUri / torrentFileB64
    expect(
      SchedulerCreateParams.safeParse({
        ...base, kind: "torrent.add",
        payload: { magnetUri: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                   destinationDir: "/home/user/Downloads" },
      }).success,
    ).toBe(true);
    expect(
      SchedulerCreateParams.safeParse({
        ...base, kind: "torrent.add", payload: { destinationDir: "/home/user/Downloads" },
      }).success,
    ).toBe(false);
    // empty kinds reject unexpected payload keys
    expect(
      SchedulerCreateParams.safeParse({ ...base, kind: "download.startAll", payload: {} })
        .success,
    ).toBe(true);
    expect(
      SchedulerCreateParams.safeParse({ ...base, kind: "download.startAll", payload: { x: 1 } })
        .success,
    ).toBe(false);
  });

  it("update validates the patch shape and rejects unknown kinds in the row", () => {
    const id = "01K4SCHE0000000000000000AA";
    expect(
      SchedulerUpdateParams.safeParse({ id, patch: { enabled: false } }).success,
    ).toBe(true);
    expect(
      SchedulerUpdateParams.safeParse({ id, patch: { startAt: -1 } }).success,
    ).toBe(false);
    expect(
      SchedulerUpdateParams.safeParse({ id, patch: { repeat: "weekly" } }).success,
    ).toBe(true);
  });

  it("scheduler.* methods register on the core server; setClock is main→core only", () => {
    for (const m of [
      "scheduler.list", "scheduler.create", "scheduler.update", "scheduler.remove",
      "scheduler.runNow", "scheduler.setClock",
    ] as const) {
      expect(METHODS[m].server).toBe("core");
    }
  });

  it("the scheduler.updated event registers with core source", () => {
    expect(EVENTS["scheduler.updated"].source).toBe("core");
    expect(EVENTS["scheduler.updated"].payload.safeParse({ job: domainFixture.schedulerJob })
      .success).toBe(true);
  });

  it("contract version advanced to at least 1.10.0 (Phase 15 scheduler)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(10);
    else expect(maj).toBeGreaterThan(1);
  });
});

describe("v1.11 settings domain completion (Phase 16)", () => {
  it("appSettings gains defaultProxyProfileId defaulting to null", () => {
    expect(AppSettings.parse({}).defaultProxyProfileId).toBeNull();
    expect(SETTINGS_DEFAULTS.defaultProxyProfileId).toBeNull();
  });

  it("defaultProxyProfileId accepts a ULID and rejects everything else", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(AppSettings.parse({ defaultProxyProfileId: id }).defaultProxyProfileId).toBe(id);
    expect(AppSettings.parse({ defaultProxyProfileId: null }).defaultProxyProfileId).toBeNull();
    expect(AppSettings.safeParse({ defaultProxyProfileId: "not-a-ulid" }).success).toBe(false);
    expect(AppSettings.safeParse({ defaultProxyProfileId: 42 }).success).toBe(false);
  });

  it("the refreshed appSettings fixture parses with the profile reference", () => {
    expect(AppSettings.parse(domainFixture.appSettings).defaultProxyProfileId)
      .toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("download.create documents the app-default injection (omitted vs null vs explicit)", () => {
    // Omitted → the field stays absent; main injects the settings default (null default keeps
    // it absent). Explicit null is "direct"; an explicit id passes through verbatim.
    const omitted = DownloadCreateParams.parse({ url: "https://example.com/f.bin", destinationDir: "/tmp" });
    expect("proxyProfileId" in omitted).toBe(false);
    expect(DownloadCreateParams.parse({
      url: "https://example.com/f.bin", destinationDir: "/tmp", proxyProfileId: null,
    }).proxyProfileId).toBeNull();
    expect(DownloadCreateParams.parse({
      url: "https://example.com/f.bin", destinationDir: "/tmp", proxyProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }).proxyProfileId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("registers app.pickDirectory on the main server", () => {
    expect(METHODS["app.pickDirectory"].server).toBe("main");
    expect(METHODS["app.pickDirectory"].result?.safeParse({ path: "/home/u/Downloads" }).success)
      .toBe(true);
    expect(METHODS["app.pickDirectory"].result?.safeParse({ path: null }).success).toBe(true);
    expect(METHODS["app.pickDirectory"].result?.safeParse({ path: "" }).success).toBe(false);
  });

  it("contract version advanced to at least 1.12.0 (v1.13 continues additively)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(12);
    else expect(maj).toBeGreaterThan(1);
  });

  it("contract version advanced to at least 1.15.0 (Phase 22 perf domain is additive)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    if (maj === 1) expect(min).toBeGreaterThanOrEqual(15);
    else expect(maj).toBeGreaterThan(1);
  });
});

describe("v1.12 notifications + tray settings (Phase 17)", () => {
  it("notification keys default to on", () => {
    const defaults = AppSettings.parse({});
    expect(defaults.notifyOnComplete).toBe(true);
    expect(defaults.notifyOnFailure).toBe(true);
    expect(SETTINGS_DEFAULTS.notifyOnComplete).toBe(true);
    expect(SETTINGS_DEFAULTS.notifyOnFailure).toBe(true);
  });

  it("closeToTray defaults to true and only accepts booleans", () => {
    expect(AppSettings.parse({}).closeToTray).toBe(true);
    expect(SETTINGS_DEFAULTS.closeToTray).toBe(true);
    expect(AppSettings.parse({ closeToTray: false }).closeToTray).toBe(false);
    expect(AppSettings.safeParse({ closeToTray: "yes" }).success).toBe(false);
    expect(AppSettings.safeParse({ notifyOnComplete: 1 }).success).toBe(false);
    expect(AppSettings.safeParse({ notifyOnFailure: null }).success).toBe(false);
  });

  it("the refreshed appSettings fixture parses with the phase 17 keys", () => {
    const parsed = AppSettings.parse(domainFixture.appSettings);
    expect(parsed.notifyOnComplete).toBe(true);
    expect(parsed.notifyOnFailure).toBe(false);
    expect(parsed.closeToTray).toBe(true);
  });
});

describe("job end transitions (Phase 17)", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  it("notifies active→completed/failed exactly once per job", () => {
    const t = new JobEndTracker();
    expect(t.observe("download", id, "queued")).toBeNull();
    expect(t.observe("download", id, "probing")).toBeNull();
    expect(t.observe("download", id, "downloading")).toBeNull();
    const end = t.observe("download", id, "completed");
    expect(end).toEqual({ domain: "download", jobId: id, kind: "completed" });
    // repeat terminal snapshots never refire
    expect(t.observe("download", id, "completed")).toBeNull();
    expect(t.observe("download", id, "failed")).toBeNull();
  });

  it("stays silent for unknown previous statuses (boot snapshots, removals)", () => {
    const t = new JobEndTracker();
    expect(t.observe("media", id, "completed")).toBeNull();
    expect(t.observe("media", id, "failed")).toBeNull();
    expect(t.observe("media", id, "canceled")).toBeNull();
  });

  it("canceled is user-initiated and never notifies from any active status", () => {
    const t = new JobEndTracker();
    expect(t.observe("download", id, "downloading")).toBeNull();
    expect(t.observe("download", id, "canceled")).toBeNull();
    expect(t.observe("media", id, "queued")).toBeNull();
    expect(t.observe("media", id, "canceled")).toBeNull();
  });

  it("paused and resumed cycles only end-notify on a real end", () => {
    const t = new JobEndTracker();
    expect(t.observe("download", id, "downloading")).toBeNull();
    expect(t.observe("download", id, "paused")).toBeNull();
    expect(t.observe("download", id, "queued")).toBeNull(); // resume re-enters active
    expect(t.observe("download", id, "failed")).toEqual({ domain: "download", jobId: id, kind: "failed" });
  });

  it("a torrent finishes into seeding, not completed (completed = removal)", () => {
    const t = new JobEndTracker();
    expect(t.observe("torrent", id, "metadata")).toBeNull();
    expect(t.observe("torrent", id, "downloading")).toBeNull();
    // finalize_completion sets `seeding` — the real download-finished moment.
    expect(t.observe("torrent", id, "seeding")).toEqual({ domain: "torrent", jobId: id, kind: "completed" });
    expect(t.observe("torrent", id, "seeding")).toBeNull();
    // Removal-time `completed` (and removal of a downloading row) never notifies.
    expect(t.observe("torrent", id, "completed")).toBeNull();
    const t2 = new JobEndTracker();
    expect(t2.observe("torrent", id, "downloading")).toBeNull();
    expect(t2.observe("torrent", id, "completed")).toBeNull();
  });

  it("media extracting/muxing are active; failed carries the classification", () => {
    const t = new JobEndTracker();
    expect(t.observe("media", id, "extracting")).toBeNull();
    expect(t.observe("media", id, "downloading")).toBeNull();
    expect(t.observe("media", id, "muxing")).toBeNull();
    expect(t.observe("media", id, "failed")).toEqual({ domain: "media", jobId: id, kind: "failed" });
  });

  it("trackers keep domains and jobs independent; map survives as restart dedupe", () => {
    const t = new JobEndTracker();
    expect(t.observe("download", id, "downloading")).toBeNull();
    expect(t.observe("media", id, "completed")).toBeNull(); // different domain, unknown prev
    const other = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    expect(t.observe("download", other, "completed")).toBeNull();
    expect(t.tracked("download", id)).toBe(true);
    expect(t.tracked("media", id)).toBe(true);
    expect(t.tracked("download", other)).toBe(true);
  });

  it("jobEndLabel basenames, handles backslashes and truncates", () => {
    expect(jobEndLabel("download", { destinationPath: "/home/u/Files/setup.exe" })).toBe("setup.exe");
    expect(jobEndLabel("download", { destinationPath: "C:\\Users\\u\\video.mp4" })).toBe("video.mp4");
    expect(jobEndLabel("media", { title: "My Video" })).toBe("My Video");
    expect(jobEndLabel("torrent", { name: null, infoHash: "a".repeat(40) })).toBe("a".repeat(40));
    const long = "x".repeat(200);
    expect(jobEndLabel("download", { url: `https://e.com/${long}` }).length).toBe(120);
  });

  it("coreStateToast: boot stays silent, interruptions toast once", () => {
    expect(coreStateToast(undefined, "starting")).toBeNull();
    expect(coreStateToast("starting", "ready")).toBeNull();
    expect(coreStateToast("starting", "restarting")).toBeNull(); // never entered ready
    const restart = coreStateToast("ready", "restarting");
    expect(restart?.intent).toBe("info");
    expect(coreStateToast("restarting", "ready")).toBeNull();
    const down = coreStateToast("ready", "unavailable");
    expect(down?.intent).toBe("error");
    expect(coreStateToast("unavailable", "unavailable")).toBeNull(); // no-op
  });
});

describe("v1.13 auto-update channel (Phase 18)", () => {
  it("contract version advanced to at least 1.13.0 (Phase 18 updates are additive)", () => {
    const [maj, min] = CONTRACT_VERSION.split(".").map(Number);
    expect(maj).toBe(1);
    expect(min).toBeGreaterThanOrEqual(13);
  });

  it("updateState fixture parses with the full snapshot shape", () => {
    const state = UpdateState.parse(domainFixture.updateState);
    expect(state.status).toBe("downloaded");
    expect(state.currentVersion).toBe("0.5.0");
    expect(state.availableVersion).toBe("0.6.0");
    expect(state.progress?.percent).toBe(100);
    expect(state.errorCode).toBeNull();
    expect(state.unavailableReason).toBeNull();
  });

  it("update.state event is main-sourced; the four methods are main-served", () => {
    expect(EVENTS["update.state"].source).toBe("main");
    for (const m of ["update.getState", "update.check", "update.download", "update.install"] as const) {
      expect(METHODS[m].server).toBe("main");
    }
  });

  it("update error codes are registered and append-only at the tail", () => {
    const tail = ErrorCodes.slice(-5);
    expect(tail).toEqual([
      "update_feed_invalid",
      "update_check_failed",
      "update_download_failed",
      "update_install_failed",
      "update_not_downloaded",
    ]);
  });

  it("appSettings fixture gains updateAutoCheck; legacy settings default to true", () => {
    expect(domainFixture.appSettings.updateAutoCheck).toBe(true);
    const legacy = AppSettings.parse({ ...domainFixture.appSettings, updateAutoCheck: undefined });
    expect(legacy.updateAutoCheck).toBe(true);
    expect(SETTINGS_DEFAULTS.updateAutoCheck).toBe(true);
  });

  it("releaseNotes are capped at 4000 chars; statuses/reasons are closed enums", () => {
    expect(UpdateState.shape.releaseNotes.parse("x".repeat(4000))).toHaveLength(4000);
    expect(() => UpdateState.shape.releaseNotes.parse("x".repeat(4001))).toThrow();
    expect(UpdateStatus.options).toContain("downloaded");
    expect(UpdateUnavailableReason.options).toEqual(["not_packaged", "no_feed"]);
  });

  it("progress values are bounded; lastCheckedAt is a non-negative epoch", () => {
    const base = {
      status: "downloading",
      unavailableReason: null,
      currentVersion: "0.5.0",
      availableVersion: null,
      releaseDate: null,
      releaseNotes: null,
      progress: { percent: 50, transferredBytes: 10, totalBytes: 20, bytesPerSecond: 5 },
      errorCode: null,
      message: null,
      lastCheckedAt: 1791000000000,
    };
    expect(UpdateState.parse(base).status).toBe("downloading");
    expect(() => UpdateState.parse({ ...base, progress: { ...base.progress, percent: 101 } })).toThrow();
    expect(() => UpdateState.parse({ ...base, lastCheckedAt: -1 })).toThrow();
  });
});

describe("diagnostics (Phase 20)", () => {
  it("core health fixture parses and round-trips the exact wire shape", () => {
    const snap = CoreHealthSnapshot.parse(domainFixture.diagnosticsCoreHealth);
    expect(snap.dbQuickCheck).toBe("ok");
    expect(snap.jobsByStatus["downloading"]).toBe(1);
    expect(snap.counts.historyEntries).toBe(42);
    // Deterministic wire shape: what TS parsed is byte-equal to what it re-serializes.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(domainFixture.diagnosticsCoreHealth);
  });

  it("log records are level-closed and bounded; the tail request clamps its inputs", () => {
    const rec = { ts: 1791000000000, level: "warn", component: "supervisor", msg: "core exited" };
    expect(LogRecord.parse(rec).level).toBe("warn");
    expect(() => LogRecord.parse({ ...rec, level: "verbose" })).toThrow();
    expect(() => LogRecord.parse({ ...rec, msg: "x".repeat(2001) })).toThrow();
    // Range violations are rejected (validation, not clamping); omission falls back to 200.
    expect(() => DiagnosticsGetRecentLogsParams.parse({ level: "error", limit: 9000 })).toThrow();
    expect(() => DiagnosticsGetRecentLogsParams.parse({ limit: 5 })).toThrow();
    expect(DiagnosticsGetRecentLogsParams.parse({}).limit).toBe(200);
  });

  it("export requires a consented directory; results carry the written zip path", () => {
    expect(DiagnosticsExportLogsParams.parse({ directory: "/tmp/diag" }).directory).toBe("/tmp/diag");
    expect(() => DiagnosticsExportLogsParams.parse({ directory: "" })).toThrow();
    const res = DiagnosticsExportLogsResult.parse({ path: "/tmp/diag/syntaxdm-diagnostics-1.zip", bytes: 10 });
    expect(res.bytes).toBe(10);
  });
});

describe("performance (Phase 22, v1.15)", () => {
  it("perf.getSnapshot is registered as main-served with bounded result schemas", () => {
    expect(METHODS["perf.getSnapshot"].server).toBe("main");
    expect(METHODS["perf.getSnapshot"].params?.safeParse({}).success).toBe(true);
  });

  it("the performanceSnapshot fixture parses and round-trips the exact wire shape", () => {
    const snap = PerformanceSnapshot.parse(domainFixture.performanceSnapshot);
    expect(snap.boot.totalToCoreReadyMs).toBe(142);
    expect(snap.boot.coreSpawnToReadyMs).toBe(41);
    expect(snap.coreRssBytes).toBe(17584128);
    expect(snap.ipc.requestsServed).toBe(12);
    // Deterministic wire shape: what TS parsed is byte-equal to what it re-serializes.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(domainFixture.performanceSnapshot);
  });

  it("pre-ready snapshots are legal: core-derived fields are nullable", () => {
    const pre = PerformanceSnapshot.parse({
      boot: { phases: [{ phase: "app-ready", durationMs: 88 }], totalToCoreReadyMs: null, coreSpawnToReadyMs: null, recordedAt: 1791000000000 },
      ipc: { requestsServed: 0, eventsEmitted: 1, invalidDropped: 0 },
      mainRssBytes: 120000000,
      coreRssBytes: null,
      sampledAt: 1791000000001,
    });
    expect(pre.boot.coreSpawnToReadyMs).toBeNull();
    expect(pre.coreRssBytes).toBeNull();
  });

  it("boot phases are a closed enum; negative durations are rejected", () => {
    expect(BootPhase.options).toEqual([
      "main-modules-evaluated", "app-ready", "window-created", "core-spawned", "core-ready",
    ]);
    expect(() =>
      BootTimingReport.parse({
        phases: [{ phase: "app-ready", durationMs: -1 }],
        totalToCoreReadyMs: null, coreSpawnToReadyMs: null, recordedAt: 0,
      }),
    ).toThrow();
    // Unknown phases cannot enter the wire.
    expect(() =>
      BootTimingReport.parse({
        phases: [{ phase: "first-paint", durationMs: 5 }],
        totalToCoreReadyMs: null, coreSpawnToReadyMs: null, recordedAt: 0,
      }),
    ).toThrow();
  });

  it("ipc counters are integer-bounded and monotonic-shaped", () => {
    const c = IpcCounters.parse({ requestsServed: 3, eventsEmitted: 7, invalidDropped: 1 });
    expect(c.requestsServed).toBe(3);
    expect(() => IpcCounters.parse({ requestsServed: 1.5, eventsEmitted: 0, invalidDropped: 0 })).toThrow();
    expect(() => IpcCounters.parse({ requestsServed: -1, eventsEmitted: 0, invalidDropped: 0 })).toThrow();
  });
});
