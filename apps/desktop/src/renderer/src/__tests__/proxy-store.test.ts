import { beforeEach, describe, expect, it } from "vitest";
import type { ProxyProfilePublic } from "@unidm/contracts";
import { useProxyStore } from "../stores/proxy.js";
import { useDownloadsStore } from "../stores/downloads.js";
import { useBrowserStore } from "../stores/browser.js";
import type { BrowserTab, DownloadJob } from "@unidm/contracts";

/**
 * Phase 9 — renderer stores against a stubbed preload bridge: proxy CRUD + per-profile
 * test state, download.create carrying the chosen profile, download.setProxy, and
 * browser.tab.create/setProxy routing.
 */

type RpcCall = { method: string; params: unknown };
const calls: RpcCall[] = [];

function profileFixture(over: Partial<ProxyProfilePublic> = {}): ProxyProfilePublic {
  return {
    id: "01K33R2VQ7M4X8N6P5T9W1Z3C4",
    name: "Office exit",
    scheme: "http",
    host: "proxy.example.com",
    port: 3128,
    username: "user",
    password: null, // main always redacts
    bypassList: ["<local>"],
    ...over,
  } as ProxyProfilePublic;
}

function jobFixture(over: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T",
    url: "https://example.com/file.zip",
    destinationDir: "/tmp",
    destinationPath: null,
    status: "paused",
    totalBytes: null,
    receivedBytes: 0,
    etag: null,
    lastModified: null,
    contentType: null,
    speedBps: null,
    etaSeconds: null,
    errorCode: null,
    segmentCount: null,
    checksumActual: null,
    checksumVerified: null,
    recoveryCount: null,
    reboundAt: null,
    queuePosition: null,
    proxyProfileId: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...over,
  } as DownloadJob;
}

function tabFixture(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: "01JD8W3G5XQ9V4M2K7PZ6N8S0R",
    title: "about:blank",
    url: "about:blank",
    faviconUrl: null,
    status: "loading",
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
    isAudioMuted: false,
    isAudible: false,
    proxyProfileId: null,
    createdAt: 1700000000000,
    ...over,
  } as BrowserTab;
}

function rpcResult(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "proxy.list":
      return { profiles: [profileFixture()] };
    case "proxy.create":
      // The bridge validates the result against the contract: password is ALWAYS redacted
      // and ids must be ULIDs — exactly what main guarantees.
      return { profile: profileFixture({ name: (p.profile as { name: string }).name, id: "01AAAAAAAAAAAAAAAAAAAAAAAA" }) };
    case "proxy.update":
      return { profile: profileFixture({ ...(p.profile as object), password: null, id: String(p.id) }) };
    case "proxy.remove":
      return { removed: true };
    case "proxy.test":
      return { ok: true, latencyMs: 42, exitIp: "203.0.113.9", status: 200, errorCode: null };
    case "download.create":
      return { job: jobFixture({ url: String(p.url), proxyProfileId: (p.proxyProfileId as string) ?? null }) };
    case "download.setProxy":
      return { job: jobFixture({ id: String(p.id), proxyProfileId: p.proxyProfileId as string | null }) };
    case "browser.tab.create":
      return { tab: tabFixture({ proxyProfileId: (p.proxyProfileId as string) ?? null }) };
    case "browser.tab.setProxy":
      return { tab: tabFixture({ id: String(p.id), proxyProfileId: p.proxyProfileId as string | null }) };
    default:
      return {};
  }
}

beforeEach(() => {
  calls.length = 0;
  useProxyStore.setState({ profiles: [], loaded: true, testStates: {} });
  useDownloadsStore.setState({ jobs: [], loaded: true, core: "ready" });
  useBrowserStore.setState({ tabs: [], activeTabId: null });
  (globalThis as Record<string, unknown>).window = {
    unidm: {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve(rpcResult(method, params));
      },
      onEvent: () => () => undefined,
      emit: () => undefined,
    },
  };
});

describe("proxy store (Phase 9)", () => {
  it("loads redacted profiles and keeps the renderer secret-free", async () => {
    await useProxyStore.getState().load();
    expect(useProxyStore.getState().profiles[0]?.password).toBeNull();
  });

  it("create/update/remove proxy through the IPC surface and refresh state", async () => {
    await useProxyStore.getState().load(); // seeds the fixture profile
    const s = useProxyStore.getState();
    await s.create({ name: "N", scheme: "socks5", host: "h", port: 1080, username: null, password: "pw", bypassList: [] });
    expect(calls.at(-1)).toEqual({
      method: "proxy.create",
      params: { profile: { name: "N", scheme: "socks5", host: "h", port: 1080, username: null, password: "pw", bypassList: [] } },
    });
    expect(useProxyStore.getState().profiles.map((p) => p.id)).toContain("01AAAAAAAAAAAAAAAAAAAAAAAA");

    await s.update("01K33R2VQ7M4X8N6P5T9W1Z3C4", { name: "Renamed" });
    expect(calls.at(-1)?.method).toBe("proxy.update");
    expect(useProxyStore.getState().profiles.find((p) => p.id === "01K33R2VQ7M4X8N6P5T9W1Z3C4")?.name).toBe("Renamed");

    await s.remove("01AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(calls.at(-1)).toEqual({ method: "proxy.remove", params: { id: "01AAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(useProxyStore.getState().profiles.map((p) => p.id)).not.toContain("01AAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("test() records per-profile latency/exitIP or the classified failure", async () => {
    await useProxyStore.getState().test("01K33R2VQ7M4X8N6P5T9W1Z3C4");
    expect(calls.at(-1)).toEqual({
      method: "proxy.test",
      params: { profileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4" },
    });
    const state = useProxyStore.getState().testStates["01K33R2VQ7M4X8N6P5T9W1Z3C4"];
    expect(state).toMatchObject({ running: false, ok: true, latencyMs: 42, exitIp: "203.0.113.9" });
  });
});

describe("downloads store — proxy routing (Phase 9)", () => {
  it("create forwards the chosen profile id; omitted means direct", async () => {
    await useDownloadsStore.getState().create("https://example.com/a.zip", "~/Downloads", "01K33R2VQ7M4X8N6P5T9W1Z3C4");
    expect(calls.at(-1)).toMatchObject({
      method: "download.create",
      params: { url: "https://example.com/a.zip", destinationDir: "~/Downloads", proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4" },
    });
    await useDownloadsStore.getState().create("https://example.com/b.zip", "~/Downloads");
    expect(calls.at(-1)).toMatchObject({
      method: "download.create",
      params: { url: "https://example.com/b.zip", destinationDir: "~/Downloads", overwrite: false },
    });
    expect((calls.at(-1)!.params as Record<string, unknown>).proxyProfileId).toBeUndefined();
  });

  it("setProxy proxies to download.setProxy and upserts the job", async () => {
    await useDownloadsStore.getState().setProxy("01JD8W3G5XQ9V4M2K7PZ6N8S0T", "01K33R2VQ7M4X8N6P5T9W1Z3C4");
    expect(calls.at(-1)).toEqual({
      method: "download.setProxy",
      params: { id: "01JD8W3G5XQ9V4M2K7PZ6N8S0T", proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4" },
    });
    expect(useDownloadsStore.getState().jobs[0]?.proxyProfileId).toBe("01K33R2VQ7M4X8N6P5T9W1Z3C4");
  });
});

describe("browser store — proxied tabs (Phase 9)", () => {
  it("createTab forwards the profile id; setTabProxy upserts the recreated tab", async () => {
    await useBrowserStore.getState();
    const { createTab, setTabProxy } = await import("../stores/browser.js");
    await createTab(undefined, "01K33R2VQ7M4X8N6P5T9W1Z3C4");
    expect(calls.at(-1)).toMatchObject({
      method: "browser.tab.create",
      params: { activate: true, proxyProfileId: "01K33R2VQ7M4X8N6P5T9W1Z3C4" },
    });
    expect(useBrowserStore.getState().tabs[0]?.proxyProfileId).toBe("01K33R2VQ7M4X8N6P5T9W1Z3C4");

    await setTabProxy("01JD8W3G5XQ9V4M2K7PZ6N8S0R", null);
    expect(calls.at(-1)).toEqual({
      method: "browser.tab.setProxy",
      params: { id: "01JD8W3G5XQ9V4M2K7PZ6N8S0R", proxyProfileId: null },
    });
    expect(useBrowserStore.getState().tabs[0]?.proxyProfileId).toBeNull();
  });
});
