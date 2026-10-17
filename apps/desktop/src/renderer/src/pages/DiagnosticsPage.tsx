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
import { ArrowSyncRegular, ArrowExportLtrRegular } from "@fluentui/react-icons";
import type { HealthReport, LogLevel } from "@syntaxdm/contracts";
import { useDiagnosticsStore } from "../stores/diagnostics.js";
import { useSettingsStore } from "../stores/settings.js";

/**
 * Diagnostics page (Phase 20) — the user-visible half of the diagnostics domain:
 *  - health report cards (app / core / storage / toolkit / updater / logs);
 *  - the recent-log tail with a level filter (newest last, capped at 200 records);
 *  - the consent-gated log export (folder picker → zip with logs + health snapshot);
 *  - the verbose-logging switch (settings.verboseLogging — live for the main logger,
 *    applied to the core at its next spawn).
 * Bounded 10 s auto-refresh while the page is mounted; refresh is cheap (a few SQL
 * aggregates + a ring slice main-side).
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

const LEVEL_OPTIONS: ReadonlyArray<{ label: string; value: LogLevel | undefined }> = [
  { label: "All levels", value: undefined },
  { label: "Debug and above", value: "debug" },
  { label: "Info and above", value: "info" },
  { label: "Warnings and errors", value: "warn" },
  { label: "Errors only", value: "error" },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

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
  return (
    <div className={styles.card}>
      <Text className={styles.cardTitle}>Application</Text>
      <div className={styles.grid}>
        <KV k="Version" v={report.app.version} />
        <KV k="Electron" v={report.app.electronVersion} />
        <KV k="Platform" v={`${report.app.platform} · ${report.app.arch}`} />
        <KV k="Contract / protocol" v={`v${report.versions.contract} · v${report.versions.protocol}`} />
        <KV k="Uptime" v={`${Math.round(report.app.uptimeMs / 1000)} s`} />
        <KV k="Memory (RSS)" v={fmtBytes(report.app.memoryRssBytes)} />
      </div>
    </div>
  );
}

function CoreCard({ report }: { report: HealthReport }): ReactNode {
  const styles = useStyles();
  const sup = report.core.supervision;
  const snap = report.core.snapshot;
  return (
    <div className={styles.card}>
      <Text className={styles.cardTitle}>Download core</Text>
      <div className={styles.grid}>
        <KV
          k="State"
          v={
            <span>
              {sup.state}{" "}
              {sup.state !== "ready" && sup.state !== "stopped" ? (
                <Badge appearance="tint" color="warning" size="small">
                  degraded
                </Badge>
              ) : null}
            </span>
          }
        />
        <KV k="Restarts this session" v={String(sup.restarts)} />
        <KV
          k="Last exit"
          v={
            sup.lastExit
              ? `code ${sup.lastExit.code ?? "—"}${sup.lastExit.signal ? ` (${sup.lastExit.signal})` : ""}`
              : "clean"
          }
        />
        {sup.pid !== null ? <KV k="PID" v={String(sup.pid)} /> : null}
        {sup.uptimeMs !== null ? <KV k="Ready for" v={`${Math.round(sup.uptimeMs / 1000)} s`} /> : null}
      </div>
      {snap ? (
        <>
          <div className={styles.grid}>
            <KV
              k="Database quick check"
              v={
                <span>
                  {snap.dbQuickCheck === "ok" ? (
                    <Badge appearance="tint" color="success" size="small">
                      ok
                    </Badge>
                  ) : (
                    <Badge appearance="tint" color="danger" size="small">
                      problems found
                    </Badge>
                  )}
                </span>
              }
            />
            <KV k="Database size" v={fmtBytes(snap.dbPageCount * snap.dbPageSize)} />
            <KV k="Download jobs" v={String(Object.values(snap.jobsByStatus).reduce((a, b) => a + b, 0))} />
            <KV k="Media / torrents" v={`${snap.counts.mediaJobs} / ${snap.counts.torrentJobs}`} />
            <KV
              k="History / bookmarks"
              v={`${snap.counts.historyEntries} / ${snap.counts.bookmarks}`}
            />
            <KV k="Core uptime" v={`${Math.round(snap.uptimeMs / 1000)} s`} />
          </div>
          {snap.dbQuickCheck !== "ok" ? (
            <MessageBar intent="error">
              <MessageBarBody>Database integrity issues: {snap.dbQuickCheck}</MessageBarBody>
            </MessageBar>
          ) : null}
        </>
      ) : (
        <MessageBar intent="warning">
          <MessageBarBody>
            Core snapshot unavailable — the download core is not answering
            (state: {sup.state}).{report.core.supervision.lastExit ? " Check the log tail below." : ""}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

function ToolkitUpdaterCards({ report }: { report: HealthReport }): ReactNode {
  const styles = useStyles();
  const ready = report.toolkit.tools.filter((t) => t.state === "ready").length;
  return (
    <div className={styles.card}>
      <Text className={styles.cardTitle}>Bundled toolkit &amp; updates</Text>
      <div className={styles.grid}>
        <KV
          k="Toolkit manifest"
          v={report.toolkit.manifestVersion === null ? "not loaded" : `v${report.toolkit.manifestVersion}`}
        />
        <KV k="Tools ready" v={`${ready} / ${report.toolkit.tools.length}`} />
        <KV k="Update status" v={report.updater.status} />
        <KV k="Running version" v={report.updater.currentVersion} />
        {report.updater.availableVersion ? (
          <KV k="Available version" v={report.updater.availableVersion} />
        ) : null}
      </div>
      {report.toolkit.tools.length > 0 ? (
        <div className={styles.grid}>
          {report.toolkit.tools.map((t) => (
            <KV
              key={t.id}
              k={t.id}
              v={
                <span>
                  {t.state}
                  {t.state === "failed" && t.errorCode ? (
                    <Badge appearance="tint" color="danger" size="small">
                      {t.errorCode}
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
  const records = useDiagnosticsStore((s) => s.records);
  const levelFilter = useDiagnosticsStore((s) => s.levelFilter);
  const setLevelFilter = useDiagnosticsStore((s) => s.setLevelFilter);
  const loadLogs = useDiagnosticsStore((s) => s.loadLogs);
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <Text className={styles.cardTitle}>Recent logs (newest last, tail of 200)</Text>
        <div className={styles.filterRow}>
          <Dropdown
            className={styles.filterDropdown}
            value={LEVEL_OPTIONS.find((o) => o.value === levelFilter)?.label ?? "All levels"}
            onOptionSelect={(_e, data) => {
              const found = LEVEL_OPTIONS.find((o) => o.label === data.optionText);
              setLevelFilter(found?.value);
            }}
          >
            {LEVEL_OPTIONS.map((o) => (
              <Option key={o.label}>{o.label}</Option>
            ))}
          </Dropdown>
          <Button
            icon={<ArrowSyncRegular />}
            size="small"
            onClick={() => void loadLogs()}
            aria-label="Refresh log tail"
          />
        </div>
      </div>
      {records.length === 0 ? (
        <Text className={styles.logDir}>No records match the current filter.</Text>
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

export function DiagnosticsPage(): ReactNode {
  const styles = useStyles();
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

  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <Text size={600} weight="semibold">
          Diagnostics
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
            Refresh
          </Button>
          <Button
            icon={<ArrowExportLtrRegular />}
            size="small"
            appearance="primary"
            onClick={() => void exportLogs()}
            disabled={exporting}
          >
            {exporting ? "Exporting…" : "Export logs…"}
          </Button>
        </div>
      </div>

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded && loading ? <Spinner label="Collecting diagnostics…" /> : null}

      {report ? (
        <>
          <AppCard report={report} />
          <CoreCard report={report} />
          <ToolkitUpdaterCards report={report} />
          <div className={styles.card}>
            <Text className={styles.cardTitle}>Log files</Text>
            <Text className={styles.logDir}>
              {report.logs.files.length} file(s), {fmtBytes(report.logs.totalBytes)} total
              {report.logs.files.length > 0
                ? ` — newest: ${report.logs.files[report.logs.files.length - 1]?.name}`
                : ""}
            </Text>
          </div>
          <LogTail />
          <div className={styles.card}>
            <div className={styles.row}>
              <div>
                <Text className={styles.cardTitle}>Verbose logging</Text>
                <Text className={styles.logDir}>
                  Records debug-level detail. Applies to the app log immediately and to the
                  download core the next time it starts.
                </Text>
              </div>
              <Switch
                checked={settings?.verboseLogging ?? false}
                onChange={(_e, data) => void updateSettings({ verboseLogging: data.checked })}
                aria-label="Verbose logging"
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
