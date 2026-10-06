import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Input,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  DeleteRegular,
  PauseRegular,
  PlayRegular,
  StopRegular,
  AddRegular,
} from "@fluentui/react-icons";
import { useDownloadsStore, type CoreStatus } from "../stores/downloads.js";
import { useSettingsStore } from "../stores/settings.js";
import type { DownloadJob } from "@unidm/contracts";

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

  const downloadDir = useSettingsStore((s) => s.settings?.downloadDir ?? "~/Downloads");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load().catch(() => undefined);
  }, [loaded, load]);

  const submit = (): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    create(trimmed, downloadDir).catch((e) => setError(String(e?.message ?? e)));
    setUrl("");
  };

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
        <Button appearance="primary" icon={<AddRegular />} onClick={submit} disabled={core !== "ready"}>
          Download
        </Button>
      </div>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
      <Text className={styles.meta}>Saving to {downloadDir}</Text>

      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onPause={() => void pause(job.id)}
          onResume={() => void resume(job.id)}
          onCancel={() => void cancel(job.id)}
          onRemove={() => void remove(job.id, false)}
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
}): ReactNode {
  const styles = useStyles();
  const { job } = props;
  const active = job.status === "downloading" || job.status === "probing" || job.status === "queued";
  const finished = job.status === "completed";
  const progress = job.totalBytes ? Math.min(1, job.receivedBytes / job.totalBytes) : undefined;

  return (
    <div className={styles.job}>
      <div className={styles.row}>
        <Text className={styles.name} title={job.destinationPath ?? job.url}>
          {job.destinationPath?.split(/[\\/]/).pop() ?? job.url}
        </Text>
        <Text className={styles.meta}>{STATUS_LABEL[job.status] ?? job.status}</Text>
        <div className={styles.actions}>
          {active ? (
            <Button appearance="subtle" size="small" icon={<PauseRegular />} onClick={props.onPause} aria-label="Pause" />
          ) : null}
          {job.status === "paused" || job.status === "failed" || job.status === "canceled" ? (
            <Button appearance="subtle" size="small" icon={<PlayRegular />} onClick={props.onResume} aria-label="Resume" />
          ) : null}
          {active ? (
            <Button appearance="subtle" size="small" icon={<StopRegular />} onClick={props.onCancel} aria-label="Cancel" />
          ) : null}
          {finished || job.status === "failed" || job.status === "canceled" ? (
            <>
              <Button appearance="subtle" size="small" icon={<ArrowClockwiseRegular />} onClick={props.onResume} aria-label="Restart" />
              <Button appearance="subtle" size="small" icon={<DeleteRegular />} onClick={props.onRemove} aria-label="Remove" />
            </>
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
        {job.errorCode ? <Text className={styles.meta}>· error: {job.errorCode}</Text> : null}
      </div>
    </div>
  );
}
