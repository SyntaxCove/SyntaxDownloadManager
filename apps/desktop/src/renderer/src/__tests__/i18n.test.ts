import { describe, expect, it } from "vitest";
import { createT, interpolate, pluralKey, resolveDir, resolveLocale } from "../i18n/translate.js";
import { translatorFor } from "../i18n/context.js";
import { en } from "../i18n/dict/en.js";
import { fa } from "../i18n/dict/fa.js";
import {
  formatBitrate,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatEta,
  formatNumber,
  formatPercent,
  formatTime,
} from "../i18n/format.js";

/**
 * Phase 21 — i18n engine tests: dictionary parity (belt-and-braces over the compile-time
 * `Record<TKey, string>` check), placeholder parity, interpolation semantics, plural key
 * selection, direction/locale resolution, and deterministic Intl formatting for both
 * languages. Date assertions use LOCAL-noon epochs so they hold in any timezone.
 */

const enKeys = Object.keys(en).sort();
const faKeys = Object.keys(fa).sort();

describe("dictionaries", () => {
  it("fa covers exactly the en key set (no missing, no extra)", () => {
    expect(faKeys).toEqual(enKeys);
  });

  it("no value is empty and every value is a string", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v, `en[${k}]`).toBe("string");
      expect(v.length, `en[${k}]`).toBeGreaterThan(0);
    }
    for (const [k, v] of Object.entries(fa)) {
      expect(typeof v, `fa[${k}]`).toBe("string");
      expect(v.length, `fa[${k}]`).toBeGreaterThan(0);
    }
  });

  it("placeholder sets match between languages for every key", () => {
    const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    const enTable = en as Record<string, string>;
    const faTable = fa as Record<string, string>;
    for (const key of enKeys) {
      expect(vars(faTable[key] ?? ""), `placeholder parity for ${key}`).toEqual(vars(enTable[key] ?? ""));
    }
  });

  it("plural key pairs (.one/.other) are both present wherever one is", () => {
    const bases = new Set(
      enKeys.filter((k) => k.endsWith(".one") || k.endsWith(".other")).map((k) => k.replace(/\.(one|other)$/, "")),
    );
    for (const base of bases) {
      expect(enKeys, `en missing plural pair for ${base}`).toContain(`${base}.one`);
      expect(enKeys, `en missing plural pair for ${base}`).toContain(`${base}.other`);
      expect(faKeys, `fa missing plural pair for ${base}`).toContain(`${base}.one`);
      expect(faKeys, `fa missing plural pair for ${base}`).toContain(`${base}.other`);
    }
  });
});

describe("interpolate", () => {
  it("replaces known vars and keeps unknown placeholders visible", () => {
    expect(interpolate("Hi {name}, {n} items", { name: "A", n: 3 })).toBe("Hi A, 3 items");
    expect(interpolate("Hi {missing}", {})).toBe("Hi {missing}");
  });

  it("ignores extra vars and stringifies numbers including 0", () => {
    expect(interpolate("{a}", { a: 0, b: 1 })).toBe("0");
  });

  it("passes templates without placeholders through untouched", () => {
    expect(interpolate("plain", undefined)).toBe("plain");
  });
});

describe("pluralKey / resolution", () => {
  it("selects .one only for exactly 1", () => {
    expect(pluralKey("x", 1)).toBe("x.one");
    expect(pluralKey("x", 0)).toBe("x.other");
    expect(pluralKey("x", 2)).toBe("x.other");
  });

  it("resolves direction and locale per language", () => {
    expect(resolveDir("fa")).toBe("rtl");
    expect(resolveDir("en")).toBe("ltr");
    expect(resolveLocale("fa")).toBe("fa-IR");
    expect(resolveLocale("en")).toBe("en-US");
  });

  it("translator exposes lang/dir/locale and throws on unknown keys", () => {
    const t = translatorFor("fa");
    expect(t.lang).toBe("fa");
    expect(t.dir).toBe("rtl");
    expect(t.locale).toBe("fa-IR");
    expect(t("nav.downloads")).toBe("دریافت‌ها");
    expect(() => t("no.such.key")).toThrow(/missing key/);
    expect(createT(en, "en")("nav.downloads")).toBe("Downloads");
  });
});

describe("formatting — en-US", () => {
  const lang = "en" as const;
  it("bytes ladder", () => {
    expect(formatBytes(null, lang)).toBe("—");
    expect(formatBytes(0, lang)).toBe("0 B");
    expect(formatBytes(1536, lang)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024 * 5, lang)).toBe("5.0 MiB");
    expect(formatBytes(3 * 1024 ** 3, lang)).toBe("3.0 GiB");
  });
  it("eta ladder", () => {
    expect(formatEta(null, lang)).toBe("—");
    expect(formatEta(45, lang)).toBe("45s");
    expect(formatEta(200, lang)).toBe("3m 20s");
    expect(formatEta(3905, lang)).toBe("1h 05m");
  });
  it("percent / bitrate / duration / number", () => {
    expect(formatPercent(0.42, lang)).toBe("42%");
    expect(formatPercent(null, lang)).toBe("—");
    expect(formatBitrate(1_250_000, lang)).toBe("1.25 Mbps");
    expect(formatBitrate(null, lang)).toBe("—");
    expect(formatDuration(75, lang)).toBe("1:15");
    expect(formatDuration(3725, lang)).toBe("1:02:05");
    expect(formatDuration(null, lang)).toBe("—");
    expect(formatNumber(1024, lang)).toBe("1,024");
  });
  it("dates render Gregorian with local-noon stability", () => {
    const noon = new Date(2026, 9, 17, 12, 0, 0).getTime();
    expect(formatDate(noon, lang)).toMatch(/Oct 17, 2026/);
    expect(formatTime(new Date(2026, 9, 17, 14, 5).getTime(), lang)).toMatch(/02:05/);
    expect(formatDateTime(noon, lang)).toMatch(/Oct 17, 2026/);
  });
});

describe("formatting — fa-IR (Persian digits; dates resolve to the Jalali calendar)", () => {
  const lang = "fa" as const;
  it("bytes/eta/percent render Persian digits with Latin technical units", () => {
    expect(formatBytes(1536, lang)).toBe("۱٫۵ KiB");
    expect(formatEta(45, lang)).toBe("۴۵s");
    expect(formatPercent(0.42, lang)).toBe("۴۲٪");
    expect(formatNumber(1024, lang)).toBe("۱٬۰۲۴");
  });
  it("duration renders localized digits", () => {
    expect(formatDuration(75, lang)).toBe("۱:۱۵");
  });
  it("dates render Jalali (ICU full-icu fa-IR default)", () => {
    // 2026-10-17 == 25 Mehr 1405 (Jalali). Local-noon keeps the calendar day stable.
    const noon = new Date(2026, 9, 17, 12, 0, 0).getTime();
    expect(formatDate(noon, lang)).toMatch(/۱۴۰۵/);
    expect(formatTime(new Date(2026, 9, 17, 14, 5).getTime(), lang)).toBe("۱۴:۰۵");
  });
});
