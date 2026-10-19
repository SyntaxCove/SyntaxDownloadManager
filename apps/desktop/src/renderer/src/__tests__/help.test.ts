import { describe, expect, it } from "vitest";
import { translatorFor } from "../i18n/context.js";
import { en } from "../i18n/dict/en.js";
import { fa } from "../i18n/dict/fa.js";
import {
  HELP_FAQ,
  HELP_TOPICS,
  HELP_TROUBLE,
  filterHelp,
  type HelpSearchItem,
} from "../pages/help/content.js";

/**
 * Phase 27: help content structure invariants. The translator throws on unknown
 * keys, so "resolving every key of every entry in BOTH languages" is a complete
 * existence + parity proof for the help registry; the remaining tests lock the
 * engine-vocabulary link (error codes) and the search behavior.
 */

const enT = translatorFor("en");
const faT = translatorFor("fa");

function allHelpKeys(): string[] {
  const keys: string[] = [];
  for (const topic of HELP_TOPICS) {
    keys.push(topic.titleKey, ...topic.points);
  }
  for (const entry of HELP_FAQ) {
    keys.push(entry.qKey, entry.aKey);
  }
  for (const entry of HELP_TROUBLE) {
    keys.push(entry.symptomKey, ...entry.causes, ...entry.steps);
  }
  return keys;
}

describe("help content structure", () => {
  it("has unique ids across topics, FAQ and troubleshooting", () => {
    const ids = [
      ...HELP_TOPICS.map((t) => t.id),
      ...HELP_FAQ.map((f) => f.id),
      ...HELP_TROUBLE.map((t) => t.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has non-empty counts of each content kind", () => {
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(10);
    expect(HELP_FAQ.length).toBeGreaterThanOrEqual(10);
    expect(HELP_TROUBLE.length).toBeGreaterThanOrEqual(9);
  });

  it("resolves every key in English and Persian with non-empty text", () => {
    for (const key of allHelpKeys()) {
      expect(() => enT(key)).not.toThrow();
      expect(() => faT(key)).not.toThrow();
      expect(enT(key).trim().length, `en ${key}`).toBeGreaterThan(0);
      expect(faT(key).trim().length, `fa ${key}`).toBeGreaterThan(0);
    }
  });

  it("never leaves a troubleshooting entry without causes or steps", () => {
    for (const entry of HELP_TROUBLE) {
      expect(entry.causes.length, entry.id).toBeGreaterThan(0);
      expect(entry.steps.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("keeps nav.help and the page chrome localized", () => {
    for (const key of ["nav.help", "help.page.title", "help.search.placeholder", "help.tab.trouble"] as const) {
      expect(enT(key).trim().length).toBeGreaterThan(0);
      expect(faT(key).trim().length).toBeGreaterThan(0);
    }
    // F-1 lock: the diagnostics export toasts stay localized.
    expect(enT("diag.toast.exported").trim().length).toBeGreaterThan(0);
    expect(faT("diag.toast.exported").trim().length).toBeGreaterThan(0);
    expect(enT("diag.toast.exportFailed")).toBe("Export failed");
    expect(faT("diag.toast.exportFailed")).not.toBe("Export failed");
  });

  it("only references error codes the engine actually emits (downloads.hint.*)", () => {
    const known = new Set(
      Object.keys(en)
        .filter((k) => k.startsWith("downloads.hint."))
        .map((k) => k.slice("downloads.hint.".length)),
    );
    expect(known).toContain("source_gone");
    const referenced = HELP_TROUBLE.flatMap((t) => t.errorCodes ?? []);
    expect(referenced.length).toBeGreaterThan(0);
    for (const code of referenced) {
      expect(known.has(code), `code ${code} must exist as downloads.hint.${code}`).toBe(true);
    }
  });
});

describe("filterHelp", () => {
  const items: readonly HelpSearchItem[] = [
    { id: "proxies", text: "Create proxy profiles (HTTP, HTTPS, SOCKS) and attach them" },
    { id: "proxies-fa", text: "پروفایل‌های پروکسی (HTTP، HTTPS، SOCKS) بسازید" },
    { id: "downloads", text: "Downloads are segmented and transferred over multiple connections" },
  ];

  it("empty or whitespace query selects everything in order", () => {
    expect(filterHelp("", items)).toEqual(["proxies", "proxies-fa", "downloads"]);
    expect(filterHelp("   ", items)).toEqual(["proxies", "proxies-fa", "downloads"]);
  });

  it("matches case-insensitively in English", () => {
    expect(filterHelp("PROXY", items)).toEqual(["proxies"]);
    expect(filterHelp("segmented", items)).toEqual(["downloads"]);
  });

  it("matches Persian queries against Persian text", () => {
    expect(filterHelp("پروکسی", items)).toEqual(["proxies-fa"]);
  });

  it("returns nothing for a nonsense query", () => {
    expect(filterHelp("zzzz-not-a-word", items)).toEqual([]);
  });

  it("finds entries through the real dictionaries in both languages", () => {
    const enItems = HELP_TROUBLE.map((d) => ({
      id: d.id,
      text: [d.symptomKey, ...d.causes, ...d.steps].map((k) => enT(k)).join(" "),
    }));
    expect(filterHelp("fail-closed", enItems)).toContain("proxy-fail");
    expect(filterHelp("SmartScreen", enItems)).toEqual([]);

    const faItems = HELP_TROUBLE.map((d) => ({
      id: d.id,
      text: [d.symptomKey, ...d.causes, ...d.steps].map((k) => faT(k)).join(" "),
    }));
    expect(filterHelp("بسته-در-خطا", faItems)).toContain("proxy-fail");
    expect(filterHelp("شکست خورد", faItems)).toContain("download-failed");
  });
});
