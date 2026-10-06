import { z } from "zod";
import { Ulid } from "../ids.js";

/** Torrent domain (Phase 13) — data shape declared contract-first. */

export const TorrentStatus = z.enum([
  "metadata",
  "downloading",
  "seeding",
  "paused",
  "completed",
  "failed",
]);
export type TorrentStatus = z.infer<typeof TorrentStatus>;

export const TorrentJob = z.object({
  id: Ulid,
  name: z.string().min(1),
  status: TorrentStatus,
  totalBytes: z.number().int().nonnegative().nullable(),
  receivedBytes: z.number().int().nonnegative(),
  downloadSpeedBps: z.number().nonnegative(),
  uploadSpeedBps: z.number().nonnegative(),
  peers: z.number().int().nonnegative(),
  seeds: z.number().int().nonnegative(),
  etaSeconds: z.number().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type TorrentJob = z.infer<typeof TorrentJob>;
