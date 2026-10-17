import type { AppLanguage } from "@syntaxdm/contracts";

/**
 * Phase 21 — the i18n engine, deliberately dependency-free and framework-free so it can
 * run in React components, in store-level modules outside React (toasts), and in vitest
 * without any DOM. Dictionaries are flat `Record<string, string>` objects with dotted
 * literal keys; the English dictionary is the single source of truth for the key set and
 * the Persian dictionary is compile-checked against it (`Record<TKey, string>`).
 */

/** Placeholder interpolation: "{name}" → vars.name. Missing vars stay visible as "{name}"
 * (a bug should be loud in the UI, not silently swallowed); extra vars are ignored. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * Explicit plural keys: call sites that need count-sensitive copy define BOTH
 * `${base}.one` and `${base}.other` in every dictionary and select via this helper.
 * English uses singular at exactly 1; Persian nouns after numerals stay singular, so its
 * `.one` and `.other` values may be identical — the keys still exist for parity.
 */
export function pluralKey(base: string, count: number): `${string}.one` | `${string}.other` {
  return count === 1 ? `${base}.one` : `${base}.other`;
}

export interface Translator {
  /** Look up a key in the dictionary and interpolate the given vars. */
  (key: string, vars?: Record<string, string | number>): string;
  /** The language this translator speaks. */
  readonly lang: AppLanguage;
  /** Layout direction implied by the language (fa → rtl). */
  readonly dir: "ltr" | "rtl";
  /** Locale identifier for Intl-based formatting helpers. */
  readonly locale: string;
}

export function resolveDir(lang: AppLanguage): "ltr" | "rtl" {
  return lang === "fa" ? "rtl" : "ltr";
}

export function resolveLocale(lang: AppLanguage): string {
  return lang === "fa" ? "fa-IR" : "en-US";
}

/** Build a translator over a dictionary. Unknown keys throw — a missing key is a build/
 * test-time bug (both dictionaries are compile-checked), never a runtime occurrence. */
export function createT(dict: Readonly<Record<string, string>>, lang: AppLanguage): Translator {
  const fn = (key: string, vars?: Record<string, string | number>): string => {
    const template = dict[key];
    if (typeof template !== "string") {
      throw new Error(`i18n: missing key "${key}" for language "${lang}"`);
    }
    return interpolate(template, vars);
  };
  return Object.assign(fn, {
    lang,
    dir: resolveDir(lang),
    locale: resolveLocale(lang),
  }) as Translator;
}

export type Dict = Readonly<Record<string, string>>;
