import { z } from "zod";
import { ErrorCode } from "../errors.js";

/**
 * Update domain (Phase 18, v1.13): the auto-update channel. MAIN-SERVED ONLY — the Rust
 * core never learns anything about updates (zero core surface beyond the mirrored version
 * constant).
 *
 * Posture:
 *  - the update source is either the UNIDM_UPDATE_FEED_URL env override (https only) or
 *    the app-update.yml electron-builder drops into resources/ at packaging time; no
 *    feed is a classified `unavailable` state, never a direct-HTTP fallback;
 *  - consent-gated lifecycle: a check NEVER downloads, download happens only via
 *    `update.download`, install only via `update.install` after `downloaded`;
 *  - the renderer sees sanitized state shapes — never a feed URL, never a filesystem
 *    path (the Phase 10 toolkit precedent);
 *  - integrity: https transport + feed-embedded sha512 + blockmap (electron-updater);
 *    authenticity = code signing at release engineering (Phase 19+).
 */

export const UpdateStatus = z.enum([
  "idle",
  "checking",
  "available",
  "not-available",
  "downloading",
  "downloaded",
  "installing",
  "error",
  "unavailable",
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** Why the updater is unavailable (fail-closed preconditions). */
export const UpdateUnavailableReason = z.enum(["not_packaged", "no_feed"]);
export type UpdateUnavailableReason = z.infer<typeof UpdateUnavailableReason>;

export const UpdateProgress = z.object({
  percent: z.number().min(0).max(100),
  transferredBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  bytesPerSecond: z.number().nonnegative(),
});
export type UpdateProgress = z.infer<typeof UpdateProgress>;

const ReleaseNotes = z
  .string()
  .max(4000, "release notes are capped at 4000 chars")
  .nullable();

/**
 * Full updater snapshot — the single payload of `update.state` and the result of
 * `update.getState`. The renderer store is a dumb mirror of this shape.
 */
export const UpdateState = z.object({
  status: UpdateStatus,
  /** Set only while status === "unavailable". */
  unavailableReason: UpdateUnavailableReason.nullable(),
  /** Running app version (app.getVersion()). */
  currentVersion: z.string().min(1),
  /** Feed version while status === "available" | "downloading" | "downloaded". */
  availableVersion: z.string().min(1).nullable(),
  /** Feed release date (ISO-ish string from the feed; passed through uncapped but bounded). */
  releaseDate: z.string().max(64).nullable(),
  /** Sanitized release notes: a feed string capped at 4000 chars; any other shape → null. */
  releaseNotes: ReleaseNotes,
  /** Live progress while status === "downloading"; the final snapshot keeps percent 100. */
  progress: UpdateProgress.nullable(),
  /** Classified failure (a registered ErrorCode string) while status === "error". */
  errorCode: ErrorCode.nullable(),
  /** Human-readable detail for the last failure (bounded). */
  message: z.string().max(500).nullable(),
  /** Epoch ms of the last SUCCESSFUL check round (available or not-available). */
  lastCheckedAt: z.number().int().nonnegative().nullable(),
});
export type UpdateState = z.infer<typeof UpdateState>;

// ---- main-served methods ----

export const UpdateGetStateParams = z.object({});
export const UpdateGetStateResult = z.object({ state: UpdateState });

/** Triggers a check (manual). started=false when a guard rejects (re-entry, no feed…). */
export const UpdateCheckParams = z.object({});
export const UpdateCheckResult = z.object({ started: z.boolean() });

/** Consent point: starts downloading a found update. started=false when not available. */
export const UpdateDownloadParams = z.object({});
export const UpdateDownloadResult = z.object({ started: z.boolean() });

/**
 * Consent point: quits the app and installs the downloaded update. accepted=false when
 * the precondition (status === downloaded) fails. The teardown (tray, core supervisor)
 * runs BEFORE the installer is spawned — the update.state "installing" event may never
 * reach the renderer over a dying IPC channel; the UI treats a successful acceptance as
 * the terminal signal.
 */
export const UpdateInstallParams = z.object({});
export const UpdateInstallResult = z.object({ accepted: z.boolean() });

/** Event payload: the full snapshot on every transition (progress throttled). */
export const UpdateStateEvent = UpdateState;
export type UpdateStateEvent = UpdateState;
