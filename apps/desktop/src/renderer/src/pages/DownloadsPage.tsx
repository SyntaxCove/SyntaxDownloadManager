import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  ProgressBar,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ArrowRepeatAllRegular,
  CaretUpRegular,
  CaretDownRegular,
  DeleteRegular,
  PauseRegular,
  PlayRegular,
  StopRegular,
  AddRegular,
  LinkEditRegular,
  PlugConnectedRegular,
  ShieldCheckmarkRegular,
  ShieldErrorRegular,
  TopSpeedRegular,
  GlobeShieldRegular,
} from "@fluentui/react-icons";
import { useDownloadsStore, compareQueueDisplay, type CoreStatus } from "../stores/downloads.js";
import { useSettingsStore } from "../stores/settings.js";
import { useProxyStore } from "../stores/proxy.js";
import type { DownloadJob, QueueDirection } from "@unidm/contracts";

/** Downloads page: create-by-URL, live progress, and lifecycle controls per job. */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "860px" },
  form: { display: "flex", gap: "8px" },
  job: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  name: { fontWeight: tokens.fontWeightSemibold, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  actions: { display: "flex", gap: "4px", marginLeft: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
});

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  probing: "Connecting",
  downloading: "Downloading",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

const CORE_BANNER: Partial<Record<CoreStatus, string>> = {
  starting: "Download engine is starting…",
  restarting: "Download engine is restarting — jobs keep their state.",
  unavailable: "Download engine is unavailable (it failed to start repeatedly). Check logs and restart the app.",
};

/** Failure codes the recovery engine can act on (Phase 7). */
const RECOVERY_HINT: Partial<Record<string, string>> = {
  source_gone: "Source expired or gone — try Recover, or paste a fresh/mirror URL.",
  source_forbidden: "Source requires fresh credentials — Recover, or replace with an authorized URL.",
  source_changed: "Source changed repeatedly — Recover, or replace the URL.",
  network_error: "Network failure — Recover once the connection is back.",
  http_error: "Server error — Recover to re-acquire the source.",
  proxy_profile_not_found: "The proxy profile for this download is unavailable — it will resume once the profile is restored (Recover, or pick another proxy).",
};

export function DownloadsPage(): ReactNode {
  const styles = useStyles();
  const jobs = useDownloadsStore((s) => s.jobs);
  const core = useDownloadsStore((s) => s.core);
  const loaded = useDownloadsStore((s) => s.loaded);
  const load = useDownloadsStore((s) => s.load);
  const create = useDownloadsStore((s) => s.create);
  const pause = useDownloadsStore((s) => s.pause);
  const resume = useDownloadsStore((s) => s.resume);
  const cancel = useDownloadsStore((s) => s.cancel);
  const remove = useDownloadsStore((s) => s.remove);
  const recover = useDownloadsStore((s) => s.recover);
  const replaceUrl = useDownloadsStore((s) => s.replaceUrl);
  const retry = useDownloadsStore((s) => s.retry);
  const queueMove = useDownloadsStore((s) => s.queueMove);
  const startAll = useDownloadsStore((s) => s.startAll);
  const pauseAll = useDownloadsStore((s) => s.pauseAll);
  const setSpeedLimit = useDownloadsStore((s) => s.setSpeedLimit);
  const setProxy = useDownloadsStore((s) => s.setProxy);

  const downloadDir = useSettingsStore((s) => s.settings?.downloadDir ?? "~/Downloads");
  const proxyProfiles = useProxyStore((s) => s.profiles);
  const loadProxies = useProxyStore((s) => s.load);
  const proxyLoaded = useProxyStore((s) => s.loaded);
  const [url, setUrl] = useState("");
  /** undefined = app default (Settings) · null = explicit direct · profile id = that profile. */
  const [proxyChoice, setProxyChoice] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load().catch(() => undefined);
    if (!proxyLoaded) void loadProxies().catch(() => undefined);
  }, [loaded, load, proxyLoaded, loadProxies]);

  const submit = (): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    create(trimmed, downloadDir, proxyChoice).catch((e) => setError(String(e?.message ?? e)));
    setUrl("");
  };

  // Display order (stable): queued jobs follow their queue slots; everything else
  // keeps the store order (newest first).
  const ordered = [...jobs].sort(compareQueueDisplay);
  const hasPausable = jobs.some((j) => ["queued", "probing", "downloading"].includes(j.status));
  const hasPaused = jobs.some((j) => j.status === "paused");

  return (
    <div className={styles.page}>
      {CORE_BANNER[core] ? (
        <MessageBar intent={core === "unavailable" ? "error" : "info"}>
          <MessageBarBody>{CORE_BANNER[core]}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.form}>
        <Input
          value={url}
          onChange={(_, data) => setUrl(data.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Paste a direct download URL"
          style={{ flex: 1 }}
          aria-label="Download URL"
        />
        <Dropdown
          value={
            proxyChoice === undefined
              ? "App default"
              : proxyChoice === null
                ? "Direct"
                : (proxyProfiles.find((p) => p.id === proxyChoice)?.name ?? "Proxy")
          }
          selectedOptions={[proxyChoice === undefined ? "__default" : proxyChoice === null ? "__direct" : proxyChoice]}
          onOptionSelect={(_, d) =>
            setProxyChoice(
              d.optionValue === "__default" ? undefined : d.optionValue === "__direct" ? null : (d.optionValue as string),
            )
          }
          style={{ minWidth: "150px" }}
          aria-label="Proxy for this download"
        >
          <Option value="__default">App default</Option>
          <Option value="__direct">Direct</Option>
          {proxyProfiles.map((p) => (
            <Option key={p.id} value={p.id}>
              {p.name}
            </Option>
          ))}
        </Dropdown>
        <Button appearance="primary" icon={<AddRegular />} onClick={submit} disabled={core !== "ready"}>
          Download
        </Button>
      </div>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.row}>
        <Text className={styles.meta}>Saving to {downloadDir}</Text>
        <div className={styles.actions}>
          <Button
            appearance="subtle"
            size="small"
            icon={<PlayRegular />}
            disabled={!hasPaused}
            onClick={() => startAll().catch((e) => setError(String(e?.message ?? e)))}
            aria-label="Start all paused downloads"
          >
            Start all
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<PauseRegular />}
            disabled={!hasPausable}
            onClick={() => pauseAll().catch((e) => setError(String(e?.message ?? e)))}
            aria-label="Pause all downloads"
          >
            Pause all
          </Button>
        </div>
      </div>

      {ordered.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onPause={() => void pause(job.id)}
          onResume={() => void resume(job.id)}
          onCancel={() => void cancel(job.id)}
          onRemove={() => void remove(job.id, false)}
          onRecover={() =>
            recover(job.id).catch((e) => setError(String(e?.message ?? e)))
          }
          onRetry={() =>
            retry(job.id).catch((e) => setError(String(e?.message ?? e)))
          }
          onReplaceUrl={(next) =>
            replaceUrl(job.id, next).catch((e) => setError(String(e?.message ?? e)))
          }
          onQueueMove={(dir) =>
            queueMove(job.id, dir).catch((e) => setError(String(e?.message ?? e)))
          }
          onSetSpeedLimit={(kbps) =>
            setSpeedLimit(job.id, kbps).catch((e) => setError(String(e?.message ?? e)))
          }
          onSetProxy={(pid) =>
            setProxy(job.id, pid).catch((e) => setError(String(e?.message ?? e)))
          }
        />
      ))}
      {jobs.length === 0 && loaded ? (
        <div className={styles.empty}>
          <Spinner size="tiny" /> No downloads yet — paste a URL above.
        </div>
      ) : null}
    </div>
  );
}

function JobCard(props: {
  job: DownloadJob;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onRecover: () => void;
  onRetry: () => void;
  onReplaceUrl: (url: string) => void;
  onQueueMove: (direction: QueueDirection) => void;
  onSetSpeedLimit: (kbps: number) => void;
  onSetProxy: (proxyProfileId: string | null) => void;
}): ReactNode {
  const styles = useStyles();
  const { job } = props;
  const active = job.status === "downloading" || job.status === "probing" || job.status === "queued";
  const finished = job.status === "completed";
  const progress = job.totalBytes ? Math.min(1, job.receivedBytes / job.totalBytes) : undefined;
  const failedOrStopped = job.status === "failed" || job.status === "canceled";
  const hint = job.status === "failed" || job.errorCode === "proxy_profile_not_found"
    ? RECOVERY_HINT[job.errorCode ?? ""]
    : undefined;
  const inQueue = job.status === "queued";
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacementUrl, setReplacementUrl] = useState("");
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitKbps, setLimitKbps] = useState(String(job.speedLimitKBps ?? 0));
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyPick, setProxyPick] = useState<string | null>(job.proxyProfileId);
  const proxyProfiles = useProxyStore((s) => s.profiles);
  const proxyName = job.proxyProfileId
    ? (proxyProfiles.find((p) => p.id === job.proxyProfileId)?.name ?? "unavailable")
    : null;

  const submitReplace = (): void => {
    const trimmed = replacementUrl.trim();
    if (!trimmed) return;
    setReplaceOpen(false);
    setReplacementUrl("");
    props.onReplaceUrl(trimmed);
  };

  const submitLimit = (): void => {
    const n = Number.parseInt(limitKbps, 10);
    setLimitOpen(false);
    props.onSetSpeedLimit(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  };

  return (
    <div className={styles.job}>
      <div className={styles.row}>
        <Text className={styles.name} title={job.destinationPath ?? job.url}>
          {job.destinationPath?.split(/[\\/]/).pop() ?? job.url}
        </Text>
        <Text className={styles.meta}>{STATUS_LABEL[job.status] ?? job.status}</Text>
        {inQueue && job.queuePosition !== null ? (
          <Text className={styles.meta} title="Position in the download queue">
            #{(job.queuePosition ?? 0) + 1}
          </Text>
        ) : null}
        <div className={styles.actions}>
          {inQueue ? (
            <>
              <Button appearance="subtle" size="small" icon={<CaretUpRegular />} onClick={() => props.onQueueMove("up")} aria-label="Move up in queue" title="Move up" />
              <Button appearance="subtle" size="small" icon={<CaretDownRegular />} onClick={() => props.onQueueMove("down")} aria-label="Move down in queue" title="Move down" />
            </>
          ) : null}
          {active ? (
            <Button appearance="subtle" size="small" icon={<PauseRegular />} onClick={props.onPause} aria-label="Pause" />
          ) : null}
          {job.status === "paused" ? (
            <Button appearance="subtle" size="small" icon={<PlayRegular />} onClick={props.onResume} aria-label="Resume" />
          ) : null}
          {active ? (
            <Button appearance="subtle" size="small" icon={<StopRegular />} onClick={props.onCancel} aria-label="Cancel" />
          ) : null}
          {failedOrStopped ? (
            <Button appearance="subtle" size="small" icon={<ArrowClockwiseRegular />} onClick={props.onRetry} aria-label="Retry" />
          ) : null}
          {failedOrStopped || job.status === "paused" ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowRepeatAllRegular />}
              onClick={props.onRecover}
              aria-label="Recover"
              title="Re-acquire the source and keep the downloaded bytes"
            />
          ) : null}
          {failedOrStopped || job.status === "paused" ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<LinkEditRegular />}
              onClick={() => setReplaceOpen(true)}
              aria-label="Replace URL"
              title="Rebind this download to a new URL (keeps the bytes)"
            />
          ) : null}
          {finished || failedOrStopped ? (
            <Button appearance="subtle" size="small" icon={<DeleteRegular />} onClick={props.onRemove} aria-label="Remove" />
          ) : null}
          {!finished ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<TopSpeedRegular />}
              onClick={() => {
                setLimitKbps(String(job.speedLimitKBps ?? 0));
                setLimitOpen(true);
              }}
              aria-label="Speed limit"
              title="Cap this download's bandwidth (0 = unlimited)"
            />
          ) : null}
          {!active ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<GlobeShieldRegular />}
              onClick={() => {
                setProxyPick(job.proxyProfileId);
                setProxyOpen(true);
              }}
              aria-label="Proxy"
              title="Route this download through a proxy profile"
            />
          ) : null}
        </div>
      </div>
      <ProgressBar value={progress} shape="rounded" />
      <div className={styles.row}>
        <Text className={styles.meta}>
          {formatBytes(job.receivedBytes)} / {formatBytes(job.totalBytes)}
        </Text>
        {job.status === "downloading" ? (
          <>
            <Text className={styles.meta}>· {formatBytes(job.speedBps)}/s</Text>
            <Text className={styles.meta}>· ETA {formatEta(job.etaSeconds)}</Text>
          </>
        ) : null}
        {job.segmentCount && job.segmentCount > 1 && job.status === "downloading" ? (
          <Text className={styles.meta} title="Parallel range connections">
            · <PlugConnectedRegular style={{ verticalAlign: -2 }} /> {job.segmentCount} connections
          </Text>
        ) : null}
        {job.recoveryCount && job.recoveryCount > 0 ? (
          <Text className={styles.meta} title="Times this job was rebound to a (re-)acquired source">
            · <ArrowRepeatAllRegular style={{ verticalAlign: -2 }} /> recovered ×{job.recoveryCount}
          </Text>
        ) : null}
        {job.checksumVerified === true ? (
          <Text className={styles.meta} title={`SHA-256 ${job.checksumActual ?? ""}`}>
            · <ShieldCheckmarkRegular style={{ verticalAlign: -2, color: tokens.colorPaletteGreenForeground1 }} /> checksum verified
          </Text>
        ) : null}
        {job.checksumVerified === false ? (
          <Text className={styles.meta} title={`expected ${job.checksumExpected ?? ""}, got ${job.checksumActual ?? ""}`}>
            · <ShieldErrorRegular style={{ verticalAlign: -2, color: tokens.colorPaletteRedForeground1 }} /> checksum mismatch
          </Text>
        ) : null}
        {job.speedLimitKBps ? (
          <Text className={styles.meta} title="Per-job bandwidth cap">
            · <TopSpeedRegular style={{ verticalAlign: -2 }} /> capped at {job.speedLimitKBps} KiB/s
          </Text>
        ) : null}
        {proxyName ? (
          <Text className={styles.meta} title="This download routes through a proxy profile">
            · <GlobeShieldRegular style={{ verticalAlign: -2 }} /> proxy: {proxyName}
          </Text>
        ) : null}
        {job.errorCode ? <Text className={styles.meta}>· error: {job.errorCode}</Text> : null}
      </div>
      {hint ? <Text className={styles.meta}>{hint}</Text> : null}

      <Dialog open={proxyOpen} onOpenChange={(_, d) => setProxyOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Proxy for this download</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                Route this download through a proxy profile. Active downloads must be paused
                first; changing the route keeps all downloaded bytes.
              </Text>
              <Dropdown
                value={proxyPick ? (proxyProfiles.find((p) => p.id === proxyPick)?.name ?? "Proxy") : "Direct"}
                selectedOptions={proxyPick ? [proxyPick] : []}
                onOptionSelect={(_, d) => setProxyPick((d.optionValue as string) || null)}
                style={{ width: "240px", marginTop: "8px" }}
                aria-label="Proxy profile"
              >
                <Option value="">Direct</Option>
                {proxyProfiles.map((p) => (
                  <Option key={p.id} value={p.id}>
                    {p.name}
                  </Option>
                ))}
              </Dropdown>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setProxyOpen(false)}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setProxyOpen(false);
                  props.onSetProxy(proxyPick);
                }}
              >
                Apply
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={replaceOpen} onOpenChange={(_, d) => setReplaceOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Replace URL</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                Rebind this download to a new source. Downloaded bytes are kept and only the
                missing ranges are fetched from the new URL.
              </Text>
              <Input
                value={replacementUrl}
                onChange={(_, data) => setReplacementUrl(data.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitReplace();
                }}
                placeholder="https://…"
                style={{ width: "100%", marginTop: "8px" }}
                aria-label="New source URL"
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setReplaceOpen(false)}>Cancel</Button>
              <Button appearance="primary" disabled={!replacementUrl.trim()} onClick={submitReplace}>
                Rebind
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={limitOpen} onOpenChange={(_, d) => setLimitOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Speed limit</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                Cap this download's bandwidth in KiB/s. Enter 0 for unlimited.
              </Text>
              <Input
                value={limitKbps}
                onChange={(_, data) => setLimitKbps(data.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitLimit();
                }}
                inputMode="numeric"
                style={{ width: "160px", marginTop: "8px" }}
                aria-label="Speed limit in KiB per second"
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setLimitOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={submitLimit}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
