import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Download domain — contract v1.1 adds the Phase 6 segmented engine: per-segment journal,
 * connections-per-download and integrity checksums. v1.2 (Phase 7) adds the recovery engine:
 * source re-acquisition, multi-signal revalidation, rebind and gap-fill. v1.3 (Phase 8) adds
 * queue management (queuePosition, queueMove/startAll/pauseAll) and bandwidth policy
 * (setSpeedLimit, setPolicy). All new fields are additive so v1 payloads remain valid.
 */

export const DownloadStatus = z.enum([
  "queued",
  "probing",
  "downloading",
  "paused",
  "completed",
  "failed",
  "canceled",
]);
export type DownloadStatus = z.infer<typeof DownloadStatus>;

/** Terminal statuses: no engine task is running for the job. */
export const TERMINAL_STATUSES: readonly DownloadStatus[] = ["completed", "failed", "canceled"];

/** Checksum algorithms accepted for expected-integrity verification (Phase 6). */
export const ChecksumAlgorithm = z.enum(["sha256", "sha1", "md5"]);
export type ChecksumAlgorithm = z.infer<typeof ChecksumAlgorithm>;

/** Hex digest lengths per algorithm — validated at the boundary, case-insensitive. */
export const CHECKSUM_HEX_LENGTH: Record<ChecksumAlgorithm, number> = {
  sha256: 64,
  sha1: 40,
  md5: 32,
};

/**
 * Download sources are http(s) only (the core enforces the same rule; a non-http(s) URL
 * is rejected with `url_invalid`). Pinned here so every boundary rejects early.
 */
export const HttpUrl = z.url({ protocol: /^https?$/ });
export type HttpUrl = z.infer<typeof HttpUrl>;

export const Checksum = z
  .object({
    algorithm: ChecksumAlgorithm,
    /** Lowercase hex digest of the complete file. */
    value: z
      .string()
      .regex(/^[0-9a-fA-F]+$/, "checksum value must be hex")
      .refine((v) => Object.values(CHECKSUM_HEX_LENGTH).includes(v.length), {
        message: "checksum hex length must match the algorithm (sha256=64, sha1=40, md5=32)",
      }),
  })
  .refine((c) => c.value.length === CHECKSUM_HEX_LENGTH[c.algorithm], {
    message: "checksum hex length does not match algorithm",
  });
export type Checksum = z.infer<typeof Checksum>;

export const DownloadJob = z.object({
  id: Ulid,
  /** Source URL at creation time. Re-binding to new sources happens in the recovery phases. */
  url: HttpUrl,
  /** Absolute save directory (known at creation). */
  destinationDir: z.string().min(1),
  /** Absolute final path; null until the probe resolves the filename. */
  destinationPath: z.string().min(1).nullable(),
  /** Explicit filename from creation params, when provided. */
  filename: z.string().min(1).nullish(),
  status: DownloadStatus,
  /** `null` while unknown (probe failed or server omitted Content-Length). */
  totalBytes: z.number().int().nonnegative().nullable(),
  receivedBytes: z.number().int().nonnegative(),
  /** Validator fields used to prove the source did not change between runs (resume safety). */
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  contentType: z.string().nullable(),
  speedBps: z.number().int().nonnegative().nullable(),
  etaSeconds: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  /** Request headers (UA/Referer/Cookie) captured at creation; required for faithful resume. */
  headers: z.record(z.string(), z.string()).nullish(),
  // ---- v1.1 (Phase 6): segmentation + integrity ----
  /** Number of range windows the engine planned; null for legacy single-stream jobs. */
  segmentCount: z.number().int().min(1).nullable(),
  /** Expected checksum provided at creation (compared at completion); null when none. */
  checksumAlgorithm: ChecksumAlgorithm.nullish(),
  checksumExpected: z.string().regex(/^[0-9a-fA-F]+$/).nullish(),
  /** Streaming SHA-256 digest computed by the engine over the finished part file. */
  checksumActual: z.string().regex(/^[0-9a-fA-F]+$/).nullable(),
  /** Result of the expected-vs-actual comparison; null = never compared (no expected). */
  checksumVerified: z.boolean().nullable(),
  // ---- v1.2 (Phase 7): recovery audit trail ----
  /** How many times the job was rebound to a (re-)acquired source; null = never rebound. */
  recoveryCount: z.number().int().min(0).nullable(),
  /** Epoch ms of the most recent rebind; null = never rebound. */
  reboundAt: z.number().int().nonnegative().nullable(),
  // ---- v1.3 (Phase 8): queue + bandwidth ----
  /** 0-based queue slot while `queued` (pump order); null once the job leaves the queue. */
  queuePosition: z.number().int().nonnegative().nullable(),
  /** Per-job bandwidth cap in KiB/s; omitted = unlimited (0 also means unlimited). */
  speedLimitKBps: z.number().int().min(0).nullish(),
  // ---- v1.4 (Phase 9): proxy routing ----
  /** Proxy profile the job routes through; null = direct (always serialized). */
  proxyProfileId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DownloadJob = z.infer<typeof DownloadJob>;

export const DownloadCreateParams = z.object({
  url: HttpUrl,
  /** Absolute directory the file will be saved into (must exist; core creates it if missing). */
  destinationDir: z.string().min(1),
  /** Optional explicit filename; otherwise derived from the URL/Content-Disposition (probe). */
  filename: z.string().min(1).optional(),
  /** false (default): auto-uniquify to "name (2).ext"; true: refuse with `file_exists`. */
  overwrite: z.boolean().optional().default(false),
  /** Extra request headers (User-Agent, Referer, cookies) captured from the browser context. */
  headers: z.record(z.string(), z.string()).optional(),
  /** v1.1: expected file checksum — the engine verifies the download before declaring completion. */
  checksum: Checksum.optional(),
  /** v1.4: proxy profile to route through; omitted = the app-level default applies (main
   *  injects `settings.defaultProxyProfileId`, Phase 16; null default = direct); explicit
   *  null = direct; an explicit profile id is honored verbatim. */
  proxyProfileId: Ulid.nullish(),
});
export type DownloadCreateParams = z.infer<typeof DownloadCreateParams>;

export const DownloadCreateResult = z.object({ job: DownloadJob });
export type DownloadCreateResult = z.infer<typeof DownloadCreateResult>;

export const DownloadListParams = z.object({});
export const DownloadListResult = z.object({ jobs: z.array(DownloadJob) });
export type DownloadListResult = z.infer<typeof DownloadListResult>;

export const JobIdParams = z.object({ id: Ulid });
export const JobByIdResult = z.object({ job: DownloadJob.nullable() });
export type JobByIdResult = z.infer<typeof JobByIdResult>;

export const DownloadRemoveParams = z.object({
  id: Ulid,
  /** Also delete the `.part` sidecar file. */
  deletePartialFile: z.boolean().optional().default(false),
});
export const DownloadRemoveResult = z.object({ removed: z.literal(true) });

// ---- v1.2 (Phase 7): recovery engine ----

/** Re-acquire the current source, revalidate the part with multiple signals, rebind, queue. */
export const DownloadRecoverParams = z.object({ id: Ulid });
export const DownloadRecoverResult = z.object({ job: DownloadJob });
export type DownloadRecoverResult = z.infer<typeof DownloadRecoverResult>;

/** Rebind a dead/expired source to a new URL; bytes and journal are kept. */
export const DownloadReplaceUrlParams = z.object({
  id: Ulid,
  /** Replacement source URL (http/https). */
  url: HttpUrl,
});
export const DownloadReplaceUrlResult = z.object({ job: DownloadJob });
export type DownloadReplaceUrlResult = z.infer<typeof DownloadReplaceUrlResult>;

/** Requeue a failed/canceled/paused job (re-probe + gap-fill on the next run). */
export const DownloadRetryParams = z.object({ id: Ulid });
export const DownloadRetryResult = z.object({ job: DownloadJob });
export type DownloadRetryResult = z.infer<typeof DownloadRetryResult>;

// ---- v1.3 (Phase 8): queue management + bandwidth policy ----

export const QueueDirection = z.enum(["top", "up", "down", "bottom"]);
export type QueueDirection = z.infer<typeof QueueDirection>;

/** Reorder a `queued` job within the download queue (only queued jobs are orderable). */
export const DownloadQueueMoveParams = z.object({ id: Ulid, direction: QueueDirection });
export const DownloadQueueMoveResult = z.object({ job: DownloadJob });
export type DownloadQueueMoveResult = z.infer<typeof DownloadQueueMoveResult>;

/** Resume every `paused` job (failed/canceled jobs keep their recover/retry semantics). */
export const DownloadStartAllParams = z.object({});
export const DownloadStartAllResult = z.object({ started: z.number().int().nonnegative() });

/** Pause every `queued`/`probing`/`downloading` job. */
export const DownloadPauseAllParams = z.object({});
export const DownloadPauseAllResult = z.object({ paused: z.number().int().nonnegative() });

/** Set a per-job bandwidth cap (KiB/s); 0 = unlimited. Applies live and persists. */
export const DownloadSetSpeedLimitParams = z.object({
  id: Ulid,
  kbps: z.number().int().min(0),
});
export const DownloadSetSpeedLimitResult = z.object({ job: DownloadJob });
export type DownloadSetSpeedLimitResult = z.infer<typeof DownloadSetSpeedLimitResult>;

// ---- v1.4 (Phase 9): per-job proxy routing ----

/**
 * Change the proxy profile a job routes through. Refused with `invalid_state` while the job
 * is probing/downloading; a run whose profile is missing from the runtime map pauses with
 * `proxy_profile_not_found` (fail-closed — never a silent direct fallback).
 */
export const DownloadSetProxyParams = z.object({
  id: Ulid,
  proxyProfileId: Ulid.nullable(),
});
export const DownloadSetProxyResult = z.object({ job: DownloadJob });
export type DownloadSetProxyResult = z.infer<typeof DownloadSetProxyResult>;

/** Engine operating policy, pushed by main at startup / on settings changes / every 10 min. */
export const ScheduleMode = z.enum(["always", "window"]);
export type ScheduleMode = z.infer<typeof ScheduleMode>;
export const DownloadSetPolicyParams = z.object({
  /** false: `download.create` parks new jobs as `paused` instead of queueing them. */
  autoStartNew: z.boolean(),
  scheduleMode: ScheduleMode,
  /** Local minutes-of-day window bounds (0..1439); wrap-over windows are supported. */
  windowStartMinute: z.number().int().min(0).max(1439),
  windowEndMinute: z.number().int().min(0).max(1439),
  /** Global bandwidth cap in KiB/s; 0 = unlimited. */
  speedLimitKBps: z.number().int().min(0),
  /** Local-UTC offset in minutes (e.g. +210 for UTC+03:30) for window evaluation. */
  tzOffsetMinutes: z.number().int().min(-840).max(840),
});
export type DownloadSetPolicyParams = z.infer<typeof DownloadSetPolicyParams>;
export const DownloadSetPolicyResult = z.object({ applied: z.literal(true) });

/** Throttled progress event payload (see events.ts). */
export const DownloadProgress = z.object({
  jobId: Ulid,
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  speedBps: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type DownloadProgress = z.infer<typeof DownloadProgress>;
