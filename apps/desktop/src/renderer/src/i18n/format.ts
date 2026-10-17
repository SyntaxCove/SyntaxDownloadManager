import type { AppLanguage } from "@syntaxdm/contracts";
import { resolveLocale } from "./translate.js";

/**
 * Phase 21 — locale-aware formatting helpers. All are pure and take the language
 * explicitly, so tests are deterministic and pages simply forward their translator's
 * `lang`. Numeric rendering uses `Intl.NumberFormat` (fa-IR renders Persian digits),
 * dates use `Intl.DateTimeFormat` (fa-IR resolves to the Persian calendar by ICU
 * default — the expected presentation for Persian users). Unit words come from the
 * dictionaries via the page-side `t()`, keeping every user-visible word in one place.
 */

function nf(lang: AppLanguage, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  // Intl instances are cheap but not free; progress-heavy pages re-render often, so a
  // tiny per-language cache keyed by options identity is not worth the complexity —
  // measure first (YAGNI). Construction cost is ~microseconds.
  return new Intl.NumberFormat(resolveLocale(lang), options);
}

/** 1536 → "1.5 KiB" (en) / "۱٫۵ کیب" (fa, unit word supplied by the caller). */
export function formatBytes(bytes: number | null | undefined, lang: AppLanguage): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rendered =
    value >= 100 || unit === 0
      ? nf(lang, { maximumFractionDigits: 0 }).format(value)
      : nf(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  return `${rendered} ${units[unit]}`;
}

/** Seconds → "45s" / "3m 20s" / "1h 05m" with localized digits. */
export function formatEta(seconds: number | null | undefined, lang: AppLanguage): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const n = nf(lang, { maximumFractionDigits: 0 });
  if (seconds < 60) return `${n.format(seconds)}s`;
  if (seconds < 3600) return `${n.format(Math.floor(seconds / 60))}m ${n.format(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${n.format(h)}h ${m < 10 ? `0${n.format(m)}` : n.format(m)}m`;
}

/** 0..1 → "42%" with localized digits (null renders the em-dash placeholder). */
export function formatPercent(fraction: number | null | undefined, lang: AppLanguage): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return nf(lang, {
    style: "percent",
    maximumFractionDigits: Math.min(1, fraction) === fraction && fraction < 0.1 ? 1 : 0,
  }).format(fraction);
}

/** 1 250 000 bps → "1.25 Mbps" with localized digits. */
export function formatBitrate(bps: number | null, lang: AppLanguage): string {
  if (bps === null || !Number.isFinite(bps)) return "—";
  return `${nf(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bps / 1_000_000)} Mbps`;
}

/** Seconds → mm:ss / h:mm:ss (media duration) with localized digits. */
export function formatDuration(seconds: number | null, lang: AppLanguage): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (v: number): string => (v < 10 ? `0${nf(lang).format(v)}` : nf(lang).format(v));
  return h > 0
    ? `${nf(lang).format(h)}:${pad(m)}:${pad(s)}`
    : `${nf(lang).format(m)}:${pad(s)}`;
}

/** Epoch ms → localized long date ("Oct 17, 2026" / "۲۷ مهر ۱۴۰۵"). */
export function formatDate(ms: number, lang: AppLanguage): string {
  return new Intl.DateTimeFormat(resolveLocale(lang), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

/** Epoch ms → localized clock time ("14:05" / "۱۴:۰۵"). */
export function formatTime(ms: number, lang: AppLanguage): string {
  return new Intl.DateTimeFormat(resolveLocale(lang), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Epoch ms → localized date + time (scheduler anchors, update checks). */
export function formatDateTime(ms: number, lang: AppLanguage): string {
  return new Intl.DateTimeFormat(resolveLocale(lang), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Plain localized integer ("1,024" / "۱٬۰۲۴"). */
export function formatNumber(n: number, lang: AppLanguage): string {
  return nf(lang, { maximumFractionDigits: 0 }).format(n);
}
