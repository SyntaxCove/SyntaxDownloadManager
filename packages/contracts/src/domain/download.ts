import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Download domain — contract v1.1 adds the Phase 6 segmented engine: per-segment journal,
 * connections-per-download and integrity checksums. All new fields are additive (nullable /
 * optional) so v1 payloads remain valid.
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
  url: z.url(),
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
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DownloadJob = z.infer<typeof DownloadJob>;

export const DownloadCreateParams = z.object({
  url: z.url(),
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

/** Throttled progress event payload (see events.ts). */
export const DownloadProgress = z.object({
  jobId: Ulid,
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  speedBps: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type DownloadProgress = z.infer<typeof DownloadProgress>;
