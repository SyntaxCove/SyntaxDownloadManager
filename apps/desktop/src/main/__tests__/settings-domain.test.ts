import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings, SETTINGS_DEFAULTS } from "@syntaxdm/contracts";
import { SettingsStore, registerSettingsDomain } from "../domains/settings.js";
import { IpcRouter } from "../ipc/router.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "syntaxdm-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("starts with contract defaults on first run", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.settings).toEqual(SETTINGS_DEFAULTS);
  });

  it("persists updates atomically (no tmp leftovers) and reloads them", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ theme: "dark", language: "fa" });

    const files = await readdir(dir);
    expect(files).toEqual(["settings.json"]);
    const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    expect(onDisk.theme).toBe("dark");
    expect(onDisk.language).toBe("fa");

    const store2 = new SettingsStore(dir);
    await store2.load();
    expect(store2.settings.theme).toBe("dark");
    expect(store2.settings.language).toBe("fa");
  });

  it("merges defaults for unknown/missing keys (forward compatibility)", async () => {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.settings.theme).toBe("light");
    expect(store.settings.concurrentDownloads).toBe(SETTINGS_DEFAULTS.concurrentDownloads);
  });

  it("quarantines corrupt JSON and reinstates defaults", async () => {
    await writeFile(join(dir, "settings.json"), "{ not json", "utf8");
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.settings).toEqual(SETTINGS_DEFAULTS);
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("settings.json.corrupt-"))).toBe(true);
    expect(files).toContain("settings.json");
  });

  it("quarantines schema-invalid content", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ concurrentDownloads: 99, theme: "neon" }),
      "utf8",
    );
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.settings).toEqual(SETTINGS_DEFAULTS);
  });

  it("rejects invalid patches via zod (router maps to invalid_params)", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await expect(store.update({ concurrentDownloads: 99 })).rejects.toThrow();
    // state untouched
    expect(store.settings.concurrentDownloads).toBe(SETTINGS_DEFAULTS.concurrentDownloads);
  });
});

describe("settings domain RPC", () => {
  it("get returns current settings; setAll validates, persists and emits settings.changed", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const router = new IpcRouter();
    const onEvent = vi.fn();
    router.onEvent(onEvent);
    registerSettingsDomain(router, store);

    const got = await router.handleRequest({ v: 1, id: "g1", method: "settings.get", params: {} }, {});
    expect(got.ok).toBe(true);
    if (got.ok) expect((got.result as { settings: unknown }).settings).toEqual(SETTINGS_DEFAULTS);

    const set = await router.handleRequest(
      { v: 1, id: "s1", method: "settings.setAll", params: { settings: { theme: "dark" } } },
      {},
    );
    expect(set.ok).toBe(true);
    if (set.ok) expect((set.result as { settings: { theme: string } }).settings.theme).toBe("dark");
    expect(onEvent).toHaveBeenCalledWith(
      "settings.changed",
      expect.objectContaining({ settings: expect.objectContaining({ theme: "dark" }) }),
    );

    const bad = await router.handleRequest(
      { v: 1, id: "s2", method: "settings.setAll", params: { settings: { speedLimitKBps: -5 } } },
      {},
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_params");
  });
});

describe("SettingsStore — default proxy (Phase 16)", () => {
  it("defaultProxyProfileId persists and round-trips (null default = direct)", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.settings.defaultProxyProfileId).toBeNull();

    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await store.update({ defaultProxyProfileId: id });
    const reloaded = new SettingsStore(dir);
    await reloaded.load();
    expect(reloaded.settings.defaultProxyProfileId).toBe(id);

    await store.update({ defaultProxyProfileId: null });
    const reloaded2 = new SettingsStore(dir);
    await reloaded2.load();
    expect(reloaded2.settings.defaultProxyProfileId).toBeNull();
  });

  it("rejects a non-ULID default proxy (invalid patch → router maps to invalid_params)", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    expect(() => AppSettings.parse({ ...store.settings, defaultProxyProfileId: "junk" }))
      .toThrow();
  });
});
