import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FluentProvider, webDarkTheme, webLightTheme, type Theme } from "@fluentui/react-components";
import { useSettingsStore } from "../stores/settings.js";
import { I18nProvider } from "../i18n/context.js";
import { resolveDir } from "../i18n/translate.js";

/**
 * Theme engine: resolves the settings theme against the OS preference (system mode) and keeps
 * following live OS changes while `theme === "system"`.
 * Phase 21: mounts the I18nProvider and hands FluentProvider the layout direction, so all
 * Fluent components mirror correctly in the Persian (RTL) interface.
 */

const QUERY = "(prefers-color-scheme: dark)";

function useSystemPrefersDark(): boolean {
  const [dark, setDark] = useState<boolean>(
    () => typeof matchMedia === "function" && matchMedia(QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const theme = useSettingsStore((s) => s.settings?.theme ?? "system");
  const systemDark = useSystemPrefersDark();
  const language = useSettingsStore((s) => s.settings?.language ?? "en");

  const fluentTheme: Theme = useMemo(() => {
    const effective: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;
    return effective === "dark" ? webDarkTheme : webLightTheme;
  }, [theme, systemDark]);

  // Layout direction follows the interface language (fa is RTL); the I18nProvider keeps
  // documentElement.lang/dir in sync and provides the translator.
  const dir = resolveDir(language);

  return (
    <I18nProvider>
      <FluentProvider theme={fluentTheme} dir={dir} style={{ height: "100vh", display: "flex" }}>
        {children}
      </FluentProvider>
    </I18nProvider>
  );
}
