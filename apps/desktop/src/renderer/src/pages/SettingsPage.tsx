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
  Button,
  ProgressBar,
  Badge,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { AppLanguage, ThemeMode, ToolkitToolStatus } from "@unidm/contracts";
import { useSettingsStore } from "../stores/settings.js";
import { useToolkitStore } from "../stores/toolkit.js";

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
  toolRow: { display: "flex", flexDirection: "column", gap: "6px" },
  toolHead: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    justifyContent: "space-between",
  },
  toolName: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
});

const TOOL_LABELS: Record<ToolkitToolStatus["id"], string> = {
  ffmpeg: "FFmpeg (media muxing)",
  "yt-dlp": "yt-dlp (media extraction)",
  deno: "Deno (site script runtime)",
};

function stateBadge(state: ToolkitToolStatus["state"]): ReactNode {
  switch (state) {
    case "ready":
      return <Badge appearance="filled" color="success">Ready</Badge>;
    case "fetching":
      return <Badge appearance="tint" color="informative">Fetching…</Badge>;
    case "verifying":
      return <Badge appearance="tint" color="informative">Verifying…</Badge>;
    case "failed":
      return <Badge appearance="filled" color="danger">Failed</Badge>;
    default:
      return <Badge appearance="outline">Not installed</Badge>;
  }
}

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

      <MediaToolkitSection />

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

/**
 * Media toolkit (Phase 10): per-tool lifecycle driven by main — the renderer only renders
 * state and issues install/cancel intents. Byte provenance (SHA-256, sizes) is never shown
 * as an editable surface; a failed tool can only be retried through main's verified pipeline.
 */
function MediaToolkitSection(): ReactNode {
  const styles = useStyles();
  const status = useToolkitStore((s) => s.status);
  const loaded = useToolkitStore((s) => s.loaded);
  const load = useToolkitStore((s) => s.load);
  const ensure = useToolkitStore((s) => s.ensure);
  const cancel = useToolkitStore((s) => s.cancel);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (!status) {
    return (
      <section className={styles.section} aria-labelledby="toolkit-title">
        <Text id="toolkit-title" className={styles.sectionTitle}>
          Media toolkit
        </Text>
        <Text className={styles.hint}>
          {loaded ? "Toolkit manifest is unavailable on this install." : "Loading toolkit status…"}
        </Text>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="toolkit-title">
      <Text id="toolkit-title" className={styles.sectionTitle}>
        Media toolkit
      </Text>
      <Text className={styles.hint}>
        Bundled tools for media downloads — verified by checksum before use, updated only with
        the app. {status.platform ? `Platform: ${status.platform}.` : "No artifacts pinned for this platform."}
      </Text>
      {status.tools.map((tool) => (
        <div key={tool.id} className={styles.toolRow}>
          <div className={styles.toolHead}>
            <div className={styles.toolName}>
              <Text weight="semibold">{TOOL_LABELS[tool.id] ?? tool.id}</Text>
              <Text className={styles.hint}>v{tool.version}</Text>
              {stateBadge(tool.state)}
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              {tool.state === "failed" || tool.state === "missing" ? (
                <Button
                  size="small"
                  appearance="primary"
                  onClick={() => void ensure(tool.id)}
                >
                  Install
                </Button>
              ) : null}
              {tool.state === "fetching" || tool.state === "verifying" ? (
                <Button size="small" onClick={() => void cancel(tool.id)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
          {tool.state === "fetching" && tool.totalBytes ? (
            <ProgressBar
              value={Math.min(1, tool.bytesFetched / tool.totalBytes)}
              shape="rounded"
            />
          ) : null}
          {tool.state === "failed" && tool.message ? (
            <Text className={styles.hint} style={{ color: tokens.colorPaletteRedForeground2 }}>
              {tool.errorCode}: {tool.message}
            </Text>
          ) : null}
        </div>
      ))}
      <MediaToolsAutoFetchToggle />
    </section>
  );
}

function MediaToolsAutoFetchToggle(): ReactNode {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!settings) return null;
  return (
    <Field
      label="Fetch missing tools automatically at startup"
      hint="When off, install tools manually from this page"
    >
      <Switch
        checked={settings.mediaToolsAutoFetch}
        onChange={(_, data) => void update({ mediaToolsAutoFetch: data.checked })}
      />
    </Field>
  );
}
