import { useEffect, useState, type ReactNode } from "react";
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
  Dropdown,
  Option,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { FolderOpenRegular, ArrowCounterclockwiseRegular } from "@fluentui/react-icons";
import type { AppLanguage, ThemeMode, ToolkitToolStatus } from "@unidm/contracts";
import { SETTINGS_DEFAULTS } from "@unidm/contracts";
import { rpc } from "../bridge.js";
import { useSettingsStore } from "../stores/settings.js";
import { useProxyStore } from "../stores/proxy.js";
import { useToolkitStore } from "../stores/toolkit.js";

/**
 * Settings page — writes go through the optimistic zustand store → main → settings.json.
 * Phase 16 completed the domain: native directory picker (app.pickDirectory), the
 * app-level default proxy for new downloads (injected by main on download.create), and a
 * confirm-guarded restore-defaults action. Free-text absolute paths stay valid everywhere.
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
  const [confirmReset, setConfirmReset] = useState(false);

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
          <div style={{ display: "flex", gap: "8px" }}>
            <Input
              value={settings.downloadDir}
              onChange={(_, data) => void update({ downloadDir: data.value })}
              style={{ flex: 1 }}
            />
            <BrowseDirectoryButton
              onPicked={(path) => void update({ downloadDir: path })}
            />
          </div>
        </Field>
        <DefaultProxyField />
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

      <section className={styles.section} aria-labelledby="maintenance-title">
        <Text id="maintenance-title" className={styles.sectionTitle}>
          Maintenance
        </Text>
        <Field
          label="Restore default settings"
          hint="Every preference returns to its factory value; jobs and files are untouched"
        >
          <Button
            icon={<ArrowCounterclockwiseRegular />}
            onClick={() => setConfirmReset(true)}
          >
            Restore defaults
          </Button>
        </Field>
      </section>

      <Dialog open={confirmReset} onOpenChange={(_, d) => setConfirmReset(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restore default settings?</DialogTitle>
            <DialogContent>
              Theme, language, download directory, limits, proxy default and every other
              preference return to their factory values. Downloads, history and profiles are
              not touched. This cannot be undone.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setConfirmReset(false);
                  void update({ ...SETTINGS_DEFAULTS });
                }}
              >
                Restore
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/** Phase 16: native OS folder picker (app.pickDirectory); null (cancel) changes nothing. */
function BrowseDirectoryButton(props: { onPicked: (path: string) => void }): ReactNode {
  const [picking, setPicking] = useState(false);
  return (
    <Button
      icon={<FolderOpenRegular />}
      disabled={picking}
      onClick={() => {
        setPicking(true);
        void rpc("app.pickDirectory", {})
          .then(({ path }) => {
            if (path) props.onPicked(path);
          })
          .catch(() => undefined)
          .finally(() => setPicking(false));
      }}
    >
      Browse…
    </Button>
  );
}

/**
 * Phase 16: the app-level default proxy (main injects it into download.create requests
 * that omit an explicit profile). Removing the referenced profile clears the setting in
 * main (proxy.remove), so a stale selection cannot appear here.
 */
function DefaultProxyField(): ReactNode {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const profiles = useProxyStore((s) => s.profiles);
  const loadProfiles = useProxyStore((s) => s.load);
  const loaded = useProxyStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) void loadProfiles().catch(() => undefined);
  }, [loaded, loadProfiles]);

  if (!settings) return null;
  const current = settings.defaultProxyProfileId;
  const currentName = current
    ? (profiles.find((p) => p.id === current)?.name ?? "unavailable profile")
    : "Direct";
  return (
    <Field
      label="Default proxy for new downloads"
      hint="Applied to downloads created without an explicit proxy; a missing profile pauses the job (never falls back to direct)"
    >
      <Dropdown
        value={currentName}
        selectedOptions={current ? [current] : ["__direct"]}
        onOptionSelect={(_, d) =>
          void update({
            defaultProxyProfileId: d.optionValue === "__direct" ? null : (d.optionValue as string),
          })
        }
        aria-label="Default proxy for new downloads"
      >
        <Option value="__direct">Direct (no proxy)</Option>
        {profiles.map((p) => (
          <Option key={p.id} value={p.id}>
            {p.name}
          </Option>
        ))}
      </Dropdown>
    </Field>
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
