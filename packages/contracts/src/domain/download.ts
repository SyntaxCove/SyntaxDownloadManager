import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Download domain — contract v1 covers the Phase 5 engine (single-stream resumable jobs).
 * Segmentation/recovery states and fields are added in later contract minor versions.
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

export const DownloadJob = z.object({
  id: Ulid,
  /** Source URL at creation time. Re-binding to new sources happens in the recovery phases. */
  url: z.url(),
  /** Absolute final path (destinationDir + resolved filename). */
  destinationPath: z.string().min(1),
  status: DownloadStatus,
  /** `null` while unknown (probe failed or server omitted Content-Length). */
  totalBytes: z.number().int().nonnegative().nullable(),
  receivedBytes: z.number().int().nonnegative(),
  /** Validator fields used to prove the source did not change between runs (resume safety). */
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  contentType: z.string().nullable(),
  speedBps: z.number().nonnegative().nullable(),
  etaSeconds: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  /** Epoch milliseconds (avoids datetime parsing divergence between TS and Rust). */
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DownloadJob = z.infer<typeof DownloadJob>;

export const DownloadCreateParams = z.object({
  url: z.url(),
  /** Absolute directory the file will be saved into (must exist; core creates it if missing). */
  destinationDir: z.string().min(1),
  /** Optional explicit filename; otherwise derived from the URL/Content-Disposition (Phase 5 probe). */
  filename: z.string().min(1).optional(),
  /** false (default): auto-uniquify to "name (2).ext"; true: refuse with `file_exists`. */
  overwrite: z.boolean().optional().default(false),
  /** Extra request headers (User-Agent, Referer, cookies) captured from the browser context. */
  headers: z.record(z.string(), z.string()).optional(),
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
  speedBps: z.number().nonnegative(),
  etaSeconds: z.number().nonnegative().nullable(),
});
export type DownloadProgress = z.infer<typeof DownloadProgress>;
