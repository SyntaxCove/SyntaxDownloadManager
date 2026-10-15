import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Checkbox,
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
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  PauseRegular,
  PlayRegular,
  DeleteRegular,
  DismissRegular,
  SearchRegular,
  VideoRegular,
} from "@fluentui/react-icons";
import { useMediaStore } from "../stores/media.js";
import { useProxyStore } from "../stores/proxy.js";
import { useSettingsStore } from "../stores/settings.js";
import { formatBytes } from "./DownloadsPage.js";
import type { AudioFormat, MediaJob, SubtitleTrack, VideoFormat } from "@syntaxdm/contracts";

/**
 * Media page — Phase 11 inspection + Phase 12 pipeline: pick a video format, an audio
 * format and/or subtitle tracks, choose the mux container, and start a persistent media
 * job (bundled yt-dlp downloads → bundled FFmpeg mux). Live manifests surface honestly:
 * recording live streams is not supported yet, so the download is disabled for them.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "960px" },
  bar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  urlInput: { flex: 1, minWidth: "260px" },
  proxyPicker: { width: "200px" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  title: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  table: { display: "flex", flexDirection: "column", gap: "2px", fontSize: tokens.fontSizeBase200 },
  head: {
    display: "flex",
    gap: "8px",
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    padding: "4px 6px",
  },
  row: {
    display: "flex",
    gap: "8px",
    padding: "4px 6px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rowSelectable: { cursor: "pointer" },
  rowSelected: {
    outline: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  badge: {
    alignSelf: "flex-start",
    padding: "1px 8px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase200,
  },
  section: { fontWeight: tokens.fontWeightSemibold, marginTop: "4px" },
  rowMeta: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  note: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  downloadBar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" },
  containerPicker: { width: "120px" },
  jobCard: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  jobTop: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  jobActions: { display: "flex", gap: "4px", marginLeft: "auto" },
  statusBadge: {
    padding: "1px 8px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground5,
    fontSize: tokens.fontSizeBase200,
  },
});

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatBitrate(bps: number | null): string {
  return bps === null ? "—" : `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

const ACTIVE_STATUSES = new Set(["queued", "extracting", "downloading", "muxing"]);

function JobRow({ job }: { job: MediaJob }): ReactNode {
  const styles = useStyles();
  const pause = useMediaStore((s) => s.pause);
  const resume = useMediaStore((s) => s.resume);
  const cancel = useMediaStore((s) => s.cancel);
  const remove = useMediaStore((s) => s.remove);
  const [error, setError] = useState<string | null>(null);

  const active = ACTIVE_STATUSES.has(job.status);
  const pct =
    job.totalBytes !== null && job.totalBytes > 0
      ? Math.min(1, job.receivedBytes / job.totalBytes)
      : null;

  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((e) => setError(String(e?.message ?? e)));
  };

  return (
    <div className={styles.jobCard}>
      <div className={styles.jobTop}>
        <span className={styles.statusBadge}>{job.status}</span>
        <Text weight="semibold">{job.title ?? job.sourceUrl}</Text>
        {job.proxyProfileId ? <span className={styles.badge}>proxy</span> : null}
        <div className={styles.jobActions}>
          {job.status === "paused" || job.status === "failed" || job.status === "canceled" ? (
            <Tooltip content="Resume" relationship="label">
              <Button
                size="small"
                icon={<PlayRegular />}
                onClick={() => run(() => resume(job.id))}
              />
            </Tooltip>
          ) : null}
          {active && job.status !== "queued" ? (
            <Tooltip content="Pause" relationship="label">
              <Button size="small" icon={<PauseRegular />} onClick={() => run(() => pause(job.id))} />
            </Tooltip>
          ) : null}
          {active && job.status !== "queued" ? (
            <Tooltip content="Cancel" relationship="label">
              <Button
                size="small"
                icon={<DismissRegular />}
                onClick={() => run(() => cancel(job.id))}
              />
            </Tooltip>
          ) : null}
          <Tooltip content="Remove (keeps files)" relationship="label">
            <Button
              size="small"
              icon={<DeleteRegular />}
              onClick={() => run(() => remove(job.id, false))}
            />
          </Tooltip>
        </div>
      </div>
      <Text className={styles.meta}>
        {job.receivedBytes > 0 || job.totalBytes !== null
          ? `${formatBytes(job.receivedBytes)}${job.totalBytes !== null ? ` / ${formatBytes(job.totalBytes)}` : ""}`
          : ""}
        {job.speedBps ? ` · ${formatBytes(job.speedBps)}/s` : ""}
        {job.etaSeconds !== null ? ` · ETA ${formatDuration(job.etaSeconds)}` : ""}
        {job.destinationPath ? ` · ${job.destinationPath}` : ""}
      </Text>
      {active ? (
        <ProgressBar
          value={pct ?? undefined}
          shape="rounded"
          thickness="medium"
          aria-label={`media job progress ${job.status}`}
        />
      ) : null}
      {job.errorCode ? (
        <MessageBar intent={job.status === "failed" ? "error" : "warning"}>
          <MessageBarBody>{job.errorCode}</MessageBarBody>
        </MessageBar>
      ) : null}
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
    </div>
  );
}

export function MediaPage(): ReactNode {
  const styles = useStyles();
  const {
    phase, url, manifest, error, setUrl, inspect,
    jobs, jobsLoaded, selection, setSelection, resetSelection, loadJobs, download,
  } = useMediaStore();
  const profiles = useProxyStore((s) => s.profiles);
  const loadProxies = useProxyStore((s) => s.load);
  const downloadDir = useSettingsStore((s) => s.settings?.downloadDir ?? "~/Downloads");
  const [proxyId, setProxyId] = useState<string | undefined>(undefined);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void loadProxies();
    void loadJobs().catch(() => undefined);
  }, [loadProxies, loadJobs]);

  const busy = phase === "inspecting";
  const hasSelection = selection.videoFormatId !== null || selection.audioFormatId !== null;
  const selectionSummary = [
    selection.videoFormatId ? `video ${selection.videoFormatId}` : null,
    selection.audioFormatId ? `audio ${selection.audioFormatId}` : null,
    selection.subtitles.length > 0 ? `${selection.subtitles.length} subtitle(s)` : null,
  ]
    .filter(Boolean)
    .join(" + ");

  const startDownload = () => {
    setCreateError(null);
    if (!manifest) return;
    download({
      url: manifest.sourceUrl,
      destinationDir: downloadDir,
      proxyProfileId: proxyId ?? null,
    }).catch((e) => setCreateError(String(e?.message ?? e)));
  };

  const toggleSubtitle = (t: SubtitleTrack) => {
    const existing = selection.subtitles;
    const key = (s: { language: string; extension: string }) =>
      `${s.language}/${s.extension}`;
    const exists = existing.some((s) => key(s) === key(t));
    setSelection({
      subtitles: exists
        ? existing.filter((s) => key(s) !== key(t))
        : [
            ...existing,
            {
              language: t.language,
              extension: t.extension,
              // The manifest marks unknown auto-generated state as null; a selection
              // needs the concrete flag yt-dlp consumes (--write-subs vs --write-auto-subs).
              isAutoGenerated: t.isAutoGenerated ?? false,
            },
          ],
    });
  };

  return (
    <div className={styles.page}>
      <Text size={500} weight="semibold">
        Media
      </Text>

      <div className={styles.bar}>
        <Input
          className={styles.urlInput}
          placeholder="Paste a media page URL (video, audio, …)"
          value={url}
          onChange={(_, data) => setUrl(data.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) {
              resetSelection();
              void inspect(proxyId);
            }
          }}
          disabled={busy}
          contentAfter={busy ? <Spinner size="tiny" /> : <SearchRegular />}
        />
        <Dropdown
          className={styles.proxyPicker}
          placeholder="Direct connection"
          clearable
          selectedOptions={proxyId ? [proxyId] : []}
          onOptionSelect={(_, data) => setProxyId(data.optionValue ?? undefined)}
        >
          {profiles.map((p) => (
            <Option key={p.id} value={p.id} text={p.name}>
              {p.name} ({p.scheme})
            </Option>
          ))}
        </Dropdown>
        <Button
          appearance="primary"
          icon={<VideoRegular />}
          disabled={busy || url.trim().length === 0}
          onClick={() => {
            resetSelection();
            void inspect(proxyId);
          }}
        >
          Inspect
        </Button>
      </div>

      {phase === "error" && error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {phase === "ready" && manifest ? (
        <div className={styles.card}>
          <Text className={styles.title}>{manifest.title}</Text>
          <div className={styles.rowMeta}>
            <span className={styles.badge}>{manifest.extractor}</span>
            {manifest.isLive ? <span className={styles.badge}>LIVE</span> : null}
            <Text className={styles.meta}>
              {formatDuration(manifest.durationSeconds)} · {manifest.videos.length} video ·{" "}
              {manifest.audios.length} audio · {manifest.subtitles.length} subtitle
            </Text>
          </div>
          <Text className={styles.meta}>{manifest.webpageUrl}</Text>

          {manifest.videos.length > 0 ? (
            <>
              <Text className={styles.section}>Video formats</Text>
              <div className={styles.table} role="table" aria-label="Video formats">
                <div className={styles.head} role="row">
                  <span style={{ width: 60 }}>ID</span>
                  <span style={{ width: 110 }}>Resolution</span>
                  <span style={{ width: 50 }}>FPS</span>
                  <span style={{ width: 120 }}>Video codec</span>
                  <span style={{ width: 110 }}>Bitrate</span>
                  <span style={{ width: 80 }}>Size</span>
                  <span>Ext</span>
                </div>
                {manifest.videos.map((v: VideoFormat) => (
                  <div
                    className={`${styles.row} ${styles.rowSelectable} ${
                      selection.videoFormatId === v.formatId ? styles.rowSelected : ""
                    }`}
                    key={v.formatId}
                    role="row"
                    aria-selected={selection.videoFormatId === v.formatId}
                    onClick={() =>
                      setSelection({
                        videoFormatId:
                          selection.videoFormatId === v.formatId ? null : v.formatId,
                      })
                    }
                  >
                    <span style={{ width: 60 }}>{v.formatId}</span>
                    <span style={{ width: 110 }}>
                      {v.width && v.height ? `${v.width}×${v.height}` : "—"}
                    </span>
                    <span style={{ width: 50 }}>{v.fps ?? "—"}</span>
                    <span style={{ width: 120 }}>{v.vcodec}</span>
                    <span style={{ width: 110 }}>{formatBitrate(v.vbitrateBps)}</span>
                    <span style={{ width: 80 }}>{formatBytes(v.fileSizeBytes)}</span>
                    <span>{v.extension}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {manifest.audios.length > 0 ? (
            <>
              <Text className={styles.section}>Audio formats</Text>
              <div className={styles.table} role="table" aria-label="Audio formats">
                <div className={styles.head} role="row">
                  <span style={{ width: 60 }}>ID</span>
                  <span style={{ width: 120 }}>Codec</span>
                  <span style={{ width: 90 }}>Bitrate</span>
                  <span style={{ width: 90 }}>Sample rate</span>
                  <span style={{ width: 70 }}>Channels</span>
                  <span style={{ width: 80 }}>Size</span>
                  <span>Ext</span>
                </div>
                {manifest.audios.map((a: AudioFormat) => (
                  <div
                    className={`${styles.row} ${styles.rowSelectable} ${
                      selection.audioFormatId === a.formatId ? styles.rowSelected : ""
                    }`}
                    key={a.formatId}
                    role="row"
                    aria-selected={selection.audioFormatId === a.formatId}
                    onClick={() =>
                      setSelection({
                        audioFormatId:
                          selection.audioFormatId === a.formatId ? null : a.formatId,
                      })
                    }
                  >
                    <span style={{ width: 60 }}>{a.formatId}</span>
                    <span style={{ width: 120 }}>{a.acodec}</span>
                    <span style={{ width: 90 }}>{formatBitrate(a.abitrateBps)}</span>
                    <span style={{ width: 90 }}>
                      {a.sampleRateHz ? `${a.sampleRateHz} Hz` : "—"}
                    </span>
                    <span style={{ width: 70 }}>{a.channels ?? "—"}</span>
                    <span style={{ width: 80 }}>{formatBytes(a.fileSizeBytes)}</span>
                    <span>{a.extension}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {manifest.subtitles.length > 0 ? (
            <>
              <Text className={styles.section}>Subtitles</Text>
              <div className={styles.table} role="table" aria-label="Subtitles">
                {manifest.subtitles.slice(0, 40).map((t: SubtitleTrack) => {
                  const checked = selection.subtitles.some(
                    (s) => s.language === t.language && s.extension === t.extension,
                  );
                  return (
                    <div
                      className={`${styles.row} ${styles.rowSelectable}`}
                      key={t.formatId}
                      role="row"
                      onClick={() => toggleSubtitle(t)}
                    >
                      <Checkbox checked={checked} aria-label={`subtitle ${t.language}`} />
                      <span style={{ width: 100 }}>{t.language}</span>
                      <span style={{ width: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {t.title ?? "—"}
                      </span>
                      <span style={{ width: 50 }}>{t.extension}</span>
                      <span className={styles.meta}>
                        {t.isAutoGenerated ? "auto-generated" : "manual"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {manifest.isLive ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                This stream is live — recording live media is not supported yet.
              </MessageBarBody>
            </MessageBar>
          ) : (
            <div className={styles.downloadBar}>
              <Dropdown
                className={styles.containerPicker}
                value={selection.container === "mp4" ? "MP4" : "MKV"}
                selectedOptions={[selection.container]}
                onOptionSelect={(_, data) =>
                  setSelection({ container: (data.optionValue as "mkv" | "mp4") ?? "mkv" })
                }
              >
                <Option value="mkv" text="MKV">
                  MKV
                </Option>
                <Option value="mp4" text="MP4">
                  MP4
                </Option>
              </Dropdown>
              <Button
                appearance="primary"
                icon={<ArrowDownloadRegular />}
                disabled={!hasSelection}
                onClick={startDownload}
              >
                {hasSelection ? `Download ${selectionSummary}` : "Select formats to download"}
              </Button>
              <Text className={styles.meta}>Saving to {downloadDir}</Text>
            </div>
          )}
        </div>
      ) : null}

      {createError ? (
        <MessageBar intent="error">
          <MessageBarBody>{createError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {phase === "idle" && !manifest ? (
        <Text className={styles.note}>
          The inspector runs the bundled yt-dlp (installed under Settings → Media toolkit) inside
          the secure download core. Playlist or channel URLs are not supported yet.
        </Text>
      ) : null}

      {jobs.length > 0 ? (
        <>
          <Text size={400} weight="semibold" style={{ marginTop: "8px" }}>
            Media jobs
          </Text>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </>
      ) : null}
    </div>
  );
}
