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
import { FolderOpenRegular, ArrowCounterclockwiseRegular, ArrowSyncRegular, ArrowClockwiseRegular } from "@fluentui/react-icons";
import type { AppLanguage, ThemeMode, ToolkitToolStatus, UpdateState, UpdateStatus } from "@syntaxdm/contracts";
import { SETTINGS_DEFAULTS } from "@syntaxdm/contracts";
import { rpc } from "../bridge.js";
import { useSettingsStore } from "../stores/settings.js";
import { useProxyStore } from "../stores/proxy.js";
import { useToolkitStore } from "../stores/toolkit.js";
import { useUpdateStore } from "../stores/updates.js";
import { useI18n } from "../i18n/context.js";
import { formatDateTime, formatNumber } from "../i18n/format.js";

/**
 * Settings page — writes go through the optimistic zustand store → main → settings.json.
 * Phase 16 completed the domain: native directory picker (app.pickDirectory), the
 * app-level default proxy for new downloads (injected by main on download.create), and a
 * confirm-guarded restore-defaults action. Free-text absolute paths stay valid everywhere.
 * Phase 21: fully localized; the language selector now switches the whole UI live.
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
  mono: { fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: tokens.fontSizeBase200 },
});

const TOOL_KEYS: Record<ToolkitToolStatus["id"], string> = {
  ffmpeg: "settings.toolkit.ffmpeg",
  "yt-dlp": "settings.toolkit.ytdlp",
  deno: "settings.toolkit.deno",
};

/** Unknown tool ids (a future additive contract) fall back to the raw id, never throw. */
function toolLabel(id: ToolkitToolStatus["id"], t: (key: string) => string): string {
  const key = TOOL_KEYS[id];
  return key ? t(key) : id;
}

function StateBadge({ state }: { state: ToolkitToolStatus["state"] }): ReactNode {
  const { t } = useI18n();
  switch (state) {
    case "ready":
      return <Badge appearance="filled" color="success">{t("settings.toolkit.state.ready")}</Badge>;
    case "fetching":
      return <Badge appearance="tint" color="informative">{t("settings.toolkit.state.fetching")}</Badge>;
    case "verifying":
      return <Badge appearance="tint" color="informative">{t("settings.toolkit.state.verifying")}</Badge>;
    case "failed":
      return <Badge appearance="filled" color="danger">{t("settings.toolkit.state.failed")}</Badge>;
    default:
      return <Badge appearance="outline">{t("settings.toolkit.state.missing")}</Badge>;
  }
}

export function SettingsPage(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const status = useSettingsStore((s) => s.status);
  const error = useSettingsStore((s) => s.error);
  const load = useSettingsStore((s) => s.load);
  const update = useSettingsStore((s) => s.update);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (status === "loading") void load();
  }, [status, load]);

  if (status === "loading") return <Spinner label={t("settings.loading")} />;
  if (status === "error" || !settings) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          {t("settings.loadFailed", { error: error ?? t("settings.unknownError") })}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.page}>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{t("settings.saveFailed", { error })}</MessageBarBody>
        </MessageBar>
      ) : null}

      <MediaToolkitSection />

      <section className={styles.section} aria-labelledby="appearance-title">
        <Text id="appearance-title" as="h2" className={styles.sectionTitle}>
          {t("settings.section.appearance")}
        </Text>
        <Field label={t("settings.theme")}>
          <RadioGroup
            value={settings.theme}
            onChange={(_, data) => void update({ theme: data.value as ThemeMode })}
            layout="horizontal"
          >
            <Radio value="system" label={t("settings.theme.system")} />
            <Radio value="light" label={t("settings.theme.light")} />
            <Radio value="dark" label={t("settings.theme.dark")} />
          </RadioGroup>
        </Field>
        <Field label={t("settings.language")}>
          <RadioGroup
            value={settings.language}
            onChange={(_, data) => void update({ language: data.value as AppLanguage })}
            layout="horizontal"
          >
            <Radio value="en" label={t("settings.language.en")} />
            <Radio value="fa" label={t("settings.language.fa")} />
          </RadioGroup>
        </Field>
      </section>

      {/* Post-1.0: browser user agent — current string shown, override editable. */}
      <BrowserUserAgentSection />

      <section className={styles.section} aria-labelledby="download-title">
        <Text id="download-title" as="h2" className={styles.sectionTitle}>
          {t("settings.section.downloads")}
        </Text>
        <Field label={t("settings.downloadDir")} hint={t("settings.downloadDirHint")}>
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
          label={t("settings.parallelDownloads", { n: formatNumber(settings.concurrentDownloads, t.lang) })}
          hint={t("settings.parallelDownloadsHint")}
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
          label={t("settings.connectionsPer", { n: formatNumber(settings.maxConnectionsPerDownload, t.lang) })}
          hint={t("settings.connectionsPerHint")}
        >
          <Slider
            min={1}
            max={16}
            step={1}
            value={settings.maxConnectionsPerDownload}
            onChange={(_, data) => void update({ maxConnectionsPerDownload: data.value })}
          />
        </Field>
        <Field label={t("settings.speedLimit")}>
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
          label={t("settings.autoStart")}
          hint={t("settings.autoStartHint")}
        >
          <Switch
            checked={settings.autoStartNewDownloads}
            onChange={(_, data) => void update({ autoStartNewDownloads: data.checked })}
          />
        </Field>
        <Field
          label={t("settings.scheduleWindow")}
          hint={t("settings.scheduleWindowHint")}
        >
          <Switch
            checked={settings.scheduleEnabled}
            onChange={(_, data) => void update({ scheduleEnabled: data.checked })}
          />
        </Field>
        {settings.scheduleEnabled ? (
          <Field label={t("settings.dailyWindow")} hint={t("settings.dailyWindowHint")}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <Input
                type="time"
                value={settings.scheduleStart}
                onChange={(_, data) => {
                  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(data.value)) {
                    void update({ scheduleStart: data.value });
                  }
                }}
                aria-label={t("settings.windowStart")}
              />
              <Text className={styles.hint}>{t("settings.to")}</Text>
              <Input
                type="time"
                value={settings.scheduleEnd}
                onChange={(_, data) => {
                  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(data.value)) {
                    void update({ scheduleEnd: data.value });
                  }
                }}
                aria-label={t("settings.windowEnd")}
              />
            </div>
          </Field>
        ) : null}
        <Text className={styles.hint}>{t("settings.applyNote")}</Text>
      </section>

      <section className={styles.section} aria-labelledby="notifications-title">
        <Text id="notifications-title" as="h2" className={styles.sectionTitle}>
          {t("settings.section.notifications")}
        </Text>
        <Field
          label={t("settings.notifyComplete")}
          hint={t("settings.notifyCompleteHint")}
        >
          <Switch
            checked={settings.notifyOnComplete}
            onChange={(_, data) => void update({ notifyOnComplete: data.checked })}
          />
        </Field>
        <Field
          label={t("settings.notifyFailure")}
          hint={t("settings.notifyFailureHint")}
        >
          <Switch
            checked={settings.notifyOnFailure}
            onChange={(_, data) => void update({ notifyOnFailure: data.checked })}
          />
        </Field>
        <Field
          label={t("settings.closeToTray")}
          hint={t("settings.closeToTrayHint")}
        >
          <Switch
            checked={settings.closeToTray}
            onChange={(_, data) => void update({ closeToTray: data.checked })}
          />
        </Field>
        <Text className={styles.hint}>{t("settings.closeToTrayNote")}</Text>
      </section>

      <UpdatesSection />

      <section className={styles.section} aria-labelledby="maintenance-title">
        <Text id="maintenance-title" as="h2" className={styles.sectionTitle}>
          {t("settings.section.maintenance")}
        </Text>
        <Field
          label={t("settings.restoreDefaults")}
          hint={t("settings.restoreDefaultsHint")}
        >
          <Button
            icon={<ArrowCounterclockwiseRegular />}
            onClick={() => setConfirmReset(true)}
          >
            {t("settings.restoreDefaultsAction")}
          </Button>
        </Field>
      </section>

      <Dialog open={confirmReset} onOpenChange={(_, d) => setConfirmReset(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("settings.resetDialog.title")}</DialogTitle>
            <DialogContent>{t("settings.resetDialog.body")}</DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmReset(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setConfirmReset(false);
                  void update({ ...SETTINGS_DEFAULTS });
                }}
              >
                {t("settings.resetDialog.action")}
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
  const { t } = useI18n();
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
      {t("common.browse")}
    </Button>
  );
}

/**
 * Phase 16: the app-level default proxy (main injects it into download.create requests
 * that omit an explicit profile). Removing the referenced profile clears the setting in
 * main (proxy.remove), so a stale selection cannot appear here.
 */
function DefaultProxyField(): ReactNode {
  const { t } = useI18n();
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
    ? (profiles.find((p) => p.id === current)?.name ?? t("settings.unavailableProfile"))
    : t("common.direct");
  return (
    <Field
      label={t("settings.defaultProxy")}
      hint={t("settings.defaultProxyHint")}
    >
      <Dropdown
        value={currentName}
        selectedOptions={current ? [current] : ["__direct"]}
        onOptionSelect={(_, d) =>
          void update({
            defaultProxyProfileId: d.optionValue === "__direct" ? null : (d.optionValue as string),
          })
        }
        aria-label={t("settings.defaultProxy")}
      >
        <Option value="__direct">{t("common.directNoProxy")}</Option>
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
/**
 * Post-1.0: browser user agent. Shows the effective UA string (main owns it — Electron
 * composes the Chromium default, the TabManager captures it before any override) with a
 * default/custom badge, and edits the `browserUserAgent` settings override. Empty = the
 * default; saved changes apply live to every browser session, with open pages picking
 * the new UA up on their next load.
 */
function BrowserUserAgentSection(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const saved = useSettingsStore((s) => s.settings?.browserUserAgent ?? "");
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(saved);
  const [effective, setEffective] = useState<{ userAgent: string; isCustom: boolean } | null>(null);

  // Follow external changes (restore-defaults) back to the persisted value.
  useEffect(() => setDraft(saved), [saved]);

  // Re-fetch after every save so the display and badge track the persisted setting.
  useEffect(() => {
    let cancelled = false;
    void rpc("browser.getUserAgent", {})
      .then((r) => {
        if (!cancelled) setEffective(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [saved]);

  const dirty = draft !== saved;
  const atDefault = saved.length === 0;

  return (
    <section className={styles.section} aria-labelledby="browser-ua-title">
      <Text id="browser-ua-title" as="h2" className={styles.sectionTitle}>
        {t("settings.section.browserUA")}
      </Text>
      <Field label={t("settings.browserUA.current")}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <Text className={styles.mono} style={{ wordBreak: "break-all" }}>
            {effective?.userAgent || t("common.unavailable")}
          </Text>
          {effective ? (
            <Badge>
              {effective.isCustom ? t("settings.browserUA.badgeCustom") : t("settings.browserUA.badgeDefault")}
            </Badge>
          ) : null}
        </div>
      </Field>
      <Field label={t("settings.browserUA.customField")} hint={t("settings.browserUA.hint")}>
        <Input
          value={draft}
          maxLength={512}
          placeholder={t("settings.browserUA.placeholder")}
          onChange={(_, data) => setDraft(data.value)}
          aria-label={t("settings.browserUA.customField")}
        />
      </Field>
      <div style={{ display: "flex", gap: "8px" }}>
        <Button
          appearance="primary"
          disabled={!dirty}
          onClick={() => void update({ browserUserAgent: draft })}
        >
          {t("common.save")}
        </Button>
        <Button
          icon={<ArrowCounterclockwiseRegular />}
          disabled={atDefault}
          onClick={() => {
            setDraft("");
            void update({ browserUserAgent: "" });
          }}
        >
          {t("settings.browserUA.reset")}
        </Button>
      </div>
    </section>
  );
}

function MediaToolkitSection(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
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
        <Text id="toolkit-title" as="h2" className={styles.sectionTitle}>
          {t("settings.section.toolkit")}
        </Text>
        <Text className={styles.hint}>
          {loaded ? t("settings.toolkit.unavailable") : t("settings.toolkit.loading")}
        </Text>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="toolkit-title">
      <Text id="toolkit-title" as="h2" className={styles.sectionTitle}>
        {t("settings.section.toolkit")}
      </Text>
      <Text className={styles.hint}>
        {t("settings.toolkit.intro")}{" "}
        {status.platform ? t("settings.toolkit.platform", { platform: status.platform }) : t("settings.toolkit.noPlatform")}
      </Text>
      {status.tools.map((tool) => (
        <div key={tool.id} className={styles.toolRow}>
          <div className={styles.toolHead}>
            <div className={styles.toolName}>
              <Text weight="semibold">{toolLabel(tool.id, t)}</Text>
              <Text className={styles.hint}>v{tool.version}</Text>
              <StateBadge state={tool.state} />
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              {tool.state === "failed" || tool.state === "missing" ? (
                <Button
                  size="small"
                  appearance="primary"
                  onClick={() => void ensure(tool.id)}
                >
                  {t("settings.toolkit.install")}
                </Button>
              ) : null}
              {tool.state === "fetching" || tool.state === "verifying" ? (
                <Button size="small" onClick={() => void cancel(tool.id)}>
                  {t("common.cancel")}
                </Button>
              ) : null}
            </div>
          </div>
          {tool.state === "fetching" && tool.totalBytes ? (
            <ProgressBar
              value={Math.min(1, tool.bytesFetched / tool.totalBytes)}
              shape="rounded"
              aria-label={toolLabel(tool.id, t)}
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
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!settings) return null;
  return (
    <Field
      label={t("settings.toolkit.autoFetch")}
      hint={t("settings.toolkit.autoFetchHint")}
    >
      <Switch
        checked={settings.mediaToolsAutoFetch}
        onChange={(_, data) => void update({ mediaToolsAutoFetch: data.checked })}
      />
    </Field>
  );
}

/**
 * Updates (Phase 18): a dumb mirror of the main-process updater snapshot. Every lifecycle
 * decision lives main-side; this surface only renders state and issues the three consent
 * points (check / download / restart-to-apply). No feed URLs and no paths are ever shown —
 * main sends sanitized state shapes only.
 */
function useUpdateStatusLine(): (state: UpdateState) => string {
  const { t } = useI18n();
  return (state: UpdateState): string => {
    switch (state.status as UpdateStatus) {
      case "idle":
        return t("settings.update.state.idle");
      case "checking":
        return t("settings.update.state.checking");
      case "available":
        return t("settings.update.state.available", { version: state.availableVersion ?? "?" });
      case "not-available":
        return t("settings.update.state.notAvailable");
      case "downloading": {
        const p = state.progress;
        const base = t("settings.update.state.downloading");
        const percent = p ? t("settings.update.state.downloadingProgress", { percent: formatNumber(Math.floor(p.percent), t.lang) }) : "";
        const speed =
          p && p.bytesPerSecond > 0
            ? t("settings.update.state.downloadingSpeed", { speed: (p.bytesPerSecond / 1048576).toFixed(1) })
            : "";
        return `${base}${percent}${speed}`;
      }
      case "downloaded":
        return t("settings.update.state.downloaded", { version: state.availableVersion ?? "?" });
      case "installing":
        return t("settings.update.state.installing");
      case "error":
        return t("settings.update.state.error");
      case "unavailable":
        return state.unavailableReason === "not_packaged"
          ? t("settings.update.state.unavailableDev")
          : t("settings.update.state.unavailableNoFeed");
      default:
        return "";
    }
  };
}

function UpdatesSection(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const statusLine = useUpdateStatusLine();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const state = useUpdateStore((s) => s.state);
  const loaded = useUpdateStore((s) => s.loaded);
  const load = useUpdateStore((s) => s.load);
  const check = useUpdateStore((s) => s.check);
  const download = useUpdateStore((s) => s.download);
  const install = useUpdateStore((s) => s.install);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (!settings) return null;
  const busy = state !== null && ["checking", "downloading", "installing"].includes(state.status);

  return (
    <section className={styles.section} aria-labelledby="updates-title">
      <Text id="updates-title" as="h2" className={styles.sectionTitle}>
        {t("settings.section.updates")}
      </Text>
      {state ? (
        <>
          <Text className={styles.hint}>
            {t("settings.update.installLine", { version: state.currentVersion })}
            {state.lastCheckedAt
              ? t("settings.update.lastChecked", { when: formatDateTime(state.lastCheckedAt, t.lang) })
              : ""}
          </Text>
          <Text>{statusLine(state)}</Text>
        </>
      ) : (
        <Spinner size="tiny" label={t("settings.update.loadingState")} />
      )}
      {state?.status === "downloading" && state.progress ? (
        <ProgressBar
          value={Math.min(1, state.progress.percent / 100)}
          shape="rounded"
          aria-label={statusLine(state)}
        />
      ) : null}
      {state?.releaseNotes ? (
        <Text className={styles.hint} style={{ whiteSpace: "pre-wrap" }}>
          {state.releaseNotes}
        </Text>
      ) : null}
      {state?.status === "error" ? (
        <MessageBar intent="error">
          <MessageBarBody>
            {state.message
              ? t("settings.update.failedWithMessage", { code: state.errorCode ?? t("settings.unknownError"), message: state.message })
              : t("settings.update.failed", { code: state.errorCode ?? t("settings.unknownError") })}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Button
          icon={<ArrowSyncRegular />}
          disabled={!state || busy || state.status === "unavailable"}
          onClick={() => void check()}
        >
          {t("settings.update.checkNow")}
        </Button>
        {state?.status === "available" ? (
          <Button appearance="primary" onClick={() => void download()}>
            {t("settings.update.downloadUpdate")}
          </Button>
        ) : null}
        {state?.status === "downloaded" ? (
          <Button
            appearance="primary"
            icon={<ArrowClockwiseRegular />}
            onClick={() => void install()}
          >
            {t("settings.update.restartToUpdate")}
          </Button>
        ) : null}
      </div>
      <Field
        label={t("settings.update.autoCheck")}
        hint={t("settings.update.autoCheckHint")}
      >
        <Switch
          checked={settings.updateAutoCheck}
          onChange={(_, data) => void updateSettings({ updateAutoCheck: data.checked })}
        />
      </Field>
      <Text className={styles.hint}>{t("settings.update.privacyNote")}</Text>
    </section>
  );
}
