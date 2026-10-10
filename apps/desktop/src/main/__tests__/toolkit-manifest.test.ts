import { mkdtemp, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformKey, parseManifest, loadManifest } from "../toolkit/manifest.js";
import { safeJoin } from "../toolkit/extract.js";
import { UniDmError } from "@unidm/contracts";

/**
 * Manifest validation + path-safety unit tests (Phase 10). The end-to-end pipeline lives
 * in toolkit-pipeline.test.ts; here the gates are proven in isolation.
 */

const validManifest = {
  manifestVersion: 1,
  tools: [
    {
      id: "yt-dlp",
      version: "2025.09.26",
      platforms: {
        "win32-x64": {
          url: "https://example.com/yt-dlp.exe",
          sha256: "aa".repeat(32),
          sizeBytes: 19333120,
          archiveType: "none",
          execPath: "yt-dlp.exe",
        },
        "linux-x64": {
          url: "https://example.com/yt-dlp",
          sha256: "bb".repeat(32),
          sizeBytes: 20642440,
          archiveType: "none",
          execPath: "yt-dlp",
        },
      },
    },
  ],
};

describe("platformKey", () => {
  it("maps the supported product and dev targets", () => {
    expect(platformKey("win32", "x64")).toBe("win32-x64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
  });
  it("returns null for unsupported hosts (fail-closed, never guesses)", () => {
    expect(platformKey("darwin", "arm64")).toBeNull();
    expect(platformKey("win32", "arm64")).toBeNull();
    expect(platformKey("linux", "riscv64")).toBeNull();
  });
});

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    expect(parseManifest(JSON.stringify(validManifest)).tools).toHaveLength(1);
  });
  it("rejects non-JSON with toolkit_manifest_invalid", () => {
    expect(() => parseManifest("{nope")).toThrowError(UniDmError);
    try {
      parseManifest("{nope");
      expect.unreachable();
    } catch (err) {
      expect((err as UniDmError).code).toBe("toolkit_manifest_invalid");
    }
  });
  it("rejects duplicate tool ids", () => {
    const dup = structuredClone(validManifest);
    dup.tools.push(structuredClone(dup.tools[0]!));
    expect(() => parseManifest(JSON.stringify(dup))).toThrowError(/duplicate tool ids/);
  });
  it("rejects an http (non-https) artifact URL", () => {
    const bad = structuredClone(validManifest);
    bad.tools[0]!.platforms["win32-x64"].url = "http://example.com/yt-dlp.exe";
    expect(() => parseManifest(JSON.stringify(bad))).toThrowError(UniDmError);
  });
});

describe("loadManifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unidm-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads and validates a manifest file", async () => {
    const p = join(dir, "toolchains.json");
    await writeFile(p, JSON.stringify(validManifest), "utf8");
    const { manifest, platform } = await loadManifest(p);
    expect(manifest.tools[0]!.id).toBe("yt-dlp");
    // The sandbox is linux-x64; the mapping must agree with the host.
    expect(platform).toBe(platformKey());
  });

  it("fails classified when the manifest file is missing", async () => {
    await expect(loadManifest(join(dir, "missing.json"))).rejects.toMatchObject({
      code: "toolkit_manifest_invalid",
    });
  });
});

describe("safeJoin (escape guards)", () => {
  it("accepts ordinary relative paths", () => {
    expect(safeJoin("/root/tools", "bin/ffmpeg")).toBe(join("/root/tools", "bin/ffmpeg"));
  });
  it("rejects .. traversal, absolute paths and drive paths", () => {
    for (const evil of ["../escape", "a/../../escape", "/etc/passwd", "C:\\Windows\\evil", "C:/x", "..\\win"]) {
      expect(() => safeJoin("/root/tools", evil)).toThrowError(UniDmError);
      try {
        safeJoin("/root/tools", evil);
        expect.unreachable();
      } catch (err) {
        expect((err as UniDmError).code).toBe("toolkit_extract_failed");
      }
    }
  });
  it("normalizes backslashes and dots but keeps the root containment", () => {
    const t = safeJoin("/root/tools", "bin\\./ffmpeg.exe");
    expect(t.startsWith("/root/tools")).toBe(true);
    expect(t.endsWith("ffmpeg.exe")).toBe(true);
  });
});
