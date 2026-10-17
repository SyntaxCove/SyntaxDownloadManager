import { useEffect, type ReactNode } from "react";
import {
  Text,
  Button,
  Switch,
  Spinner,
  MessageBar,
  MessageBarBody,
  Dropdown,
  Option,
  Badge,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowSyncRegular, ArrowExportLtrRegular, ArrowExportRtlRegular } from "@fluentui/react-icons";
import type { HealthReport, LogLevel } from "@syntaxdm/contracts";
import { useDiagnosticsStore } from "../stores/diagnostics.js";
import { useSettingsStore } from "../stores/settings.js";
import { useI18n } from "../i18n/context.js";
import { formatBytes, formatNumber } from "../i18n/format.js";

/**
 * Diagnostics page (Phase 20) — the user-visible half of the diagnostics domain:
 *  - health report cards (app / core / storage / toolkit / updater / logs);
 *  - the recent-log tail with a level filter (newest last, capped at 200 records);
 *  - the consent-gated log export (folder picker → zip with logs + health snapshot);
 *  - the verbose-logging switch (settings.verboseLogging — live for the main logger,
 *    applied to the core at its next spawn).
 * Bounded 10 s auto-refresh while the page is mounted; refresh is cheap (a few SQL
 * aggregates + a ring slice main-side). Phase 21: localized strings; the export icon
 * mirrors in RTL layouts; log rows remain a deliberate `aria-live="off"` region.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "760px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    justifyContent: "space-between",
    flexWrap: "wrap",
  },
  actionsRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "16px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardTitle: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  kv: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "180px",
    flex: "1 1 180px",
  },
  key: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  value: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  grid: { display: "flex", flexWrap: "wrap", gap: "12px" },
  tail: {
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.5",
    maxHeight: "320px",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px",
  },
  line: { display: "block" },
  tsDim: { color: tokens.colorNeutralForeground3 },
  filterRow: { display: "flex", alignItems: "center", gap: "8px" },
  filterDropdown: { minWidth: "140px" },
  logDir: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

const LEVEL_KEYS: ReadonlyArray<{ key: string; value: LogLevel | undefined }> = [
  { key: "diag.logs.allLevels", value: undefined },
  { key: "diag.logs.debugAndAbove", value: "debug" },
  { key: "diag.logs.infoAndAbove", value: "info" },
  { key: "diag.logs.warnAndAbove", value: "warn" },
  { key: "diag.logs.errorsOnly", value: "error" },
];

function KV({ k, v }: { k: string; v: ReactNode }): ReactNode {
  const styles = useStyles();
  return (
    <div className={styles.kv}>
      <Text className={styles.key}>{k}</Text>
      <Text className={styles.value}>{v}</Text>
    </div>
  );
}

function LevelBadge({ level }: { level: LogLevel }): ReactNode {
  const color =
    level === "error" ? "danger" : level === "warn" ? "warning" : "subtle";
  return (
    <Badge appearance="tint" color={color} size="small">
      {level}
    </Badge>
  );
}

function AppCard({ report }: { report: HealthReport }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  return (
    <div className={styles.card}>
      <Text as="h2" className={styles.cardTitle}>{t("diag.card.app")}</Text>
      <div className={styles.grid}>
        <KV k={t("diag.k.version")} v={report.app.version} />
        <KV k={t("diag.k.electron")} v={report.app.electronVersion} />
        <KV k={t("diag.k.platform")} v={`${report.app.platform} · ${report.app.arch}`} />
        <KV k={t("diag.k.contract")} v={`v${report.versions.contract} · v${report.versions.protocol}`} />
        <KV
          k={t("diag.k.uptime")}
          v={t("diag.k.uptimeSeconds", { n: formatNumber(Math.round(report.app.uptimeMs / 1000), t.lang) })}
        />
        <KV k={t("diag.k.memory")} v={formatBytes(report.app.memoryRssBytes, t.lang)} />
      </div>
    </div>
  );
}

function CoreCard({ report }: { report: HealthReport }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const sup = report.core.supervision;
  const snap = report.core.snapshot;
  return (
    <div className={styles.card}>
      <Text as="h2" className={styles.cardTitle}>{t("diag.card.core")}</Text>
      <div className={styles.grid}>
        <KV
          k={t("diag.k.state")}
          v={
            <span>
              {sup.state}{" "}
              {sup.state !== "ready" && sup.state !== "stopped" ? (
                <Badge appearance="tint" color="warning" size="small">
                  {t("diag.badge.degraded")}
                </Badge>
              ) : null}
            </span>
          }
        />
        <KV k={t("diag.k.restarts")} v={formatNumber(sup.restarts, t.lang)} />
        <KV
          k={t("diag.k.lastExit")}
          v={
            sup.lastExit
              ? `${t("diag.k.lastExitCode", { code: sup.lastExit.code ?? "—" })}${sup.lastExit.signal ? ` (${sup.lastExit.signal})` : ""}`
              : t("diag.k.clean")
          }
        />
        {sup.pid !== null ? <KV k="PID" v={formatNumber(sup.pid, t.lang)} /> : null}
        {sup.uptimeMs !== null ? (
          <KV
            k={t("diag.k.readyFor")}
            v={t("diag.k.uptimeSeconds", { n: formatNumber(Math.round(sup.uptimeMs / 1000), t.lang) })}
          />
        ) : null}
      </div>
      {snap ? (
        <>
          <div className={styles.grid}>
            <KV
              k={t("diag.k.dbQuickCheck")}
              v={
                <span>
                  {snap.dbQuickCheck === "ok" ? (
                    <Badge appearance="tint" color="success" size="small">
                      {t("diag.badge.ok")}
                    </Badge>
                  ) : (
                    <Badge appearance="tint" color="danger" size="small">
                      {t("diag.badge.problems")}
                    </Badge>
                  )}
                </span>
              }
            />
            <KV k={t("diag.k.dbSize")} v={formatBytes(snap.dbPageCount * snap.dbPageSize, t.lang)} />
            <KV
              k={t("diag.k.downloadJobs")}
              v={formatNumber(Object.values(snap.jobsByStatus).reduce((a, b) => a + b, 0), t.lang)}
            />
            <KV
              k={t("diag.k.mediaTorrents")}
              v={`${formatNumber(snap.counts.mediaJobs, t.lang)} / ${formatNumber(snap.counts.torrentJobs, t.lang)}`}
            />
            <KV
              k={t("diag.k.historyBookmarks")}
              v={`${formatNumber(snap.counts.historyEntries, t.lang)} / ${formatNumber(snap.counts.bookmarks, t.lang)}`}
            />
            <KV
              k={t("diag.k.coreUptime")}
              v={t("diag.k.uptimeSeconds", { n: formatNumber(Math.round(snap.uptimeMs / 1000), t.lang) })}
            />
          </div>
          {snap.dbQuickCheck !== "ok" ? (
            <MessageBar intent="error">
              <MessageBarBody>{t("diag.dbIssues", { report: snap.dbQuickCheck })}</MessageBarBody>
            </MessageBar>
          ) : null}
        </>
      ) : (
        <MessageBar intent="warning">
          <MessageBarBody>
            {t("diag.coreUnreachable", { state: sup.state })}
            {report.core.supervision.lastExit ? t("diag.coreUnreachableLogs") : ""}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

function ToolkitUpdaterCards({ report }: { report: HealthReport }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const ready = report.toolkit.tools.filter((tool) => tool.state === "ready").length;
  return (
    <div className={styles.card}>
      <Text as="h2" className={styles.cardTitle}>{t("diag.card.toolkit")}</Text>
      <div className={styles.grid}>
        <KV
          k={t("diag.k.manifest")}
          v={report.toolkit.manifestVersion === null ? t("diag.k.manifestNotLoaded") : `v${report.toolkit.manifestVersion}`}
        />
        <KV
          k={t("diag.k.toolsReady")}
          v={`${formatNumber(ready, t.lang)} / ${formatNumber(report.toolkit.tools.length, t.lang)}`}
        />
        <KV k={t("diag.k.updateStatus")} v={report.updater.status} />
        <KV k={t("diag.k.runningVersion")} v={report.updater.currentVersion} />
        {report.updater.availableVersion ? (
          <KV k={t("diag.k.availableVersion")} v={report.updater.availableVersion} />
        ) : null}
      </div>
      {report.toolkit.tools.length > 0 ? (
        <div className={styles.grid}>
          {report.toolkit.tools.map((tool) => (
            <KV
              key={tool.id}
              k={tool.id}
              v={
                <span>
                  {tool.state}
                  {tool.state === "failed" && tool.errorCode ? (
                    <Badge appearance="tint" color="danger" size="small">
                      {tool.errorCode}
                    </Badge>
                  ) : null}
                </span>
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LogTail(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const records = useDiagnosticsStore((s) => s.records);
  const levelFilter = useDiagnosticsStore((s) => s.levelFilter);
  const setLevelFilter = useDiagnosticsStore((s) => s.setLevelFilter);
  const loadLogs = useDiagnosticsStore((s) => s.loadLogs);
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <Text as="h2" className={styles.cardTitle}>{t("diag.logs.title")}</Text>
        <div className={styles.filterRow}>
          <Dropdown
            className={styles.filterDropdown}
            value={LEVEL_KEYS.find((o) => o.value === levelFilter)?.key ? t(LEVEL_KEYS.find((o) => o.value === levelFilter)!.key) : t("diag.logs.allLevels")}
            onOptionSelect={(_e, data) => {
              const found = LEVEL_KEYS.find((o) => t(o.key) === data.optionText);
              setLevelFilter(found?.value);
            }}
          >
            {LEVEL_KEYS.map((o) => (
              <Option key={o.key} text={t(o.key)}>{t(o.key)}</Option>
            ))}
          </Dropdown>
          <Button
            icon={<ArrowSyncRegular />}
            size="small"
            onClick={() => void loadLogs()}
            aria-label={t("diag.logs.refreshAria")}
          />
        </div>
      </div>
      {records.length === 0 ? (
        <Text className={styles.logDir}>{t("diag.logs.empty")}</Text>
      ) : (
        <div className={styles.tail} role="log" aria-live="off">
          {records.map((r, i) => (
            <span className={styles.line} key={`${r.ts}-${i}`}>
              <span className={styles.tsDim}>{fmtTime(r.ts)} </span>
              <LevelBadge level={r.level} /> [{r.component}] {r.msg}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Log timestamps stay UTC-anchored on purpose (correlates with exported files). */
function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function DiagnosticsPage(): ReactNode {
  const styles = useStyles();
  const { t, dir } = useI18n();
  const report = useDiagnosticsStore((s) => s.report);
  const loaded = useDiagnosticsStore((s) => s.loaded);
  const loading = useDiagnosticsStore((s) => s.loading);
  const error = useDiagnosticsStore((s) => s.error);
  const exporting = useDiagnosticsStore((s) => s.exporting);
  const loadReport = useDiagnosticsStore((s) => s.loadReport);
  const loadLogs = useDiagnosticsStore((s) => s.loadLogs);
  const exportLogs = useDiagnosticsStore((s) => s.exportLogs);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  useEffect(() => {
    void loadReport();
    void loadLogs();
    // Bounded auto-refresh while the page is visible; cleared on unmount.
    const timer = setInterval(() => {
      void loadReport();
      void loadLogs();
    }, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ExportIcon = dir === "rtl" ? ArrowExportRtlRegular : ArrowExportLtrRegular;

  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <Text as="h1" size={600} weight="semibold">
          {t("diag.title")}
        </Text>
        <div className={styles.actionsRow}>
          <Button
            icon={<ArrowSyncRegular />}
            size="small"
            onClick={() => {
              void loadReport();
              void loadLogs();
            }}
            disabled={loading}
          >
            {t("diag.refresh")}
          </Button>
          <Button
            icon={<ExportIcon />}
            size="small"
            appearance="primary"
            onClick={() => void exportLogs()}
            disabled={exporting}
          >
            {exporting ? t("diag.exporting") : t("diag.exportLogs")}
          </Button>
        </div>
      </div>

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded && loading ? <Spinner label={t("diag.collecting")} /> : null}

      {report ? (
        <>
          <AppCard report={report} />
          <CoreCard report={report} />
          <ToolkitUpdaterCards report={report} />
          <div className={styles.card}>
            <Text as="h2" className={styles.cardTitle}>{t("diag.files.title")}</Text>
            <Text className={styles.logDir}>
              {t("diag.files.summary", {
                count: formatNumber(report.logs.files.length, t.lang),
                size: formatBytes(report.logs.totalBytes, t.lang),
              })}
              {report.logs.files.length > 0
                ? t("diag.files.newest", { name: report.logs.files[report.logs.files.length - 1]?.name ?? "" })
                : ""}
            </Text>
          </div>
          <LogTail />
          <div className={styles.card}>
            <div className={styles.row}>
              <div>
                <Text as="h2" className={styles.cardTitle}>{t("diag.verbose.title")}</Text>
                <Text className={styles.logDir}>{t("diag.verbose.desc")}</Text>
              </div>
              <Switch
                checked={settings?.verboseLogging ?? false}
                onChange={(_e, data) => void updateSettings({ verboseLogging: data.checked })}
                aria-label={t("diag.verbose.aria")}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
