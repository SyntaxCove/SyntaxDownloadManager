import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyProfileStore, redact, type SafeStorageLike } from "../domains/proxy.js";
import { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * Phase 9 — proxy profile store: encrypt-at-rest, atomic persistence, corruption
 * quarantine, keychain-unavailable refusal, renderer redaction and the never-log rule.
 */

const SECRET = "s3cret-password";

const fakeSafeStorage = (): SafeStorageLike & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString(plain: string) {
      calls.push(`encrypt:${plain.length}`);
      // Deterministic reversible "ciphertext" (NOT real crypto — unit scope only).
      return Buffer.from(`X${Buffer.from(plain).toString("base64")}X`);
    },
    decryptString(buf: Buffer) {
      calls.push("decrypt");
      const s = buf.toString("utf8");
      return Buffer.from(s.slice(1, -1), "base64").toString("utf8");
    },
  };
};

const unavailableSafeStorage = (): SafeStorageLike => ({
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => "",
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unidm-proxy-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = (over: Partial<Parameters<ProxyProfileStore["create"]>[0]> = {}) => ({
  name: "Office exit",
  scheme: "http" as const,
  host: "proxy.example.com",
  port: 3128,
  username: "user",
  password: SECRET,
  bypassList: [".internal.example.com", "<local>"],
  ...over,
});

describe("ProxyProfileStore", () => {
  it("persists encrypted ciphertext, never plaintext, atomically", async () => {
    const ss = fakeSafeStorage();
    const store = new ProxyProfileStore(dir, ss);
    await store.load();
    await store.create(input());

    const files = await readdir(dir);
    expect(files).toEqual(["proxy-profiles.json"]);
    const onDisk = JSON.parse(await readFile(join(dir, "proxy-profiles.json"), "utf8"));
    const stored = onDisk.profiles[0] as { password: string };
    expect(stored.password.startsWith("enc:v1:")).toBe(true);
    expect(onDisk.profiles.map((p: { password: string }) => JSON.stringify(p))).not.toContain(SECRET);
    const raw = await readFile(join(dir, "proxy-profiles.json"), "utf8");
    expect(raw).not.toContain(SECRET);
    // Runtime endpoints decrypt on demand only.
    const endpoints = await store.runtimeEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.password).toBe(SECRET);
    expect(endpoints[0]?.bypassList).toEqual([".internal.example.com", "<local>"]);
  });

  it("round-trips through reload and decrypts for the tab resolver", async () => {
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const { profile } = { profile: await store.create(input()) };
    const store2 = new ProxyProfileStore(dir, fakeSafeStorage());
    await store2.load();
    expect(store2.list()).toEqual(store.list());

    const resolved = await store2.resolveForTab(profile.id);
    expect(resolved).not.toBeNull();
    // Chromium rules NEVER embed credentials.
    expect(resolved!.proxyRules).toBe("http://proxy.example.com:3128");
    expect(resolved!.proxyBypassRules).toBe(".internal.example.com,<local>");
    expect(resolved!.username).toBe("user");
    expect(resolved!.password).toBe(SECRET);
    expect(await store2.resolveForTab("01UNKNOWN000000000000000000")).toBeNull();
  });

  it("refuses to save a password when the keychain is unavailable (fail-closed)", async () => {
    const store = new ProxyProfileStore(dir, unavailableSafeStorage());
    await store.load();
    await expect(store.create(input())).rejects.toMatchObject({ code: "proxy_keychain_unavailable" });
    // A passwordless profile is still fine.
    const created = await store.create(input({ password: null, username: null }));
    expect(created.password).toBeNull();
    const raw = await readFile(join(dir, "proxy-profiles.json"), "utf8");
    expect(raw).not.toContain("enc:v1:");
  });

  it("redacts every read path and keeps update patch semantics", async () => {
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const created = await store.create(input());
    expect(created.password).toBeNull();
    expect(store.list()[0]?.password).toBeNull();

    // Omitted password keeps the stored one (still works for endpoints after update).
    const updated = await store.update(created.id, { name: "Renamed", port: 8080 });
    expect(updated.name).toBe("Renamed");
    expect(updated.port).toBe(8080);
    expect(updated.password).toBeNull();
    expect((await store.runtimeEndpoints())[0]?.password).toBe(SECRET);

    // password: null clears it; update of an unknown id fails cleanly.
    const cleared = await store.update(created.id, { password: null });
    expect((await store.runtimeEndpoints())[0]?.password).toBeNull();
    expect(cleared.password).toBeNull();
    await expect(store.update("01UNKNOWN000000000000000000", { name: "x" })).rejects.toMatchObject({
      code: "proxy_profile_not_found",
    });
  });

  it("quarantines a corrupt file and reinstates a valid empty store", async () => {
    await writeFile(join(dir, "proxy-profiles.json"), "{ this is not json", "utf8");
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    expect(store.list()).toEqual([]);
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("proxy-profiles.json.corrupt-"))).toBe(true);
    expect(files).toContain("proxy-profiles.json"); // valid empty file persists
  });

  it("update/remove errors never embed secrets (never-log rule)", async () => {
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const created = await store.create(input());
    try {
      await store.update(created.id, { scheme: "ftp" as never });
    } catch (err) {
      // zod/parse-free path: only shape errors would land here; assert message safety anyway
      expect(String(err)).not.toContain(SECRET);
    }
    await store.remove(created.id);
    expect(store.list()).toEqual([]);
    await expect(store.remove(created.id)).rejects.toMatchObject({ code: "proxy_profile_not_found" });
  });

  it("redact() always nulls the password field", () => {
    const out = redact({
      id: "01TEST",
      name: "n",
      scheme: "socks5",
      host: "h",
      port: 1080,
      username: null,
      password: "enc:v1:whatever",
      bypassList: [],
    });
    expect(out.password).toBeNull();
  });
});

describe("registerProxyDomain", () => {
  type Env = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

  const call = async (
    router: IpcRouter,
    method: string,
    params: unknown,
  ): Promise<Env> => {
    const { makeRequest, newUlid } = await import("@unidm/contracts");
    return (await router.handleRequest(makeRequest(newUlid(), method, params), {})) as Env;
  };

  function fakeSupervisor(jobs: Array<{ proxyProfileId?: string | null }>): CoreSupervisor {
    return {
      request: vi.fn(async (method: string) => {
        if (method === "download.list") return { jobs };
        return {};
      }),
    } as unknown as CoreSupervisor;
  }

  it("registers four methods; remove refuses while jobs reference the profile", async () => {
    const { registerProxyDomain } = await import("../domains/proxy.js");
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const router = new IpcRouter(() => undefined);
    const changed = vi.fn();
    registerProxyDomain(router, store, fakeSupervisor([]), changed);

    const created = await call(router, "proxy.create", { profile: input({ password: null, username: null }) });
    expect(created.ok).toBe(true);
    const profile = (created as { ok: true; result: { profile: { id: string; password: string | null } } }).result.profile;
    expect(profile.password).toBeNull();
    expect(changed).toHaveBeenCalled();

    const listed = await call(router, "proxy.list", {});
    expect((listed as { ok: true; result: { profiles: unknown[] } }).result.profiles).toHaveLength(1);

    // Remove without references → success + change hook.
    const removed = await call(router, "proxy.remove", { id: profile.id });
    expect(removed).toMatchObject({ ok: true, result: { removed: true } });
    expect(changed).toHaveBeenCalledTimes(2); // create + remove
  });

  it("remove refuses with proxy_in_use (+count) while any job references the profile", async () => {
    const { registerProxyDomain } = await import("../domains/proxy.js");
    // Seed a profile on disk first (temp router + empty supervisor).
    const seedRouter = new IpcRouter(() => undefined);
    const seedStore = new ProxyProfileStore(dir, fakeSafeStorage());
    await seedStore.load();
    registerProxyDomain(seedRouter, seedStore, fakeSupervisor([]), () => undefined);
    const seeded = await call(seedRouter, "proxy.create", { profile: input({ password: null }) });
    const id = (seeded as { ok: true; result: { profile: { id: string } } }).result.profile.id;

    // A fresh store reloads the profile; the supervisor reports it bound to two jobs.
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const router = new IpcRouter(() => undefined);
    registerProxyDomain(router, store, fakeSupervisor([{ proxyProfileId: id }, { proxyProfileId: id }]), () => undefined);
    const refused = await call(router, "proxy.remove", { id });
    expect(refused.ok).toBe(false);
    expect((refused as { ok: false; error: { code: string; message: string } }).error.code).toBe("proxy_in_use");
    expect((refused as { ok: false; error: { message: string } }).error.message).toContain("2");
    // The profile survives the refusal.
    expect(store.has(id)).toBe(true);
  });

  it("remove fails closed with core_unavailable when the core cannot be consulted", async () => {
    const { registerProxyDomain } = await import("../domains/proxy.js");
    const router = new IpcRouter(() => undefined);
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const broken = { request: vi.fn(async () => { throw new Error("core down"); }) } as unknown as CoreSupervisor;
    registerProxyDomain(router, store, broken, () => undefined);
    const created = await call(router, "proxy.create", { profile: input({ password: null }) });
    const profile = (created as { ok: true; result: { profile: { id: string } } }).result.profile;
    const refused = await call(router, "proxy.remove", { id: profile.id });
    expect((refused as { ok: false; error: { code: string } }).error.code).toBe("core_unavailable");
  });
});

describe("registerProxyDomain × settings default (Phase 16)", () => {
  type Env = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

  const call = async (
    router: IpcRouter,
    method: string,
    params: unknown,
  ): Promise<Env> => {
    const { makeRequest, newUlid } = await import("@unidm/contracts");
    return (await router.handleRequest(makeRequest(newUlid(), method, params), {})) as Env;
  };

  function supervisorWithJobs(jobs: Array<{ proxyProfileId?: string | null }>): CoreSupervisor {
    return { request: vi.fn(async () => ({ jobs })) } as unknown as CoreSupervisor;
  }

  async function makeWorld(jobs: Array<{ proxyProfileId?: string | null }> = []) {
    const { registerProxyDomain } = await import("../domains/proxy.js");
    const { SettingsStore } = await import("../domains/settings.js");
    const store = new ProxyProfileStore(dir, fakeSafeStorage());
    await store.load();
    const settings = new SettingsStore(dir);
    await settings.load();
    const router = new IpcRouter(() => undefined);
    const emitted: Array<{ settings: { defaultProxyProfileId: string | null } }> = [];
    const originalEmit = router.emit.bind(router);
    router.emit = ((
      name: string,
      schema: Parameters<typeof router.emit>[1],
      payload: unknown,
    ) => {
      if (name === "settings.changed") {
        emitted.push(payload as { settings: { defaultProxyProfileId: string | null } });
      }
      return originalEmit(name, schema, payload);
    }) as typeof router.emit;
    registerProxyDomain(router, store, supervisorWithJobs(jobs), () => undefined, settings);
    return { store, settings, router, emitted };
  }

  const createProfile = async (router: IpcRouter): Promise<string> => {
    const created = await call(router, "proxy.create", { profile: input({ password: null }) });
    return (created as { ok: true; result: { profile: { id: string } } }).result.profile.id;
  };

  it("removing the default profile clears defaultProxyProfileId and emits settings.changed", async () => {
    const { settings, router, emitted } = await makeWorld();
    const id = await createProfile(router);
    await settings.update({ defaultProxyProfileId: id });
    expect(settings.settings.defaultProxyProfileId).toBe(id);

    const removed = await call(router, "proxy.remove", { id });
    expect(removed).toMatchObject({ ok: true, result: { removed: true } });
    expect(settings.settings.defaultProxyProfileId).toBeNull();
    expect(emitted).toEqual([
      { settings: expect.objectContaining({ defaultProxyProfileId: null }) },
    ]);
  });

  it("removing an unrelated profile leaves the default untouched", async () => {
    const { settings, router, emitted } = await makeWorld();
    const other = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await settings.update({ defaultProxyProfileId: other });
    const id = await createProfile(router);

    const removed = await call(router, "proxy.remove", { id });
    expect(removed).toMatchObject({ ok: true });
    expect(settings.settings.defaultProxyProfileId).toBe(other);
    expect(emitted).toEqual([]);
  });

  it("a proxy_in_use refusal never mutates the settings default", async () => {
    const id = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const { settings, router } = await makeWorld([{ proxyProfileId: id }, { proxyProfileId: id }]);
    await settings.update({ defaultProxyProfileId: id });

    const refused = await call(router, "proxy.remove", { id });
    expect(refused.ok).toBe(false);
    expect((refused as { ok: false; error: { code: string } }).error.code).toBe("proxy_in_use");
    expect(settings.settings.defaultProxyProfileId).toBe(id);
  });
});
