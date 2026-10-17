import type { DownloadJob, JobDomain, MediaJob, TorrentJob } from "@syntaxdm/contracts";
import { JobEndTracker, coreStateToast, jobEndLabel } from "@syntaxdm/contracts";
import { onEvent } from "../bridge.js";
import { currentT } from "../i18n/context.js";

/**
 * Phase 17: in-app toasts. The renderer mirror of the main-side notification engine —
 * same event sources, same transition rules (the classifier itself is shared via
 * contracts), independent failure: a dead main notification surface never takes the
 * toasts down and vice versa. The bus decouples producers (event subscriptions) from
 * the ToastHost component (Fluent v9 Toaster), keeping both testable headlessly.
 */

export type ToastIntent = "success" | "error" | "info";

export interface ToastInput {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly intent: ToastIntent;
}

type Listener = (t: ToastInput) => void;

const listeners = new Set<Listener>();
let inFlight = 0;
let counter = 0;

/** Toasts shown concurrently before non-error toasts are dropped (errors always pass). */
export const MAX_CONCURRENT_TOASTS = 5;
/** Auto-dismiss windows per intent — also the in-flight slot release time. */
export const TOAST_TIMEOUT_MS: Readonly<Record<ToastIntent, number>> = {
  success: 6_000,
  info: 6_000,
  error: 10_000,
};

export function subscribeToasts(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function nextToastId(): string {
  counter = (counter + 1) % 0xffffffff;
  return `t-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Publish one toast. Over the concurrency cap, success/info toasts are dropped (a burst
 * of completions must not flood the screen); failures always pass — they need a decision.
 */
export function publishToast(t: Omit<ToastInput, "id">): void {
  if (t.intent !== "error" && inFlight >= MAX_CONCURRENT_TOASTS) return;
  inFlight += 1;
  const toast: ToastInput = { ...t, id: nextToastId() };
  setTimeout(() => {
    inFlight = Math.max(0, inFlight - 1);
  }, TOAST_TIMEOUT_MS[t.intent]);
  for (const cb of listeners) cb(toast);
}

/** Test seam: reset the in-flight accounting (id generation is intentionally untouched). */
export function resetToastBudgetForTests(): void {
  inFlight = 0;
}

/** Test seam: how many toast slots are currently occupied. */
export function toastBudgetForTests(): number {
  return inFlight;
}

/**
 * Phase 21: titles resolve through the live translator (module-level, works outside
 * React); bodies carry the job display name from the shared contracts classifier, which
 * is user data (paths/titles) plus at most the protocol error code — both stay verbatim.
 */
const completedTitleKey: Record<JobDomain, string> = {
  download: "toast.completed.download",
  media: "toast.completed.media",
  torrent: "toast.completed.torrent",
};
const failedTitleKey: Record<JobDomain, string> = {
  download: "toast.failed.download",
  media: "toast.failed.media",
  torrent: "toast.failed.torrent",
};

/** Wire every job snapshot + core lifecycle event into the toast bus (once per session). */
export function subscribeStatusToasts(): void {
  const tracker = new JobEndTracker();
  const handleJob = (domain: JobDomain, job: DownloadJob | MediaJob | TorrentJob): void => {
    const t = tracker.observe(domain, job.id, job.status);
    if (!t) return;
    const base = jobEndLabel(domain, job);
    const translator = currentT();
    if (t.kind === "completed") {
      publishToast({ title: translator(completedTitleKey[domain]), body: base, intent: "success" });
    } else {
      const code = typeof job.errorCode === "string" ? ` — ${job.errorCode}` : "";
      publishToast({ title: translator(failedTitleKey[domain]), body: `${base}${code}`, intent: "error" });
    }
  };

  onEvent("download.updated", ({ job }) => handleJob("download", job));
  onEvent("media.updated", ({ job }) => handleJob("media", job));
  onEvent("torrent.updated", ({ job }) => handleJob("torrent", job));

  let prevCore: string | undefined;
  onEvent("core.state", ({ status }) => {
    // The transition decision stays in contracts (one classifier shared with main's OS
    // notifications); only the copy is localized here, keyed by the already-known state.
    const decision = coreStateToast(prevCore, status);
    prevCore = status;
    if (!decision) return;
    const translator = currentT();
    if (status === "restarting") {
      publishToast({
        intent: "info",
        title: translator("coreToast.restarting.title"),
        body: translator("coreToast.restarting.body"),
      });
    } else {
      publishToast({
        intent: "error",
        title: translator("coreToast.unavailable.title"),
        body: translator("coreToast.unavailable.body"),
      });
    }
  });
}
