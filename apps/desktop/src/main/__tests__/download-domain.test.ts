import { describe, expect, it, vi } from "vitest";
import {
  METHODS, SETTINGS_DEFAULTS, SuccessEnvelope, makeRequest, newUlid,
  type DownloadCreateParams, type DownloadJob,
} from "@syntaxdm/contracts";
import { applyDefaultProxy, registerDownloadDomain } from "../domains/download.js";
import { SettingsStore } from "../domains/settings.js";
import { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 16 — download domain: every method is a validated passthrough except
 * `download.create`, which injects the settings-level default proxy into requests that
 * OMIT `proxyProfileId`. Explicit null stays "direct"; an explicit id passes verbatim.
 * Injection is main-side: the Rust core never learns settings (plan non-goal).
 */

const PROFILE_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROFILE_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

const jobFixture = (id: string): DownloadJob => ({
  id,
  url: "https://example.com/f.bin",
  destinationDir: "/tmp",
  destinationPath: null,
  status: "queued",
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
  createdAt: 1735689600000,
  updatedAt: 1735689600000,
});

function settingsStub(defaultProxyProfileId: string | null): SettingsStore {
  return {
    settings: { ...SETTINGS_DEFAULTS, defaultProxyProfileId },
  } as unknown as SettingsStore;
}

function makeRouter(defaultProxyProfileId: string | null): {
  router: IpcRouter;
  supervisor: CoreSupervisor;
} {
  const router = new IpcRouter((msg) => console.log(msg));
  const supervisor = {
    request: vi.fn(async (_method: string, params: unknown) => ({ job: jobFixture(newUlid()) })),
    on: vi.fn(),
  } as unknown as CoreSupervisor;
  registerDownloadDomain(router, supervisor, settingsStub(defaultProxyProfileId));
  return { router, supervisor };
}

const createParams: DownloadCreateParams = {
  url: "https://example.com/f.bin",
  destinationDir: "/tmp",
  overwrite: false,
};

describe("applyDefaultProxy (pure)", () => {
  it("injects the default only when the field is absent", () => {
    const injected = applyDefaultProxy(createParams, PROFILE_A);
    expect(injected.proxyProfileId).toBe(PROFILE_A);

    const noDefault = applyDefaultProxy(createParams, null);
    expect("proxyProfileId" in noDefault).toBe(false);
  });

  it("keeps an explicit null (direct) and an explicit profile verbatim", () => {
    expect(applyDefaultProxy({ ...createParams, proxyProfileId: null }, PROFILE_A).proxyProfileId)
      .toBeNull();
    expect(
      applyDefaultProxy({ ...createParams, proxyProfileId: PROFILE_B }, PROFILE_A).proxyProfileId,
    ).toBe(PROFILE_B);
  });
});

describe("download.create default-proxy injection over IPC", () => {
  it("omitted + configured default → main injects the profile before the core sees it", async () => {
    const { router, supervisor } = makeRouter(PROFILE_A);
    const res = (await router.handleRequest(
      makeRequest(newUlid(), "download.create", createParams),
      {},
    )) as SuccessEnvelope;
    expect(res.ok).toBe(true);
    // The router parses params first, so zod defaults (overwrite: false) ride along —
    // the injected proxy rides on the PARSED shape, exactly what the core receives.
    expect(supervisor.request).toHaveBeenCalledWith(
      "download.create",
      { ...createParams, overwrite: false, proxyProfileId: PROFILE_A },
    );
  });

  it("omitted + no default (null) → the wire shape is unchanged (field absent)", async () => {
    const { router, supervisor } = makeRouter(null);
    await router.handleRequest(makeRequest(newUlid(), "download.create", createParams), {});
    const [, forwarded] = (supervisor.request as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect("proxyProfileId" in forwarded).toBe(false);
  });

  it("explicit null stays direct; explicit profile passes through untouched", async () => {
    const { router, supervisor } = makeRouter(PROFILE_A);
    await router.handleRequest(
      makeRequest(newUlid(), "download.create", { ...createParams, proxyProfileId: null }),
      {},
    );
    await router.handleRequest(
      makeRequest(newUlid(), "download.create", { ...createParams, proxyProfileId: PROFILE_B }),
      {},
    );
    const calls = (supervisor.request as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { proxyProfileId?: string | null }]
    >;
    expect(calls[0]![1].proxyProfileId).toBeNull();
    expect(calls[1]![1].proxyProfileId).toBe(PROFILE_B);
  });

  it("every other download method remains a pure passthrough", async () => {
    const { router, supervisor } = makeRouter(PROFILE_A);
    await router.handleRequest(makeRequest(newUlid(), "download.list", {}), {});
    expect(supervisor.request).toHaveBeenCalledWith("download.list", {});
  });

  it("an invalid default in settings can never reach the wire (settings schema guards it)", () => {
    // SettingsStore persists only schema-valid values (AppSettings.parse on update/load);
    // this assertion documents the boundary: the injected value is a Ulid or null.
    expect(METHODS["download.create"].params!.safeParse({
      ...createParams,
      proxyProfileId: "not-a-ulid",
    }).success).toBe(false);
  });
});
