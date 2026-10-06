import { useEffect, type ReactNode } from "react";
import {
  Text,
  Input,
  Slider,
  Radio,
  RadioGroup,
  Field,
  Spinner,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { AppLanguage, ThemeMode } from "@unidm/contracts";
import { useSettingsStore } from "../stores/settings.js";

/**
 * Settings page — writes go through the optimistic zustand store → main → settings.json.
 * Directory picker arrives with the settings-completion phase (Phase 16); free-text absolute
 * path is the Phase 3 surface.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "20px", maxWidth: "560px" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  sectionTitle: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

export function SettingsPage(): ReactNode {
  const styles = useStyles();
  const settings = useSettingsStore((s) => s.settings);
  const status = useSettingsStore((s) => s.status);
  const error = useSettingsStore((s) => s.error);
  const load = useSettingsStore((s) => s.load);
  const update = useSettingsStore((s) => s.update);

  useEffect(() => {
    if (status === "loading") void load();
  }, [status, load]);

  if (status === "loading") return <Spinner label="Loading settings" />;
  if (status === "error" || !settings) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Failed to load settings: {error ?? "unknown error"}</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.page}>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>Settings could not be saved — {error}</MessageBarBody>
        </MessageBar>
      ) : null}

      <section className={styles.section} aria-labelledby="appearance-title">
        <Text id="appearance-title" className={styles.sectionTitle}>
          Appearance
        </Text>
        <Field label="Theme">
          <RadioGroup
            value={settings.theme}
            onChange={(_, data) => void update({ theme: data.value as ThemeMode })}
            layout="horizontal"
          >
            <Radio value="system" label="System" />
            <Radio value="light" label="Light" />
            <Radio value="dark" label="Dark" />
          </RadioGroup>
        </Field>
        <Field label="Interface language (strings localize in a later phase)">
          <RadioGroup
            value={settings.language}
            onChange={(_, data) => void update({ language: data.value as AppLanguage })}
            layout="horizontal"
          >
            <Radio value="en" label="English" />
            <Radio value="fa" label="فارسی" />
          </RadioGroup>
        </Field>
      </section>

      <section className={styles.section} aria-labelledby="download-title">
        <Text id="download-title" className={styles.sectionTitle}>
          Downloads
        </Text>
        <Field label="Default download directory" hint="Absolute path on this machine">
          <Input
            value={settings.downloadDir}
            onChange={(_, data) => void update({ downloadDir: data.value })}
          />
        </Field>
        <Field
          label={`Parallel downloads: ${settings.concurrentDownloads}`}
          hint="Applied by the download engine when starting new jobs"
        >
          <Slider
            min={1}
            max={8}
            step={1}
            value={settings.concurrentDownloads}
            onChange={(_, data) => void update({ concurrentDownloads: data.value })}
          />
        </Field>
        <Field label="Speed limit (KiB/s, 0 = unlimited)">
          <Input
            type="number"
            min={0}
            value={String(settings.speedLimitKBps)}
            onChange={(_, data) => {
              const n = Number(data.value);
              void update({ speedLimitKBps: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 });
            }}
          />
        </Field>
        <Text className={styles.hint}>
          Changes apply immediately and persist to the application profile.
        </Text>
      </section>
    </div>
  );
}
