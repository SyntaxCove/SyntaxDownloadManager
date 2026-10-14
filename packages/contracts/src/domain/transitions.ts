import type { DownloadStatus } from "./download.js";
import type { MediaJobStatus } from "./media.js";
import type { TorrentStatus } from "./torrent.js";

/**
 * Job end-transition classification (Phase 17) — the shared meaning of the status enums
 * for the two notification surfaces (main's OS notifications and the renderer's toasts).
 * Pure logic: no timers, no DOM, no Electron, fully unit-tested.
 *
 * Rules:
 *  - only a KNOWN ACTIVE previous status may transition to an end state (repeat terminal
 *    snapshots, boot snapshots for rows that ended earlier, and removal-time `completed`
 *    stay silent — the core emits `*.updated` only on real transitions, but the engine
 *    must never trust that alone);
 *  - `canceled` is user-initiated and is never an end worth notifying;
 *  - a torrent finishes into `seeding` (all pieces verified) — `completed` appears only
 *    when the job is removed, so it is NOT the download-finished moment.
 */

/** Domains that emit `*.updated` job snapshots (browser/history rows are not jobs). */
export type JobDomain = "download" | "media" | "torrent";

/** End states the user is told about. */
export type JobEndKind = "completed" | "failed";

const ACTIVE_STATUSES: Readonly<Record<JobDomain, ReadonlySet<string>>> = {
  download: new Set<string>(["queued", "probing", "downloading"] satisfies readonly DownloadStatus[] as readonly string[]),
  media: new Set<string>(["queued", "extracting", "downloading", "muxing"] satisfies readonly MediaJobStatus[] as readonly string[]),
  torrent: new Set<string>(["queued", "metadata", "downloading"] satisfies readonly TorrentStatus[] as readonly string[]),
};

/** Torrent "done" is `seeding`; other domains end at `completed`. */
export function jobEndKind(domain: JobDomain, status: string): JobEndKind | null {
  if (status === "failed") return "failed";
  if (domain === "torrent") return status === "seeding" ? "completed" : null;
  return status === "completed" ? "completed" : null;
}

export interface JobEndTransition {
  readonly domain: JobDomain;
  readonly jobId: string;
  readonly kind: JobEndKind;
}

/**
 * Feed every validated `*.updated` snapshot through `observe`; it answers with at most
 * one transition per real active→end change per job. The map is intentionally NOT
 * cleared on core restarts: statuses persist in the core database and a resumed run
 * re-emits an active status before any end state, so dedupe holds across restarts.
 */
export class JobEndTracker {
  private readonly last = new Map<JobDomain, Map<string, string>>();

  observe(domain: JobDomain, jobId: string, status: string): JobEndTransition | null {
    let seen = this.last.get(domain);
    if (!seen) {
      seen = new Map();
      this.last.set(domain, seen);
    }
    const prev = seen.get(jobId);
    seen.set(jobId, status);

    const wasActive = prev !== undefined && ACTIVE_STATUSES[domain].has(prev);
    if (!wasActive) return null;
    const kind = jobEndKind(domain, status);
    if (!kind) return null;
    return { domain, jobId, kind };
  }

  /** Test seam: whether a job id is being tracked for a domain. */
  tracked(domain: JobDomain, jobId: string): boolean {
    return this.last.get(domain)?.has(jobId) ?? false;
  }
}

/** Windows-safe basename (slashes and backslashes) + hard length cap for toast bodies. */
export function jobDisplayName(p: string, max = 120): string {
  const parts = p.split(/[/\\]/);
  const base = parts[parts.length - 1] || p;
  return base.length <= max ? base : `${base.slice(0, max - 1)}…`;
}

/** User-facing label for a job snapshot (exported for tests and both surfaces). */
export function jobEndLabel(
  domain: JobDomain,
  job: { destinationPath?: string | null; filename?: string | null; url?: string }
    & { title?: string | null; sourceUrl?: string }
    & { name?: string | null; infoHash?: string | null; errorCode?: string | null },
): string {
  let label = "";
  if (domain === "download") {
    label = job.destinationPath ?? job.filename ?? job.url ?? "download";
  } else if (domain === "media") {
    label = job.title ?? job.destinationPath ?? job.sourceUrl ?? "media";
  } else {
    label = job.name ?? job.infoHash ?? "torrent";
  }
  return jobDisplayName(label);
}

/** Core lifecycle states that are worth a toast, keyed by the previous state. */
export function coreStateToast(
  prev: string | undefined,
  next: string,
): { intent: "error" | "info"; title: string; body: string } | null {
  if (next === "restarting" && (prev === "ready" || prev === "unavailable")) {
    return {
      intent: "info",
      title: "Download engine restarting",
      body: "Active downloads pause briefly and resume automatically.",
    };
  }
  if (next === "unavailable" && (prev === "ready" || prev === "restarting")) {
    return {
      intent: "error",
      title: "Download engine unavailable",
      body: "Downloads are paused. The app keeps retrying — your jobs and bytes are safe.",
    };
  }
  return null; // boot (starting → ready) and no-op transitions stay silent
}
