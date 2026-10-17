import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { AppLanguage } from "@syntaxdm/contracts";
import { useSettingsStore } from "../stores/settings.js";
import { createT, resolveDir, resolveLocale, type Translator } from "./translate.js";
import { en } from "./dict/en.js";
import { fa } from "./dict/fa.js";

/**
 * Phase 21 — i18n provider. Reads the persisted `settings.language` and exposes a
 * translator via context; also maintains a module-level mirror so non-React modules
 * (the toast bus, store-level helpers) can localize at event time, and so vitest can
 * assert against a real translator without mounting React.
 *
 * Language changes apply live: the context value changes (every consumer re-renders),
 * `dir` flips structural layout for FluentProvider, and the provider keeps
 * `documentElement.lang/dir` in sync (Phase 3 groundwork extended here).
 */

const DICTS: Readonly<Record<AppLanguage, Readonly<Record<string, string>>>> = { en, fa };

/** Module-level current translator — defaults to English until the provider mounts. */
let currentTranslator: Translator = createT(en, "en");

/** Access the live translator outside React (toasts, tests). */
export function currentT(): Translator {
  return currentTranslator;
}

/** Test seam: force the module-level translator (tests never mount the provider). */
export function setTranslatorForTests(lang: AppLanguage): void {
  currentTranslator = createT(DICTS[lang], lang);
}

export interface I18nValue {
  readonly t: Translator;
  readonly lang: AppLanguage;
  readonly dir: "ltr" | "rtl";
  readonly locale: string;
}

const I18nContext = createContext<I18nValue>({ t: currentTranslator, lang: "en", dir: "ltr", locale: "en-US" });

/** Hook: the active translator + language + direction + locale. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function translatorFor(lang: AppLanguage): Translator {
  return createT(DICTS[lang], lang);
}

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const language = useSettingsStore((s) => s.settings?.language ?? "en");

  const value = useMemo<I18nValue>(() => {
    const t = translatorFor(language);
    return { t, lang: language, dir: resolveDir(language), locale: resolveLocale(language) };
  }, [language]);

  // Mirror into module scope for non-React consumers; keep the document attributes in
  // sync (screen readers read `lang`, CSS and Fluent read `dir`).
  currentTranslator = value.t;
  useEffect(() => {
    currentTranslator = value.t;
    document.documentElement.lang = value.lang;
    document.documentElement.dir = value.dir;
  }, [value]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
