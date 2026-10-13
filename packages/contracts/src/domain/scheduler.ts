import { z } from "zod";
import { Ulid } from "../ids.js";
import { DownloadCreateParams } from "./download.js";
import { MediaDownloadParams } from "./media.js";
import { TorrentAddParams } from "./torrent.js";

/**
 * Scheduler domain — activated in v1.10 (Phase 15).
 *
 * The v1 file was a contract-first stub with zero consumers (no methods, no events, no UI),
 * so activating it is classified as an additive minor bump. The stub's `SchedulerRepeat`
 * enum values ("none" | "daily" | "weekly") are preserved verbatim; everything else is
 * built out.
 *
 * Engine posture: scheduler jobs are persistent rows in the core's SQLite database
 * (storage v9) fired by a 1 s tick inside the Rust core — the schedule survives renderer
 * reloads, core restarts and app shutdowns. Actions are a CLOSED enum dispatched through
 * the same manager paths the IPC handlers use; a job's payload is validated per kind with
 * exactly the target method's params schema. Recurring occurrences advance in local wall
 * clock (main pushes the tz offset via `scheduler.setClock`); runs missed while the app
 * was closed catch up at the first tick after boot.
 */

export const SchedulerAction = z.enum([
  "download.create",
  "download.startAll",
  "download.pauseAll",
  "media.download",
  "torrent.add",
]);
export type SchedulerAction = z.infer<typeof SchedulerAction>;

/** Preserved verbatim from the v1 stub. */
export const SchedulerRepeat = z.enum(["none", "daily", "weekly"]);
export type SchedulerRepeat = z.infer<typeof SchedulerRepeat>;

/** Payload schema per action kind — the target method's own params, nothing looser. */
const SchedulerEmptyPayload = z.strictObject({});
export const SCHEDULER_PAYLOAD_SCHEMAS: Readonly<
  Record<z.infer<typeof SchedulerAction>, z.ZodType<unknown>>
> = Object.freeze({
  "download.create": DownloadCreateParams,
  "download.startAll": SchedulerEmptyPayload,
  "download.pauseAll": SchedulerEmptyPayload,
  "media.download": MediaDownloadParams,
  "torrent.add": TorrentAddParams,
});

/**
 * A persistent scheduler job — mirrors the core's SQLite row. The payload is opaque here
 * (validated per kind at the create/update boundary); `nextRunAt`/`lastFiredAt` are null
 * until the core computes/fires them (nullable = always serialized on the wire).
 */
export const SchedulerJob = z.object({
  id: Ulid,
  kind: SchedulerAction,
  payload: z.record(z.string(), z.unknown()),
  /** Epoch ms of the schedule anchor (first occurrence). May be in the past → catch-up. */
  startAt: z.number().int().nonnegative(),
  repeat: SchedulerRepeat,
  enabled: z.boolean(),
  /** Epoch ms of the next due fire; null = nothing scheduled (fired one-shot / disabled). */
  nextRunAt: z.number().int().nonnegative().nullable(),
  /** Epoch ms of the most recent fire; null = never fired. */
  lastFiredAt: z.number().int().nonnegative().nullable(),
  /** "ok" or the classified error code produced by the fired action; null = never fired. */
  lastResultCode: z.string().min(1).nullable(),
  /** Human-readable outcome detail; null = never fired. */
  lastResultMessage: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type SchedulerJob = z.infer<typeof SchedulerJob>;

export const SchedulerListParams = z.object({});
export const SchedulerListResult = z.object({ jobs: z.array(SchedulerJob) });
export type SchedulerListResult = z.infer<typeof SchedulerListResult>;

export const SchedulerCreateParams = z
  .object({
    kind: SchedulerAction,
    payload: z.record(z.string(), z.unknown()),
    startAt: z.number().int().nonnegative(),
    repeat: SchedulerRepeat,
    /** Default true; false parks the job (it never fires until re-enabled). */
    enabled: z.boolean().optional().default(true),
  })
  .superRefine((p, ctx) => {
    const verdict = SCHEDULER_PAYLOAD_SCHEMAS[p.kind].safeParse(p.payload);
    if (!verdict.success) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: `payload does not match ${p.kind}: ${verdict.error.message}`,
      });
    }
  });
export type SchedulerCreateParams = z.infer<typeof SchedulerCreateParams>;

export const SchedulerCreateResult = z.object({ job: SchedulerJob });
export type SchedulerCreateResult = z.infer<typeof SchedulerCreateResult>;

/**
 * Patch semantics: every present key is applied. `kind` is immutable (create a new job
 * instead — keeps the audit trail coherent). A replacement `payload` is re-validated by
 * the core against the row's kind (the boundary does not know the kind, so it validates
 * shape only and lets the authoritative side enforce the per-kind schema).
 */
export const SchedulerUpdateParams = z.object({
  id: Ulid,
  patch: z.object({
    startAt: z.number().int().nonnegative().optional(),
    repeat: SchedulerRepeat.optional(),
    enabled: z.boolean().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type SchedulerUpdateParams = z.infer<typeof SchedulerUpdateParams>;

export const SchedulerUpdateResult = z.object({ job: SchedulerJob });
export type SchedulerUpdateResult = z.infer<typeof SchedulerUpdateResult>;

export const SchedulerJobIdParams = z.object({ id: Ulid });
export const SchedulerJobByIdResult = z.object({ job: SchedulerJob });
export type SchedulerJobByIdResult = z.infer<typeof SchedulerJobByIdResult>;

export const SchedulerRemoveResult = z.object({ removed: z.literal(true) });

/** Fire immediately regardless of the schedule; the outcome is recorded, the schedule is untouched. */
export const SchedulerRunNowResult = z.object({ job: SchedulerJob });
export type SchedulerRunNowResult = z.infer<typeof SchedulerRunNowResult>;

/** Main → core only (like `download.setPolicy`): the local-UTC offset for wall-clock recurrence. */
export const SchedulerSetClockParams = z.object({
  tzOffsetMinutes: z.number().int().min(-840).max(840),
});
export const SchedulerSetClockResult = z.object({ applied: z.literal(true) });

/** Authoritative snapshot whenever a scheduler row changes (create/update/remove-fire). */
export const SchedulerUpdatedEvent = z.object({ job: SchedulerJob });
