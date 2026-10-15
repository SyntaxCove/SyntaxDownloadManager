import type { JobDomain, JobEndKind, DownloadJob, MediaJob, TorrentJob } from "@syntaxdm/contracts";
import { JobEndTracker, jobEndLabel } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { SettingsStore } from "./settings.js";

/**
 * Phase 17: OS notifications for job ends. The engine taps the router's already-validated
 * event stream and shows a native toast when a job transitions from a KNOWN ACTIVE status
 * to a meaningful end (completed / failed; torrents finish into `seeding`).
 *
 * Ground rules:
 *  - transition classification lives in contracts (`JobEndTracker`) — the single source
 *    shared with the renderer's toast surface;
 *  - the tracker map is kept across core restarts (statuses persist in the core DB and a
 *    resumed run re-emits an active status before any end state, so dedupe holds);
 *  - settings gates (`notifyOnComplete` / `notifyOnFailure`) are read live at event time;
 *  - the Electron surface is an injectable port so the engine is headless-testable; the
 *    two UI surfaces (OS notifications here, renderer toasts in app/toasts.ts) fail
 *    independently on purpose — no shared runtime dependency beyond the pure classifier.
 */

/** The main-process surface: show a toast with the given title/body. */
export interface OsNotificationPort {
  /** Whether the OS supports notifications at all (Electron: Notification.isSupported()). */
  supported(): boolean;
  show(input: { title: string; body: string }): void;
}

export interface NotifyEngineDeps {
  readonly port: OsNotificationPort;
  readonly settings: Pick<SettingsStore, "settings">;
}

const COMPLETED_TITLE: Record<JobDomain, string> = {
  download: "Download completed",
  media: "Media ready",
  torrent: "Torrent finished",
};
const FAILED_TITLE: Record<JobDomain, string> = {
  download: "Download failed",
  media: "Media job failed",
  torrent: "Torrent failed",
};

/** Build the user-facing strings for one transition (exported for tests). */
export function describeTransition(
  domain: JobDomain,
  kind: JobEndKind,
  job: DownloadJob | MediaJob | TorrentJob,
): { title: string; body: string } {
  const title = kind === "completed" ? COMPLETED_TITLE[domain] : FAILED_TITLE[domain];
  const base = jobEndLabel(domain, job);
  const errorCode = (job as { errorCode?: string | null }).errorCode;
  const body = kind === "failed" && typeof errorCode === "string" ? `${base} — ${errorCode}` : base;
  return { title, body };
}

/**
 * Wire the engine: subscribe to the router's validated event stream and show OS
 * notifications for gated transitions. Malformed payloads are impossible here (the router
 * validates before listeners run); a missing job payload is ignored defensively.
 */
export function registerNotifyEngine(router: IpcRouter, deps: NotifyEngineDeps): void {
  const tracker = new JobEndTracker();
  const jobEvents: Partial<Record<string, JobDomain>> = {
    "download.updated": "download",
    "media.updated": "media",
    "torrent.updated": "torrent",
  };
  // One listener for the whole validated stream; the router hands us (name, payload).
  router.onEvent((name, payload) => {
    const domain = jobEvents[name];
    if (!domain) return;
    const job = (payload as { job?: DownloadJob | MediaJob | TorrentJob } | null)?.job;
    if (!job || typeof job.id !== "string" || typeof job.status !== "string") return;
    const t = tracker.observe(domain, job.id, job.status);
    if (!t) return;
    if (!deps.port.supported()) return;
    if (t.kind === "completed" && !deps.settings.settings.notifyOnComplete) return;
    if (t.kind === "failed" && !deps.settings.settings.notifyOnFailure) return;
    const { title, body } = describeTransition(domain, t.kind, job);
    deps.port.show({ title, body });
  });
}
