import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 19 drift guard: electron-builder.json must produce EXACTLY the packaged
 * layout the main process resolves at runtime (appRoot = process.resourcesPath):
 *
 *   - paths.ts            → <resources>/toolchains.json, <resources>/syntaxdm-tray.png,
 *                           <resources>/dist/renderer/index.html, <resources>/dist/preload/preload.cjs
 *   - core-supervisor.ts  → <resources>/bin/download-core/download-core.exe
 *   - main.ts             → <resources>/app-update.yml (generated from `publish`),
 *                           AppUserModelID com.syntaxdm.desktop == appId
 *
 * A rename that breaks any side of this contract fails here instead of shipping an
 * installer whose core binary, toolkit manifest, or tray icon cannot be found.
 */

/**
 * Walk up from the vitest working directory to the desktop workspace root
 * (the directory holding electron-builder.json). Keeps the test independent of
 * whether vitest was started from the workspace or the monorepo root.
 */
function findDesktopRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "electron-builder.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`electron-builder.json not found upward from ${process.cwd()}`);
}

const desktopRoot = findDesktopRoot();

interface ExtraResource {
  from: string;
  to: string;
}

interface BuilderConfig {
  appId: string;
  productName: string;
  executableName: string;
  files: string[];
  extraResources: ExtraResource[];
  nsis: { artifactName: string; deleteAppDataOnUninstall: boolean; perMachine: boolean };
  artifactName: string;
  win: { icon: string };
  publish: { provider: string; owner: string; repo: string };
}

const config = JSON.parse(
  readFileSync(join(desktopRoot, "electron-builder.json"), "utf8"),
) as BuilderConfig;

function findResource(to: string): ExtraResource {
  const hit = config.extraResources.find((r) => r.to === to);
  expect(hit, `extraResources entry with to="${to}"`).toBeDefined();
  return hit as ExtraResource;
}

describe("phase 19: packaging config matches the packaged path contract", () => {
  it("appId is the same AppUserModelID main.ts registers", () => {
    const mainSrc = readFileSync(join(desktopRoot, "src/main/main.ts"), "utf8");
    expect(mainSrc).toContain(`app.setAppUserModelId("${config.appId}")`);
  });

  it("stages the media-toolkit manifest at the resources root", () => {
    const entry = findResource("toolchains.json");
    expect(entry.from).toBe("resources/toolchains.json");
    expect(existsSync(join(desktopRoot, entry.from))).toBe(true);
  });

  it("stages the tray icon at the resources root", () => {
    const entry = findResource("syntaxdm-tray.png");
    expect(entry.from).toBe("resources/icons/syntaxdm-tray.png");
    expect(existsSync(join(desktopRoot, entry.from))).toBe(true);
  });

  it("stages the Rust core outside asar under bin/download-core", () => {
    const entry = findResource("bin/download-core");
    expect(entry.from).toBe("build/core");
  });

  it("keeps renderer and preload as real files under resources/dist", () => {
    expect(findResource("dist/renderer").from).toBe("dist/renderer");
    expect(findResource("dist/preload").from).toBe("dist/preload");
  });

  it("keeps the main-process entry (package.json main) inside the asar", () => {
    expect(config.files).toContain("dist/main/**/*");
  });

  it("embeds a real multi-size installer icon", () => {
    expect(config.win.icon).toBe("build/icon.ico");
    const bytes = readFileSync(join(desktopRoot, config.win.icon));
    // ICO container: reserved 0, type 1, then the frame count in the header.
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBeGreaterThanOrEqual(7); // 16..256 ladder
  });

  it("uninstall never destroys user data (download database survives)", () => {
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it("per-user install (no elevation required)", () => {
    expect(config.nsis.perMachine).toBe(false);
  });

  it("names the two artifacts (installer override + portable default)", () => {
    // electron-builder 26 removed the root "zip" config key: the portable zip
    // inherits the root artifactName, while the NSIS target overrides its own.
    expect(config.artifactName).toBe(
      "SyntaxDownloadManager-${version}-portable.${ext}",
    );
    expect(config.nsis.artifactName).toBe(
      "SyntaxDownloadManager-Setup-${version}.${ext}",
    );
  });

  it("publish feed targets this repository (drives the packaged app-update.yml)", () => {
    expect(config.publish).toEqual({
      provider: "github",
      owner: "SyntaxCove",
      repo: "SyntaxDownloadManager",
    });
  });
});
