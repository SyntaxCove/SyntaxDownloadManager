import type { AppLanguage } from "@syntaxdm/contracts";

/**
 * Phase 21 — main-process i18n. The only main-side user-visible strings are the OS
 * notification titles for job ends (domains/notify.ts); everything else main emits is
 * log/diagnostic data that deliberately stays English. Kept as pure data + one lookup so
 * the notify engine can resolve the language live from settings at event time.
 */

const COMPLETED_TITLE: Record<AppLanguage, Record<string, string>> = {
  en: { download: "Download completed", media: "Media ready", torrent: "Torrent finished" },
  fa: { download: "دریافت کامل شد", media: "رسانه آماده شد", torrent: "تورنت تمام شد" },
};

const FAILED_TITLE: Record<AppLanguage, Record<string, string>> = {
  en: { download: "Download failed", media: "Media job failed", torrent: "Torrent failed" },
  fa: { download: "دریافت ناموفق بود", media: "کار رسانه ناموفق بود", torrent: "تورنت ناموفق بود" },
};

export function jobEndTitle(lang: AppLanguage, domain: string, kind: "completed" | "failed"): string {
  const table = kind === "completed" ? COMPLETED_TITLE[lang] : FAILED_TITLE[lang];
  const fallback = kind === "completed" ? COMPLETED_TITLE.en : FAILED_TITLE.en;
  return table[domain] ?? fallback[domain] ?? "";
}
