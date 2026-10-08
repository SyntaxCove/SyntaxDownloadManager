import { useEffect, type ReactNode } from "react";
import {
  Text,
  Input,
  Slider,
  Radio,
  RadioGroup,
  Switch,
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
        <Field
          label={`Connections per download: ${settings.maxConnectionsPerDownload}`}
          hint="Parallel range connections used to accelerate a single download (1 = single stream)"
        >
          <Slider
            min={1}
            max={16}
            step={1}
            value={settings.maxConnectionsPerDownload}
            onChange={(_, data) => void update({ maxConnectionsPerDownload: data.value })}
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
        <Field
          label="Start new downloads automatically"
          hint="When off, new downloads wait as Paused until you start them"
        >
          <Switch
            checked={settings.autoStartNewDownloads}
            onChange={(_, data) => void update({ autoStartNewDownloads: data.checked })}
          />
        </Field>
        <Field
          label="Scheduled download window"
          hint="Outside the window, auto-started runs pause; downloads you start manually keep running"
        >
          <Switch
            checked={settings.scheduleEnabled}
            onChange={(_, data) => void update({ scheduleEnabled: data.checked })}
          />
        </Field>
        {settings.scheduleEnabled ? (
          <Field label="Daily window (local time, 24h)" hint="Wrap-over windows (e.g. 22:00 → 06:00) are supported">
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <Input
                type="time"
                value={settings.scheduleStart}
                onChange={(_, data) => {
                  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(data.value)) {
                    void update({ scheduleStart: data.value });
                  }
                }}
                aria-label="Window start"
              />
              <Text className={styles.hint}>to</Text>
              <Input
                type="time"
                value={settings.scheduleEnd}
                onChange={(_, data) => {
                  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(data.value)) {
                    void update({ scheduleEnd: data.value });
                  }
                }}
                aria-label="Window end"
              />
            </div>
          </Field>
        ) : null}
        <Text className={styles.hint}>
          Changes apply immediately and persist to the application profile.
        </Text>
      </section>
    </div>
  );
}
