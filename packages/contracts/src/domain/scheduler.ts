import { z } from "zod";
import { Ulid } from "../ids.js";

/** Scheduler domain (Phases 8/15) — data shape declared contract-first. */

export const SchedulerRepeat = z.enum(["none", "daily", "weekly"]);
export type SchedulerRepeat = z.infer<typeof SchedulerRepeat>;

export const SchedulerJob = z.object({
  id: Ulid,
  /** Action to run when the schedule fires, e.g. "download.start". */
  kind: z.string().min(1),
  /** Method params passed through to the target handler (validated by that handler's schema). */
  payload: z.record(z.string(), z.unknown()),
  /** Epoch ms when the job should next fire. */
  startAt: z.number().int().nonnegative(),
  repeat: SchedulerRepeat,
  enabled: z.boolean(),
});
export type SchedulerJob = z.infer<typeof SchedulerJob>;
