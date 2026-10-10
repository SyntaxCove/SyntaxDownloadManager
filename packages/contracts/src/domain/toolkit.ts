import { z } from "zod";

/**
 * Toolkit domain (Phase 10, v1.5): the bundled media tools (FFmpeg, yt-dlp, Deno) the end
 * user must never install. A version manifest pinned at authoring time (exact versions +
 * SHA-256 per platform) ships with the app; the main-process toolkit manager fetches,
 * verifies, extracts and activates the tools into the user profile, then pushes ONLY the
 * verified executable paths into the Rust core (`toolkit.setPaths`).
 *
 * Integrity posture:
 *  - every artifact URL must be https and carry an authoring-time sha256 + exact sizeBytes;
 *  - a checksum/length mismatch NEVER activates the artifact (fail-closed);
 *  - the renderer only ever sees status shapes — never manifest URLs (which could differ
 *    between channels) and never filesystem paths other than its own ready tool path.
 */

export const ToolId = z.enum(["ffmpeg", "yt-dlp", "deno"]);
export type ToolId = z.infer<typeof ToolId>;

/** Platform → artifact map keys. win32-x64 is the product target; linux-x64 drives the
 *  headless sandbox pipeline (and doubles as a dev target). */
export const PlatformKey = z.enum(["win32-x64", "linux-x64"]);
export type PlatformKey = z.infer<typeof PlatformKey>;

export const ToolkitArchiveType = z.enum(["none", "zip", "tar.xz"]);
export type ToolkitArchiveType = z.infer<typeof ToolkitArchiveType>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");

/** One platform-specific pinned artifact. `execPath` is relative to the extraction root
 *  (forward slashes; the manager maps to the native separator). */
export const ToolkitArtifact = z.object({
  url: z
    .string()
    .regex(/^https:\/\//, "artifact URLs must be https")
    .max(2048),
  sha256: Sha256Hex,
  sizeBytes: z.number().int().positive(),
  archiveType: ToolkitArchiveType,
  execPath: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes(".."),
      "execPath must be a safe relative path",
    ),
  /** Additional executables worth chmod'ing on unix (e.g. ffprobe alongside ffmpeg). */
  extraExecs: z
    .array(
      z
        .string()
        .min(1)
        .max(512)
        .refine(
          (p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes(".."),
          "extraExecs paths must be safe relative paths",
        ),
    )
    .max(8)
    .optional(),
});
export type ToolkitArtifact = z.infer<typeof ToolkitArtifact>;

export const ToolkitToolSpec = z.object({
  id: ToolId,
  /** Exact pinned upstream version string (e.g. "2025.09.26", "8.0.1", "2.1.5"). */
  version: z.string().min(1).max(64),
  /** Subset of supported platforms — a tool may legitimately ship for fewer targets;
   *  missing keys surface as `toolkit_unsupported_platform` at ensure-time. */
  platforms: z.partialRecord(PlatformKey, ToolkitArtifact),
});
export type ToolkitToolSpec = z.infer<typeof ToolkitToolSpec>;

export const ToolkitManifest = z.object({
  manifestVersion: z.literal(1),
  tools: z.array(ToolkitToolSpec).min(1).max(16),
});
export type ToolkitManifest = z.infer<typeof ToolkitManifest>;

// ---- status (main → renderer) ----

export const ToolkitToolState = z.enum(["missing", "fetching", "verifying", "ready", "failed"]);
export type ToolkitToolState = z.infer<typeof ToolkitToolState>;

export const ToolkitToolStatus = z.object({
  id: ToolId,
  version: z.string().min(1),
  state: ToolkitToolState,
  /** Absolute path of the activated executable; null unless state === "ready". */
  path: z.string().nullable(),
  bytesFetched: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  /** Classified failure code (a registered ErrorCode string) when state === "failed". */
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
});
export type ToolkitToolStatus = z.infer<typeof ToolkitToolStatus>;

export const ToolkitStatusResult = z.object({
  manifestVersion: z.literal(1),
  platform: PlatformKey.nullable(),
  tools: z.array(ToolkitToolStatus),
});
export type ToolkitStatusResult = z.infer<typeof ToolkitStatusResult>;

// ---- main-served methods ----

export const ToolkitGetStatusParams = z.object({});
export const ToolkitGetStatusResult = ToolkitStatusResult;

export const ToolkitEnsureAllParams = z.object({});
export const ToolkitEnsureAllResult = z.object({ started: z.array(ToolId) });

export const ToolkitEnsureParams = z.object({ id: ToolId });
export const ToolkitEnsureResult = z.object({ started: z.boolean() });

export const ToolkitCancelParams = z.object({ id: ToolId });
export const ToolkitCancelResult = z.object({ canceled: z.boolean() });

// ---- core-served runtime push (main → core; mirrors proxy.setRuntime semantics) ----

export const ToolkitPathEntry = z.object({
  id: ToolId,
  version: z.string().min(1).max(64),
  path: z.string().min(1).max(1024),
});
export type ToolkitPathEntry = z.infer<typeof ToolkitPathEntry>;

export const ToolkitSetPathsParams = z.object({ tools: z.array(ToolkitPathEntry).max(16) });
export const ToolkitSetPathsResult = z.object({ applied: z.literal(true) });
export type ToolkitSetPathsParams = z.infer<typeof ToolkitSetPathsParams>;
