import { readFile } from "node:fs/promises";
import {
  ToolkitManifest, SyntaxDmError,
  type ToolkitArtifact, type ToolkitManifest as ToolkitManifestT, type PlatformKey,
} from "@syntaxdm/contracts";

/**
 * Manifest loading + validation (Phase 10).
 *
 * The version manifest ships with the application (dev: apps/desktop/resources/toolchains.json;
 * packaged: process.resourcesPath/toolchains.json). It pins exact artifact versions,
 * SHA-256 hashes, sizes and archive layouts at authoring time — the pin script
 * (scripts/pin-toolchains.mjs) measures and hashes real artifacts. A manifest that does not
 * validate is a build error, not a runtime fallback: we refuse to run with unknown sources
 * (fail-closed, `toolkit_manifest_invalid`).
 */

export function platformKey(platform: string = process.platform, arch: string = process.arch): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

export interface LoadedManifest {
  readonly manifest: ToolkitManifestT;
  readonly platform: PlatformKey | null;
}

/** Parse + validate a manifest document. Throws `toolkit_manifest_invalid` on any deviation. */
export function parseManifest(raw: string): ToolkitManifestT {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new SyntaxDmError("toolkit_manifest_invalid", "toolchains manifest is not valid JSON");
  }
  const parsed = ToolkitManifest.safeParse(doc);
  if (!parsed.success) {
    throw new SyntaxDmError(
      "toolkit_manifest_invalid",
      `toolchains manifest failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  // Duplicate tool ids would make status reporting ambiguous — reject early.
  const ids = parsed.data.tools.map((t) => t.id);
  if (new Set(ids).size !== ids.length) {
    throw new SyntaxDmError("toolkit_manifest_invalid", "toolchains manifest has duplicate tool ids");
  }
  return parsed.data;
}

/** Load + validate the manifest from an absolute path. */
export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    throw new SyntaxDmError("toolkit_manifest_invalid", `toolchains manifest unreadable: ${String(err)}`);
  }
  return { manifest: parseManifest(raw), platform: platformKey() };
}

/** The artifact for a tool on this machine, or a classified reason it cannot exist. */
export function resolveArtifact(
  manifest: ToolkitManifestT,
  platform: PlatformKey | null,
  toolId: string,
): { artifact: ToolkitArtifact; version: string } {
  const tool = manifest.tools.find((t) => t.id === toolId);
  if (!tool) {
    throw new SyntaxDmError("toolkit_manifest_invalid", `tool ${toolId} is not in the manifest`);
  }
  if (platform === null) {
    throw new SyntaxDmError(
      "toolkit_unsupported_platform",
      `${process.platform}-${process.arch} has no bundled media tool artifacts`,
    );
  }
  const artifact = tool.platforms[platform];
  if (!artifact) {
    throw new SyntaxDmError(
      "toolkit_unsupported_platform",
      `tool ${toolId} has no pinned artifact for ${platform}`,
    );
  }
  return { artifact, version: tool.version };
}
