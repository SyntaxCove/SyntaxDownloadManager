import { z } from "zod";
import { Ulid } from "../ids.js";

/**
 * Torrent domain — activated in v1.8 (Phase 13).
 *
 * The v1 file was a contract-first stub with zero consumers (no methods, no events, no UI),
 * so activating it is classified as an additive minor bump. The stub's `TorrentStatus`
 * values are preserved verbatim and `canceled` is appended (append-only spirit).
 *
 * Engine posture (mirrors the master spec's persistence rules): a torrent's swarm is the
 * persistent source — there is no expiring URL to rebind. Resume = re-announce + re-connect
 * + re-verify only the pieces the persisted have-map still lists as missing; verified bytes
 * are never re-fetched and a hash-verified piece is never presented as missing.
 */

export const TorrentStatus = z.enum([
  "queued",
  "metadata",
  "downloading",
  "seeding",
  "paused",
  "completed",
  "failed",
  "canceled",
]);
export type TorrentStatus = z.infer<typeof TorrentStatus>;

export const TorrentSourceKind = z.enum(["torrent", "magnet"]);
export type TorrentSourceKind = z.infer<typeof TorrentSourceKind>;

/** One file of a multi-file torrent (or the single file itself); sanitized relative path. */
export const TorrentFileEntry = z.object({
  /** Relative, "/"-separated, traversal-proof (no "..", no absolute, no drive letters). */
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Absolute byte offset of this file inside the concatenated piece space. */
  offset: z.number().int().nonnegative(),
});
export type TorrentFileEntry = z.infer<typeof TorrentFileEntry>;

/**
 * A persistent torrent job — mirrors the core's SQLite row. Runtime-only values (speeds,
 * peer counts, eta) are zero/null while the torrent is not actively running.
 */
export const TorrentJob = z.object({
  id: Ulid,
  /** Display name; null until the metainfo (or magnet `dn`) resolves it. */
  name: z.string().min(1).nullable(),
  status: TorrentStatus,
  sourceKind: TorrentSourceKind,
  /** 40-char lowercase hex v1 info hash; null for magnets until metadata arrives. */
  infoHash: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  destinationDir: z.string().min(1),
  /** Total payload size; null until metadata (magnet pre-resolution). */
  totalBytes: z.number().int().nonnegative().nullable(),
  receivedBytes: z.number().int().nonnegative(),
  uploadedBytes: z.number().int().nonnegative(),
  downloadSpeedBps: z.number().int().nonnegative(),
  uploadSpeedBps: z.number().int().nonnegative(),
  /** Currently connected peers. */
  peers: z.number().int().nonnegative(),
  /** Currently connected seeds (subset of peers). */
  seeds: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
  numPieces: z.number().int().positive().nullable(),
  pieceLength: z.number().int().positive().nullable(),
  /** Empty until metadata; single-file torrents carry exactly one entry. */
  files: z.array(TorrentFileEntry),
  errorCode: z.string().nullable(),
  proxyProfileId: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type TorrentJob = z.infer<typeof TorrentJob>;

/** `torrent.add` — exactly one of magnetUri / torrentFileB64 (zod refinement below). */
export const TorrentAddParams = z
  .object({
    magnetUri: z.string().min(1).max(4096).optional(),
    /** Base64-encoded .torrent file; the core caps the decoded size (≤ 8 MiB). */
    torrentFileB64: z.string().min(1).max(11_185_920).optional(),
    destinationDir: z.string().min(1),
    proxyProfileId: Ulid.nullish(),
  })
  .refine((p) => (p.magnetUri !== undefined) !== (p.torrentFileB64 !== undefined), {
    message: "exactly one of magnetUri or torrentFileB64 is required",
  });
export type TorrentAddParams = z.infer<typeof TorrentAddParams>;

export const TorrentAddResult = z.object({ job: TorrentJob });
export type TorrentAddResult = z.infer<typeof TorrentAddResult>;

export const TorrentListParams = z.object({});
export const TorrentListResult = z.object({ jobs: z.array(TorrentJob) });
export type TorrentListResult = z.infer<typeof TorrentListResult>;

export const TorrentJobIdParams = z.object({ id: Ulid });
export const TorrentJobByIdResult = z.object({ job: TorrentJob.nullable() });
export type TorrentJobByIdResult = z.infer<typeof TorrentJobByIdResult>;

export const TorrentRemoveParams = z.object({
  id: Ulid,
  /** Also delete the downloaded payload (files this torrent wrote). */
  deleteFiles: z.boolean().optional().default(false),
});
export const TorrentRemoveResult = z.object({ removed: z.literal(true) });
export type TorrentRemoveResult = z.infer<typeof TorrentRemoveResult>;

/** Throttled progress payload (`torrent.progress`); speeds are instantaneous bps. */
export const TorrentProgress = z.object({
  jobId: Ulid,
  /** Active torrent status: metadata | downloading | seeding. */
  phase: z.string().min(1),
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  downloadSpeedBps: z.number().int().nonnegative(),
  uploadSpeedBps: z.number().int().nonnegative(),
  peers: z.number().int().nonnegative(),
  seeds: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type TorrentProgress = z.infer<typeof TorrentProgress>;
