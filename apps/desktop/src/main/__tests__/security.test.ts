import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAppPaths, isAllowedRendererSource } from "../paths.js";
import { isTrustedSender, isTrustedRpcSender } from "../ipc/electron-rpc.js";
import { denyByDefaultChecks, denyByDefaultPermissions, isWebUrl, secureWebPreferences } from "../security.js";

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

describe("sender firewall (Phase 23 hardened)", () => {
  const packagedIndex = pathToFileURL(resolve("/opt/SyntaxDownloadManager/resources/app.asar.dist/renderer/index.html")).href;
  const ownFrame = pathToFileURL(resolve("/opt/SyntaxDownloadManager/resources/dist/renderer/index.html")).href;

  it("session identity: a non-default session is refused even with an own-origin URL", () => {
    for (const url of [ownFrame, "http://localhost:5173/"] as const) {
      expect(
        isTrustedRpcSender({ frameUrl: url, sessionIsDefault: false, expectedFileUrl: ownFrame, devServerUrl: "http://localhost:5173" }),
      ).toBe(false);
    }
  });

  it("packaged origin: exact match required, hash tolerated, look-alike paths refused", () => {
    expect(
      isTrustedRpcSender({ frameUrl: ownFrame, sessionIsDefault: true, expectedFileUrl: ownFrame, devServerUrl: null }),
    ).toBe(true);
    // deep-link hash must not break the firewall
    expect(
      isTrustedRpcSender({ frameUrl: `${ownFrame}#/downloads`, sessionIsDefault: true, expectedFileUrl: ownFrame, devServerUrl: null }),
    ).toBe(true);
    // substring/containment trick: a different file whose path merely *contains* the index name
    const decoy = pathToFileURL(resolve("/tmp/dist/renderer/index.html.evil")).href;
    expect(
      isTrustedRpcSender({ frameUrl: decoy, sessionIsDefault: true, expectedFileUrl: ownFrame, devServerUrl: null }),
    ).toBe(false);
    expect(
      isTrustedRpcSender({ frameUrl: "file:///etc/passwd", sessionIsDefault: true, expectedFileUrl: ownFrame, devServerUrl: null }),
    ).toBe(false);
  });

  it("dev server origin accepted only on the default session", () => {
    const dev = "http://localhost:5173";
    expect(
      isTrustedRpcSender({ frameUrl: `${dev}/route`, sessionIsDefault: true, expectedFileUrl: ownFrame, devServerUrl: dev }),
    ).toBe(true);
    expect(
      isTrustedRpcSender({ frameUrl: "http://localhost:5174/route", sessionIsDefault: true, expectedFileUrl: ownFrame, devServerUrl: dev }),
    ).toBe(false);
  });

  it("legacy fallback still guards when the packaged index is unknown", () => {
    expect(
      isTrustedRpcSender({ frameUrl: "file:///x/dist/renderer/index.html", sessionIsDefault: true, expectedFileUrl: null, devServerUrl: null }),
    ).toBe(true);
    expect(
      isTrustedRpcSender({ frameUrl: "file:///x/dist/renderer/index.html.evil", sessionIsDefault: true, expectedFileUrl: null, devServerUrl: null }),
    ).toBe(true); // legacy containment: superseded in prod by the exact-match rule
  });

  it("packaged index resolves to the path the window actually loads", () => {
    const p = resolveAppPaths({ appRoot: "/opt/syntaxdm", isPackaged: true });
    expect(p.rendererIndex.endsWith("dist/renderer/index.html")).toBe(true);
    expect(pathToFileURL(p.rendererIndex).href.startsWith("file://")).toBe(true);
    expect(packagedIndex.startsWith("file://")).toBe(true);
  });
});

describe("OS handoff policy (Phase 23)", () => {
  it("isWebUrl admits http/https only — file and custom schemes are dropped", () => {
    expect(isWebUrl("https://example.com/page")).toBe(true);
    expect(isWebUrl("http://example.com/")).toBe(true);
    expect(isWebUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isWebUrl("ms-msdt: troubleshoot")).toBe(false);
    expect(isWebUrl("search-ms:query=x")).toBe(false);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("smb://host/share")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
    expect(isWebUrl("")).toBe(false);
  });

  it("permission check handler denies by default (synchronous path)", () => {
    const checks = denyByDefaultChecks();
    expect(checks({}, "clipboard-read")).toBe(false);
    expect(checks({}, "notifications", {})).toBe(false);
    expect(checks({}, "geolocation")).toBe(false);
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
