import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  ProgressBar,
  Text,
  makeStyles,
  tokens,
  Tooltip,
  Checkbox,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowSquareDownRegular,
  DeleteRegular,
  DismissRegular,
  FolderRegular,
  PauseRegular,
  PlayRegular,
} from "@fluentui/react-icons";
import { useTorrentStore } from "../stores/torrent.js";
import { useProxyStore } from "../stores/proxy.js";
import { useSettingsStore } from "../stores/settings.js";
import { formatBytes } from "./DownloadsPage.js";
import type { TorrentJob, TorrentStatus } from "@syntaxdm/contracts";

/**
 * Torrents page — Phase 13: add .torrent files or magnet URIs into the native engine,
 * watch per-piece progress (verified bytes only — nothing is shown as downloaded before
 * its SHA-1 verified), and drive the lifecycle (pause / resume / cancel / remove).
 * Proxy routing is fail-closed in the core: a profile that vanishes pauses the torrent
 * rather than leaking direct traffic.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "960px" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  title: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  bar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  magnetInput: { flex: 1, minWidth: "260px" },
  destInput: { flex: 1, minWidth: "220px" },
  proxyPicker: { width: "220px" },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowHead: { display: "flex", gap: "8px", alignItems: "center" },
  name: { flex: 1, fontWeight: tokens.fontWeightSemibold, overflowWrap: "anywhere" },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  badge: {
    fontSize: tokens.fontSizeBase200,
    padding: "1px 8px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground4,
  },
  actions: { display: "flex", gap: "4px" },
  progressRow: { display: "flex", alignItems: "center", gap: "8px" },
});

function statusBadge(status: TorrentStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "metadata":
      return "resolving metadata";
    case "downloading":
      return "downloading";
    case "seeding":
      return "seeding";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
  }
}

function torrentProgress(job: TorrentJob): number {
  if (job.totalBytes === null || job.totalBytes === 0) return 0;
  return Math.min(1, job.receivedBytes / job.totalBytes);
}

export function TorrentsPage(): ReactNode {
  const styles = useStyles();
  const {
    jobs,
    jobsLoaded,
    magnetUri,
    addError,
    setMagnetUri,
    loadJobs,
    addTorrent,
    pause,
    resume,
    cancel,
    remove,
  } = useTorrentStore();
  const settings = useSettingsStore();
  const proxies = useProxyStore();
  const [destinationDir, setDestinationDir] = useState("");
  const [proxyProfileId, setProxyProfileId] = useState<string | null>(null);
  const [torrentFileB64, setTorrentFileB64] = useState<string | null>(null);
  const [torrentFileName, setTorrentFileName] = useState<string | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!jobsLoaded) {
      void loadJobs();
    }
  }, [jobsLoaded, loadJobs]);

  useEffect(() => {
    const dir = settings.settings?.downloadDir;
    if (dir && !destinationDir) setDestinationDir(dir);
  }, [settings.settings?.downloadDir, destinationDir]);

  const onPickFile = async (file: File | null) => {
    if (!file) {
      setTorrentFileB64(null);
      setTorrentFileName(null);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setTorrentFileB64(null);
      setTorrentFileName(null);
      useTorrentStore.setState({
        addError: "the .torrent file exceeds the 8 MiB cap",
      });
      return;
    }
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    setTorrentFileB64(btoa(binary));
    setTorrentFileName(file.name);
    setMagnetUri("");
  };

  const onAdd = async () => {
    setBusy(true);
    await addTorrent({
      destinationDir,
      torrentFileB64: torrentFileB64 ?? undefined,
      proxyProfileId,
    });
    setBusy(false);
  };

  const canAdd = destinationDir.trim().length > 0 && (!!magnetUri.trim() || !!torrentFileB64);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Text className={styles.title}>Add torrent</Text>
        <div className={styles.bar}>
          <Input
            className={styles.magnetInput}
            placeholder="magnet:?xt=urn:btih:…"
            value={magnetUri}
            onChange={(_, d) => {
              setMagnetUri(d.value);
              if (d.value) {
                setTorrentFileB64(null);
                setTorrentFileName(null);
              }
            }}
            disabled={!!torrentFileB64}
            aria-label="Magnet URI"
          />
          <label>
            <input
              type="file"
              accept=".torrent"
              style={{ display: "none" }}
              onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            />
            <Button
              icon={<FolderRegular />}
              appearance={torrentFileB64 ? "primary" : "subtle"}
              onClick={(e) => {
                // the hidden input triggers via the label
                const label = (e.target as HTMLElement).closest("label");
                label?.querySelector("input")?.click();
              }}
            >
              {torrentFileName ?? "Choose .torrent"}
            </Button>
          </label>
        </div>
        <div className={styles.bar}>
          <Input
            className={styles.destInput}
            placeholder="Destination folder"
            value={destinationDir}
            onChange={(_, d) => setDestinationDir(d.value)}
            aria-label="Destination folder"
          />
          <select
            className={styles.proxyPicker}
            value={proxyProfileId ?? ""}
            onChange={(e) => setProxyProfileId(e.target.value || null)}
            aria-label="Proxy profile"
          >
            <option value="">Direct (no proxy)</option>
            {proxies.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            appearance="primary"
            icon={<AddRegular />}
            disabled={!canAdd || busy}
            onClick={() => void onAdd()}
          >
            Add
          </Button>
        </div>
        {addError ? (
          <MessageBar intent="error">
            <MessageBarBody>{addError}</MessageBarBody>
          </MessageBar>
        ) : null}
      </div>

      {jobs.length === 0 ? (
        <div className={styles.row}>
          <Text className={styles.meta}>
            No torrents yet — add a .torrent file or a magnet URI above.
          </Text>
        </div>
      ) : null}

      {jobs.map((job) => {
        const active =
          job.status === "downloading" || job.status === "metadata" || job.status === "seeding";
        const resumable =
          job.status === "paused" ||
          job.status === "canceled" ||
          job.status === "failed" ||
          job.status === "completed";
        return (
          <div key={job.id} className={styles.row}>
            <div className={styles.rowHead}>
              <ArrowSquareDownRegular />
              <Text className={styles.name}>
                {job.name ?? (job.sourceKind === "magnet" ? "Resolving metadata…" : "…")}
              </Text>
              <span className={styles.badge}>{statusBadge(job.status)}</span>
              <div className={styles.actions}>
                {active ? (
                  <Tooltip content="Pause" relationship="label">
                    <Button
                      icon={<PauseRegular />}
                      appearance="subtle"
                      onClick={() => void pause(job.id)}
                      aria-label="Pause torrent"
                    />
                  </Tooltip>
                ) : null}
                {resumable ? (
                  <Tooltip content="Resume" relationship="label">
                    <Button
                      icon={<PlayRegular />}
                      appearance="subtle"
                      onClick={() => void resume(job.id)}
                      aria-label="Resume torrent"
                    />
                  </Tooltip>
                ) : null}
                {active ? (
                  <Tooltip content="Cancel (keep data)" relationship="label">
                    <Button
                      icon={<DismissRegular />}
                      appearance="subtle"
                      onClick={() => void cancel(job.id)}
                      aria-label="Cancel torrent"
                    />
                  </Tooltip>
                ) : null}
                <Tooltip content="Remove" relationship="label">
                  <Button
                    icon={<DeleteRegular />}
                    appearance="subtle"
                    onClick={() => void remove(job.id, deleteFiles)}
                    aria-label="Remove torrent"
                  />
                </Tooltip>
              </div>
            </div>
            <div className={styles.progressRow}>
              <ProgressBar
                value={torrentProgress(job)}
                shape="rounded"
                style={{ flex: 1 }}
              />
              <Text className={styles.meta}>
                {formatBytes(job.receivedBytes)} / {formatBytes(job.totalBytes)}
              </Text>
            </div>
            <Text className={styles.meta}>
              ↓ {formatBytes(job.downloadSpeedBps)}/s · ↑ {formatBytes(job.uploadSpeedBps)}/s ·
              peers {job.peers} (seeds {job.seeds})
              {job.numPieces ? ` · ${job.numPieces} pieces` : ""}
              {job.etaSeconds !== null && job.status === "downloading"
                ? ` · ETA ${job.etaSeconds}s`
                : ""}
            </Text>
            {job.files.length > 1 ? (
              <Text className={styles.meta}>{job.files.length} files</Text>
            ) : null}
            {job.errorCode ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  {job.errorCode}
                  {job.status === "paused" || job.status === "failed"
                    ? " — resume to retry"
                    : ""}
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </div>
        );
      })}

      <Checkbox
        label="Delete downloaded files when removing a torrent"
        checked={deleteFiles}
        onChange={(_, d) => setDeleteFiles(!!d.checked)}
      />
    </div>
  );
}
