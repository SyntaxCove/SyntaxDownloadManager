/**
 * Phase 27: the help content registry — topics, FAQ and troubleshooting as typed
 * arrays of i18n KEYS. Text lives in `i18n/dict/help.ts` (both languages); this
 * module only defines structure, order and the engine-vocabulary links:
 *
 * - `errorCodes` entries must exist in the `downloads.hint.*` key set — a test locks
 *   this, so the docs can never drift from the error codes the engine actually emits.
 * - `openDiagnostics` entries get an "Open diagnostics" button; AppShell supplies the
 *   navigation callback (the view state is AppShell-local by design).
 *
 * `filterHelp` is the pure client-side search used by the Help page and tested here.
 */

export interface HelpTopicDef {
  readonly id: string;
  readonly titleKey: string;
  readonly points: readonly string[];
}

export interface HelpFaqDef {
  readonly id: string;
  readonly qKey: string;
  readonly aKey: string;
}

export interface HelpTroubleDef {
  readonly id: string;
  readonly symptomKey: string;
  readonly causes: readonly string[];
  readonly steps: readonly string[];
  readonly openDiagnostics?: boolean;
  /** Engine error codes referenced by this entry (subset of downloads.hint.*). */
  readonly errorCodes?: readonly string[];
}

export const HELP_TOPICS: readonly HelpTopicDef[] = [
  {
    id: "getting-started",
    titleKey: "help.topic.getting-started.title",
    points: [
      "help.topic.getting-started.p1",
      "help.topic.getting-started.p2",
      "help.topic.getting-started.p3",
      "help.topic.getting-started.p4",
    ],
  },
  {
    id: "downloads",
    titleKey: "help.topic.downloads.title",
    points: [
      "help.topic.downloads.p1",
      "help.topic.downloads.p2",
      "help.topic.downloads.p3",
      "help.topic.downloads.p4",
    ],
  },
  {
    id: "browser",
    titleKey: "help.topic.browser.title",
    points: [
      "help.topic.browser.p1",
      "help.topic.browser.p2",
      "help.topic.browser.p3",
    ],
  },
  {
    id: "proxies",
    titleKey: "help.topic.proxies.title",
    points: [
      "help.topic.proxies.p1",
      "help.topic.proxies.p2",
      "help.topic.proxies.p3",
    ],
  },
  {
    id: "media",
    titleKey: "help.topic.media.title",
    points: [
      "help.topic.media.p1",
      "help.topic.media.p2",
      "help.topic.media.p3",
    ],
  },
  {
    id: "torrents",
    titleKey: "help.topic.torrents.title",
    points: [
      "help.topic.torrents.p1",
      "help.topic.torrents.p2",
      "help.topic.torrents.p3",
    ],
  },
  {
    id: "scheduler",
    titleKey: "help.topic.scheduler.title",
    points: ["help.topic.scheduler.p1", "help.topic.scheduler.p2"],
  },
  {
    id: "library",
    titleKey: "help.topic.library.title",
    points: ["help.topic.library.p1", "help.topic.library.p2"],
  },
  {
    id: "updates",
    titleKey: "help.topic.updates.title",
    points: [
      "help.topic.updates.p1",
      "help.topic.updates.p2",
      "help.topic.updates.p3",
    ],
  },
  {
    id: "privacy",
    titleKey: "help.topic.privacy.title",
    points: [
      "help.topic.privacy.p1",
      "help.topic.privacy.p2",
      "help.topic.privacy.p3",
    ],
  },
];

export const HELP_FAQ: readonly HelpFaqDef[] = [
  { id: "data-storage", qKey: "help.faq.data-storage.q", aKey: "help.faq.data-storage.a" },
  { id: "need-tools", qKey: "help.faq.need-tools.q", aKey: "help.faq.need-tools.a" },
  { id: "auto-pause", qKey: "help.faq.auto-pause.q", aKey: "help.faq.auto-pause.a" },
  { id: "proxy-scope", qKey: "help.faq.proxy-scope.q", aKey: "help.faq.proxy-scope.a" },
  { id: "ai", qKey: "help.faq.ai.q", aKey: "help.faq.ai.a" },
  { id: "drm", qKey: "help.faq.drm.q", aKey: "help.faq.drm.a" },
  { id: "smartscreen", qKey: "help.faq.smartscreen.q", aKey: "help.faq.smartscreen.a" },
  { id: "verify-checksum", qKey: "help.faq.verify-checksum.q", aKey: "help.faq.verify-checksum.a" },
  { id: "core-restart", qKey: "help.faq.core-restart.q", aKey: "help.faq.core-restart.a" },
  { id: "export-logs", qKey: "help.faq.export-logs.q", aKey: "help.faq.export-logs.a" },
];

export const HELP_TROUBLE: readonly HelpTroubleDef[] = [
  {
    id: "download-failed",
    symptomKey: "help.trouble.download-failed.symptom",
    causes: ["help.trouble.download-failed.cause1"],
    steps: [
      "help.trouble.download-failed.step1",
      "help.trouble.download-failed.step2",
      "help.trouble.download-failed.step3",
      "help.trouble.download-failed.step4",
      "help.trouble.download-failed.step5",
    ],
    openDiagnostics: true,
    errorCodes: ["source_gone", "source_forbidden", "source_changed", "network_error", "http_error"],
  },
  {
    id: "download-stuck",
    symptomKey: "help.trouble.download-stuck.symptom",
    causes: ["help.trouble.download-stuck.cause1"],
    steps: [
      "help.trouble.download-stuck.step1",
      "help.trouble.download-stuck.step2",
      "help.trouble.download-stuck.step3",
      "help.trouble.download-stuck.step4",
    ],
  },
  {
    id: "proxy-fail",
    symptomKey: "help.trouble.proxy-fail.symptom",
    causes: ["help.trouble.proxy-fail.cause1"],
    steps: [
      "help.trouble.proxy-fail.step1",
      "help.trouble.proxy-fail.step2",
      "help.trouble.proxy-fail.step3",
    ],
  },
  {
    id: "core-unavailable",
    symptomKey: "help.trouble.core-unavailable.symptom",
    causes: ["help.trouble.core-unavailable.cause1"],
    steps: [
      "help.trouble.core-unavailable.step1",
      "help.trouble.core-unavailable.step2",
      "help.trouble.core-unavailable.step3",
    ],
    openDiagnostics: true,
  },
  {
    id: "toolkit-error",
    symptomKey: "help.trouble.toolkit-error.symptom",
    causes: ["help.trouble.toolkit-error.cause1"],
    steps: [
      "help.trouble.toolkit-error.step1",
      "help.trouble.toolkit-error.step2",
      "help.trouble.toolkit-error.step3",
      "help.trouble.toolkit-error.step4",
    ],
    openDiagnostics: true,
  },
  {
    id: "page-not-loading",
    symptomKey: "help.trouble.page-not-loading.symptom",
    causes: ["help.trouble.page-not-loading.cause1"],
    steps: [
      "help.trouble.page-not-loading.step1",
      "help.trouble.page-not-loading.step2",
      "help.trouble.page-not-loading.step3",
    ],
  },
  {
    id: "app-crash",
    symptomKey: "help.trouble.app-crash.symptom",
    causes: ["help.trouble.app-crash.cause1"],
    steps: [
      "help.trouble.app-crash.step1",
      "help.trouble.app-crash.step2",
      "help.trouble.app-crash.step3",
    ],
    openDiagnostics: true,
  },
  {
    id: "update-fail",
    symptomKey: "help.trouble.update-fail.symptom",
    causes: ["help.trouble.update-fail.cause1"],
    steps: [
      "help.trouble.update-fail.step1",
      "help.trouble.update-fail.step2",
      "help.trouble.update-fail.step3",
    ],
  },
  {
    id: "torrent-stall",
    symptomKey: "help.trouble.torrent-stall.symptom",
    causes: ["help.trouble.torrent-stall.cause1"],
    steps: [
      "help.trouble.torrent-stall.step1",
      "help.trouble.torrent-stall.step2",
      "help.trouble.torrent-stall.step3",
      "help.trouble.torrent-stall.step4",
    ],
  },
];

export interface HelpSearchItem {
  readonly id: string;
  /** Every translatable string of the entry, joined — the filter's haystack. */
  readonly text: string;
}

/**
 * Pure, locale-agnostic filter: an entry matches when its whole text contains the
 * (trimmed, lowercased) query. An empty/whitespace query selects everything. Search
 * remains a plain substring match in both languages — no stemming, no magic.
 */
export function filterHelp(query: string, items: readonly HelpSearchItem[]): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items.map((i) => i.id);
  return items.filter((i) => i.text.toLowerCase().includes(needle)).map((i) => i.id);
}
