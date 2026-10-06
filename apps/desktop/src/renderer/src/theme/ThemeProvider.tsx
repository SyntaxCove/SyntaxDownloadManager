import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FluentProvider, webDarkTheme, webLightTheme, type Theme } from "@fluentui/react-components";
import { useSettingsStore } from "../stores/settings.js";

/**
 * Theme engine: resolves the settings theme against the OS preference (system mode) and keeps
 * following live OS changes while `theme === "system"`.
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

  // Layout direction follows the interface language (fa is RTL); string localization ships in
  // the i18n phase, but direction is structural and must be correct from the start.
  useEffect(() => {
    document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
    document.documentElement.lang = language;
  }, [language]);

  return <FluentProvider theme={fluentTheme} style={{ height: "100vh", display: "flex" }}>{children}</FluentProvider>;
}
