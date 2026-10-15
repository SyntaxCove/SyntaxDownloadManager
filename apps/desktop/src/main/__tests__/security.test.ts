import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveAppPaths, isAllowedRendererSource } from "../paths.js";
import { isTrustedSender } from "../ipc/electron-rpc.js";
import { denyByDefaultPermissions, secureWebPreferences } from "../security.js";

describe("resolveAppPaths", () => {
  it("dev: dev server URL wins, preload is the bundled CJS", () => {
    const p = resolveAppPaths({
      appRoot: "/opt/syntaxdm",
      isPackaged: false,
      envDevServerUrl: "http://localhost:5173/",
    });
    expect(p.devServerUrl).toBe("http://localhost:5173/");
    expect(p.preloadScript).toBe(resolve("/opt/syntaxdm/dist/preload/preload.cjs"));
  });
  it("prod: renderer index + preload resolved from app root", () => {
    const p = resolveAppPaths({ appRoot: "/opt/syntaxdm", isPackaged: true });
    expect(p.devServerUrl).toBeNull();
    expect(p.rendererIndex.endsWith("dist/renderer/index.html")).toBe(true);
    expect(p.preloadScript.endsWith("dist/preload/preload.cjs")).toBe(true);
  });
  it("blank dev URL is treated as absent", () => {
    const p = resolveAppPaths({ appRoot: "/x", isPackaged: false, envDevServerUrl: "   " });
    expect(p.devServerUrl).toBeNull();
  });
  it("allowed renderer source only accepts own origins", () => {
    const dev = resolveAppPaths({ appRoot: "/x", isPackaged: false, envDevServerUrl: "http://localhost:5173" });
    expect(isAllowedRendererSource(dev, "http://localhost:5173/app")).toBe(true);
    expect(isAllowedRendererSource(dev, "https://evil.example")).toBe(false);
    const prod = resolveAppPaths({ appRoot: "/x", isPackaged: true });
    expect(isAllowedRendererSource(prod, "https://evil.example")).toBe(false);
  });
});

describe("sender firewall", () => {
  it("accepts own dist renderer and dev server, rejects everything else", () => {
    process.env.SYNTAXDM_DEV_SERVER_URL = "http://localhost:5173";
    expect(isTrustedSender("file:///opt/syntaxdm/dist/renderer/index.html")).toBe(true);
    expect(isTrustedSender("http://localhost:5173/some/route")).toBe(true);
    expect(isTrustedSender("file:///etc/passwd")).toBe(false);
    expect(isTrustedSender("https://evil.example/app.html")).toBe(false);
    expect(isTrustedSender("file:///opt/syntaxdm/dist/renderer/index.html#/injected")).toBe(true);
    delete process.env.SYNTAXDM_DEV_SERVER_URL;
    expect(isTrustedSender("http://localhost:5173/")).toBe(false);
  });
});

describe("security policy", () => {
  it("webPreferences keep the sandbox hardened", () => {
    const prefs = secureWebPreferences({ preloadScript: "/p.cjs", devServerUrl: null });
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
  });
  it("permission handler denies by default", () => {
    const handler = denyByDefaultPermissions();
    let granted: boolean | undefined;
    handler({}, "geolocation", (g: boolean) => (granted = g), {});
    expect(granted).toBe(false);
  });
});
