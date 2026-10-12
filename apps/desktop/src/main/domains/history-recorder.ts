/**
 * History visit recorder (Phase 14).
 *
 * Decision logic for which navigations become persistent history rows. Pure and unit-tested:
 * the TabManager only supplies WebContents events. Rules:
 *  - http/https main-frame navigations only (about:/devtools:/chrome:/data:/blob:/file: and
 *    anything unparsable are never recorded);
 *  - a repeated settle of the same URL in the same tab within DEDUPE_MS collapses to one
 *    visit (load cycles + in-page/settle overlap double-fire in practice);
 *  - reloads and back/forward revisits ARE recorded — each is a real visit.
 */

export interface RecordedVisit {
  url: string;
  title: string | null;
  faviconUrl: string | null;
  visitedAt: number;
}

/** Same-URL settle window per tab (ms). */
export const DEDUPE_MS = 1_500;

const RECORDABLE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** True when a URL may be recorded (http/https only, anything else excluded). */
export function isRecordableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return RECORDABLE_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

export interface VisitCandidate {
  tabId: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  at: number;
}

/**
 * Per-tab dedupe gate. `admit` returns the visit to record, or null when the tab settled
 * the same URL within the dedupe window. Memory stays bounded: one small entry per open tab,
 * evicted when the tab is forgotten.
 */
export class VisitRecorder {
  private readonly last = new Map<string, { url: string; at: number }>();

  admit(candidate: VisitCandidate): RecordedVisit | null {
    if (!isRecordableUrl(candidate.url)) return null;
    const previous = this.last.get(candidate.tabId);
    if (
      previous &&
      previous.url === candidate.url &&
      candidate.at - previous.at < DEDUPE_MS
    ) {
      // Dropped WITHOUT refreshing the anchor: the window stays pinned to the first
      // admission, so repeated manual reloads record again 1.5s after the last real visit.
      return null;
    }
    this.last.set(candidate.tabId, { url: candidate.url, at: candidate.at });
    return {
      url: candidate.url,
      title: candidate.title,
      faviconUrl: candidate.faviconUrl,
      visitedAt: candidate.at,
    };
  }

  forget(tabId: string): void {
    this.last.delete(tabId);
  }
}
