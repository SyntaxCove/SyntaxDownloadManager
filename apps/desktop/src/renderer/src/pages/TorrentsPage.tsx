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
import { useI18n } from "../i18n/context.js";
import { formatBytes, formatNumber } from "../i18n/format.js";
import { pluralKey } from "../i18n/translate.js";
import type { TorrentJob, TorrentStatus } from "@syntaxdm/contracts";

/**
 * Torrents page — Phase 13: add .torrent files or magnet URIs into the native engine,
 * watch per-piece progress (verified bytes only — nothing is shown as downloaded before
 * its SHA-1 verified), and drive the lifecycle (pause / resume / cancel / remove).
 * Proxy routing is fail-closed in the core: a profile that vanishes pauses the torrent
 * rather than leaking direct traffic. Phase 21: localized strings.
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

const STATUS_KEYS: Record<TorrentStatus, string> = {
  queued: "torrents.status.queued",
  metadata: "torrents.status.metadata",
  downloading: "torrents.status.downloading",
  seeding: "torrents.status.seeding",
  paused: "torrents.status.paused",
  completed: "torrents.status.completed",
  failed: "torrents.status.failed",
  canceled: "torrents.status.canceled",
};

function torrentProgress(job: TorrentJob): number {
  if (job.totalBytes === null || job.totalBytes === 0) return 0;
  return Math.min(1, job.receivedBytes / job.totalBytes);
}

export function TorrentsPage(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
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
        addError: t("torrents.add.fileTooBig"),
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
        <Text as="h2" className={styles.title}>
          {t("torrents.add.title")}
        </Text>
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
            aria-label={t("torrents.add.magnetAria")}
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
              {torrentFileName ?? t("torrents.add.chooseFile")}
            </Button>
          </label>
        </div>
        <div className={styles.bar}>
          <Input
            className={styles.destInput}
            placeholder={t("torrents.add.destPlaceholder")}
            value={destinationDir}
            onChange={(_, d) => setDestinationDir(d.value)}
            aria-label={t("torrents.add.destAria")}
          />
          <select
            className={styles.proxyPicker}
            value={proxyProfileId ?? ""}
            onChange={(e) => setProxyProfileId(e.target.value || null)}
            aria-label={t("torrents.add.proxyAria")}
          >
            <option value="">{t("common.directNoProxy")}</option>
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
            {t("torrents.add.action")}
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
          <Text className={styles.meta}>{t("torrents.empty")}</Text>
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
              <ArrowSquareDownRegular aria-hidden="true" />
              <Text className={styles.name}>
                {job.name ?? (job.sourceKind === "magnet" ? t("torrents.resolvingName") : "…")}
              </Text>
              <span className={styles.badge}>{t(STATUS_KEYS[job.status])}</span>
              <div className={styles.actions}>
                {active ? (
                  <Tooltip content={t("torrents.row.pause")} relationship="label">
                    <Button
                      icon={<PauseRegular />}
                      appearance="subtle"
                      onClick={() => void pause(job.id)}
                      aria-label={t("torrents.row.pauseAria")}
                    />
                  </Tooltip>
                ) : null}
                {resumable ? (
                  <Tooltip content={t("torrents.row.resume")} relationship="label">
                    <Button
                      icon={<PlayRegular />}
                      appearance="subtle"
                      onClick={() => void resume(job.id)}
                      aria-label={t("torrents.row.resumeAria")}
                    />
                  </Tooltip>
                ) : null}
                {active ? (
                  <Tooltip content={t("torrents.row.cancel")} relationship="label">
                    <Button
                      icon={<DismissRegular />}
                      appearance="subtle"
                      onClick={() => void cancel(job.id)}
                      aria-label={t("torrents.row.cancelAria")}
                    />
                  </Tooltip>
                ) : null}
                <Tooltip content={t("torrents.row.remove")} relationship="label">
                  <Button
                    icon={<DeleteRegular />}
                    appearance="subtle"
                    onClick={() => void remove(job.id, deleteFiles)}
                    aria-label={t("torrents.row.removeAria")}
                  />
                </Tooltip>
              </div>
            </div>
            <div className={styles.progressRow}>
              <ProgressBar
                value={torrentProgress(job)}
                shape="rounded"
                style={{ flex: 1 }}
                aria-label={t("torrents.row.progressAria")}
              />
              <Text className={styles.meta}>
                {formatBytes(job.receivedBytes, t.lang)} / {formatBytes(job.totalBytes, t.lang)}
              </Text>
            </div>
            <Text className={styles.meta}>
              ↓ {formatBytes(job.downloadSpeedBps, t.lang)}/s · ↑ {formatBytes(job.uploadSpeedBps, t.lang)}/s ·{" "}
              {t("torrents.row.peers", { peers: formatNumber(job.peers, t.lang), seeds: formatNumber(job.seeds, t.lang) })}
              {job.numPieces ? ` · ${t("torrents.row.pieces", { n: formatNumber(job.numPieces, t.lang) })}` : ""}
              {job.etaSeconds !== null && job.status === "downloading"
                ? ` · ${t("torrents.row.eta", { n: formatNumber(job.etaSeconds, t.lang) })}`
                : ""}
            </Text>
            {job.files.length > 1 ? (
              <Text className={styles.meta}>
                {t(pluralKey("torrents.row.files", job.files.length), { n: formatNumber(job.files.length, t.lang) })}
              </Text>
            ) : null}
            {job.errorCode ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  {job.errorCode}
                  {job.status === "paused" || job.status === "failed"
                    ? t("torrents.row.resumeToRetry")
                    : ""}
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </div>
        );
      })}

      <Checkbox
        label={t("torrents.deleteFilesLabel")}
        checked={deleteFiles}
        onChange={(_, d) => setDeleteFiles(!!d.checked)}
      />
    </div>
  );
}
