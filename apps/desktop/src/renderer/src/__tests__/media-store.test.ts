import { beforeEach, describe, expect, it } from "vitest";
import { useMediaStore } from "../stores/media.js";
import type { MediaJob, MediaManifest } from "@unidm/contracts";

/**
 * Phase 11/12 — media store against a stubbed preload bridge: inspect lifecycle
 * (idle → inspecting → ready / error), the params actually sent over IPC, and the
 * persistent media-job lifecycle (create/pause/resume/cancel/remove + event patches).
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];

const jobFixture = (patch: Partial<MediaJob> = {}): MediaJob => ({
  id: "01JD8W3G5XQ9V4M2K7PZ6N8S0V",
  sourceUrl: "https://example.com/watch/abc",
  title: "Sample Video",
  thumbnailUrl: null,
  videoFormatId: "137",
  audioFormatId: "140",
  subtitles: [],
  container: "mkv",
  destinationDir: "/home/user/Downloads",
  destinationPath: null,
  workDir: null,
  status: "queued",
  totalBytes: null,
  receivedBytes: 0,
  speedBps: null,
  etaSeconds: null,
  errorCode: null,
  proxyProfileId: null,
  createdAt: 1735689600000,
  updatedAt: 1735689600000,
  ...patch,
});

const manifestFixture: MediaManifest = {
  sourceUrl: "https://example.com/watch/abc",
  extractor: "yt-dlp",
  title: "Sample Video",
  durationSeconds: 212.5,
  webpageUrl: "https://example.com/watch/abc",
  thumbnailUrl: null,
  isLive: false,
  videos: [
    {
      formatId: "137",
      container: "mp4",
      extension: "mp4",
      width: 1920,
      height: 1080,
      fps: 30.0,
      vcodec: "avc1.640028",
      acodec: null,
      vbitrateBps: 4500000,
      fileSizeBytes: 118000000,
    },
  ],
  audios: [],
  subtitles: [],
};


let coreError: { code: string; message: string } | null = null;

function rpcResult(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "media.list":
      return { jobs: useMediaStore.getState().jobs };
    case "media.download":
      return { job: jobFixture({ status: "queued" }) };
    case "media.pause":
      return { job: jobFixture({ status: "paused" }) };
    case "media.resume":
    case "media.cancel":
      return { job: jobFixture({ status: "queued" }) };
    case "media.remove":
      useMediaStore.setState({
        jobs: useMediaStore.getState().jobs.filter((j) => j.id !== String(p.id)),
      });
      return { removed: true };
    default:
      return {};
  }
}

beforeEach(() => {
  calls.length = 0;
  coreError = null;
  useMediaStore.setState({
    phase: "idle",
    url: "",
    manifest: null,
    error: null,
    jobs: [],
    jobsLoaded: false,
    selection: { videoFormatId: null, audioFormatId: null, subtitles: [], container: "mkv" },
  });
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "media.inspect") {
          if (coreError) return Promise.reject(coreError);
          return Promise.resolve({ manifest: manifestFixture });
        }
        return Promise.resolve(rpcResult(method, params));
      },
      onEvent: () => () => undefined,
      emit: () => undefined,
    },
  };
});

describe("media store (Phase 11)", () => {
  it("inspect sends the trimmed URL through media.inspect and lands on ready", async () => {
    useMediaStore.setState({ url: "  https://example.com/watch/abc  " });
    await useMediaStore.getState().inspect();
    expect(calls[0]?.method).toBe("media.inspect");
    expect(calls[0]?.params).toEqual({ url: "https://example.com/watch/abc" });
    const s = useMediaStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.manifest?.title).toBe("Sample Video");
  });

  it("passes the proxy profile id when one is chosen", async () => {
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    await useMediaStore.getState().inspect("01K33R2VQ7M4X8N6P5T9W1Z3C4");
    expect(calls[0]?.params).toEqual({
      url: "https://example.com/watch/abc",
      proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4",
    });
  });

  it("omits proxyProfileId entirely for direct inspection", async () => {
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    await useMediaStore.getState().inspect(undefined);
    expect(calls[0]?.params).toEqual({ url: "https://example.com/watch/abc" });
  });

  it("classified failures surface as phase=error with the code in the message", async () => {
    coreError = { code: "media_tool_missing", message: "install yt-dlp from Settings" };
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    await useMediaStore.getState().inspect();
    const s = useMediaStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toContain("media_tool_missing");
    expect(s.manifest).toBeNull();
  });

  it("never double-fires while an inspection is in flight", async () => {
    useMediaStore.setState({ url: "https://example.com/watch/abc" });
    const first = useMediaStore.getState().inspect();
    const second = useMediaStore.getState().inspect();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
  });

  it("ignores empty URLs without touching the bridge", async () => {
    useMediaStore.setState({ url: "   " });
    await useMediaStore.getState().inspect();
    expect(calls).toHaveLength(0);
    expect(useMediaStore.getState().phase).toBe("idle");
  });
});

describe("media store (Phase 12 pipeline)", () => {
  it("loadJobs mirrors media.list and marks the store loaded", async () => {
    useMediaStore.setState({ jobs: [jobFixture({ status: "downloading" })] });
    await useMediaStore.getState().loadJobs();
    const s = useMediaStore.getState();
    expect(calls[0]?.method).toBe("media.list");
    expect(s.jobsLoaded).toBe(true);
    expect(s.jobs[0]?.status).toBe("downloading");
  });

  it("download sends the selection, destination and container (omitting empty fields)", async () => {
    useMediaStore.setState({
      selection: {
        videoFormatId: "137",
        audioFormatId: "140",
        subtitles: [{ language: "en", extension: "vtt", isAutoGenerated: false }],
        container: "mp4",
      },
    });
    await useMediaStore
      .getState()
      .download({ url: "https://example.com/watch/abc", destinationDir: "/home/user/Downloads" });
    const dl = calls.find((c) => c.method === "media.download");
    expect(dl?.params).toEqual({
      url: "https://example.com/watch/abc",
      destinationDir: "/home/user/Downloads",
      videoFormatId: "137",
      audioFormatId: "140",
      subtitles: [{ language: "en", extension: "vtt", isAutoGenerated: false }],
      container: "mp4",
    });
    // the job list is refreshed afterwards
    expect(calls.some((c) => c.method === "media.list")).toBe(true);
  });

  it("download with an audio-only selection omits videoFormatId and subtitles entirely", async () => {
    useMediaStore.setState({
      selection: { videoFormatId: null, audioFormatId: "140", subtitles: [], container: "mkv" },
    });
    await useMediaStore
      .getState()
      .download({ url: "https://example.com/watch/abc", destinationDir: "/d" });
    const dl = calls.find((c) => c.method === "media.download");
    const params = dl?.params as Record<string, unknown>;
    expect("videoFormatId" in params).toBe(false);
    expect("subtitles" in params).toBe(false);
    expect(params["audioFormatId"]).toBe("140");
  });

  it("pause/resume/cancel upsert the returned authoritative job", async () => {
    useMediaStore.setState({ jobs: [jobFixture({ status: "downloading" })] });
    await useMediaStore.getState().pause("01JD8W3G5XQ9V4M2K7PZ6N8S0V");
    expect(useMediaStore.getState().jobs[0]?.status).toBe("paused");
    await useMediaStore.getState().resume("01JD8W3G5XQ9V4M2K7PZ6N8S0V");
    expect(useMediaStore.getState().jobs[0]?.status).toBe("queued");
    await useMediaStore.getState().cancel("01JD8W3G5XQ9V4M2K7PZ6N8S0V");
    expect(useMediaStore.getState().jobs[0]?.status).toBe("queued");
    expect(calls[0]?.method).toBe("media.pause");
    expect(calls[1]?.method).toBe("media.resume");
    expect(calls[2]?.method).toBe("media.cancel");
  });

  it("remove drops the job locally without deleteFiles by default", async () => {
    useMediaStore.setState({ jobs: [jobFixture()] });
    await useMediaStore.getState().remove("01JD8W3G5XQ9V4M2K7PZ6N8S0V", false);
    expect(useMediaStore.getState().jobs).toHaveLength(0);
    expect(calls[0]?.params).toEqual({ id: "01JD8W3G5XQ9V4M2K7PZ6N8S0V", deleteFiles: false });
  });

  it("upsertJob inserts new jobs at the head and replaces existing by id", () => {
    const a = jobFixture({ id: "01JD8W3G5XQ9V4M2K7PZ6N8S0A" });
    const b = jobFixture({ id: "01JD8W3G5XQ9V4M2K7PZ6N8S0B" });
    useMediaStore.getState().upsertJob(a);
    useMediaStore.getState().upsertJob(b);
    expect(useMediaStore.getState().jobs.map((j) => j.id)).toEqual([b.id, a.id]);
    useMediaStore.getState().upsertJob(jobFixture({ id: a.id, status: "completed" }));
    const jobs = useMediaStore.getState().jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id === a.id)?.status).toBe("completed");
  });

  it("patchProgress patches live fields without touching the selection columns", () => {
    useMediaStore.setState({
      jobs: [jobFixture({ status: "downloading", receivedBytes: 0, totalBytes: 150 })],
    });
    useMediaStore.getState().patchProgress({
      jobId: "01JD8W3G5XQ9V4M2K7PZ6N8S0V",
      phase: "downloading",
      receivedBytes: 90,
      totalBytes: 150,
      speedBps: 10,
      etaSeconds: 6,
    });
    const job = useMediaStore.getState().jobs[0];
    expect(job?.receivedBytes).toBe(90);
    expect(job?.speedBps).toBe(10);
    expect(job?.etaSeconds).toBe(6);
    expect(job?.videoFormatId).toBe("137");
  });
});
