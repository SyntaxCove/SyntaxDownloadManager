import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
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
import { useI18n } from "../i18n/context.js";
import { formatBytes, formatBitrate, formatDuration, formatNumber } from "../i18n/format.js";
import { pluralKey } from "../i18n/translate.js";
import type { AudioFormat, MediaJob, SubtitleTrack, VideoFormat } from "@syntaxdm/contracts";

/**
 * Media page — Phase 11 inspection + Phase 12 pipeline: pick a video format, an audio
 * format and/or subtitle tracks, choose the mux container, and start a persistent media
 * job (bundled yt-dlp downloads → bundled FFmpeg mux). Live manifests surface honestly:
 * recording live streams is not supported yet, so the download is disabled for them.
 * Phase 21: localized strings; the format tables are real ARIA tables with
 * keyboard-operable, focusable selection rows.
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
  rowFocusable: {
    ":focus-visible": { outline: `2px solid ${tokens.colorBrandStroke1}` },
  },
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
  jobActions: { display: "flex", gap: "4px", marginInlineStart: "auto" },
  statusBadge: {
    padding: "1px 8px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground5,
    fontSize: tokens.fontSizeBase200,
  },
});

const ACTIVE_STATUSES = new Set(["queued", "extracting", "downloading", "muxing"]);

function JobRow({ job }: { job: MediaJob }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
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
        {job.proxyProfileId ? <span className={styles.badge}>{t("media.proxyBadge")}</span> : null}
        <div className={styles.jobActions}>
          {job.status === "paused" || job.status === "failed" || job.status === "canceled" ? (
            <Tooltip content={t("media.job.resume")} relationship="label">
              <Button
                size="small"
                icon={<PlayRegular />}
                onClick={() => run(() => resume(job.id))}
              />
            </Tooltip>
          ) : null}
          {active && job.status !== "queued" ? (
            <Tooltip content={t("media.job.pause")} relationship="label">
              <Button size="small" icon={<PauseRegular />} onClick={() => run(() => pause(job.id))} />
            </Tooltip>
          ) : null}
          {active && job.status !== "queued" ? (
            <Tooltip content={t("media.job.cancel")} relationship="label">
              <Button
                size="small"
                icon={<DismissRegular />}
                onClick={() => run(() => cancel(job.id))}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={t("media.job.remove")} relationship="label">
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
          ? `${formatBytes(job.receivedBytes, t.lang)}${job.totalBytes !== null ? ` / ${formatBytes(job.totalBytes, t.lang)}` : ""}`
          : ""}
        {job.speedBps ? ` · ${formatBytes(job.speedBps, t.lang)}/s` : ""}
        {job.etaSeconds !== null ? ` · ${t("downloads.meta.eta", { eta: formatDuration(job.etaSeconds, t.lang) })}` : ""}
        {job.destinationPath ? ` · ${job.destinationPath}` : ""}
      </Text>
      {active ? (
        <ProgressBar
          value={pct ?? undefined}
          shape="rounded"
          thickness="medium"
          aria-label={t("media.job.progressAria")}
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
  const { t } = useI18n();
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
    selection.subtitles.length > 0
      ? t(pluralKey("media.count.subtitle", selection.subtitles.length), { n: formatNumber(selection.subtitles.length, t.lang) })
      : null,
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

  const toggleSubtitle = (track: SubtitleTrack) => {
    const existing = selection.subtitles;
    const key = (s: { language: string; extension: string }) =>
      `${s.language}/${s.extension}`;
    const exists = existing.some((s) => key(s) === key(track));
    setSelection({
      subtitles: exists
        ? existing.filter((s) => key(s) !== key(track))
        : [
            ...existing,
            {
              language: track.language,
              extension: track.extension,
              // The manifest marks unknown auto-generated state as null; a selection
              // needs the concrete flag yt-dlp consumes (--write-subs vs --write-auto-subs).
              isAutoGenerated: track.isAutoGenerated ?? false,
            },
          ],
    });
  };

  // Keyboard operability for selectable format rows (Enter/Space toggles).
  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, toggle: () => void): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div className={styles.page}>
      <Text as="h1" size={500} weight="semibold">
        {t("media.title")}
      </Text>

      <div className={styles.bar}>
        <Input
          className={styles.urlInput}
          placeholder={t("media.urlPlaceholder")}
          value={url}
          onChange={(_, data) => setUrl(data.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) {
              resetSelection();
              void inspect(proxyId);
            }
          }}
          disabled={busy}
          aria-label={t("media.urlAria")}
          contentAfter={busy ? <Spinner size="tiny" /> : <SearchRegular aria-hidden="true" />}
        />
        <Dropdown
          className={styles.proxyPicker}
          placeholder={t("media.directConnection")}
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
          {t("media.inspect")}
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
            {manifest.isLive ? <span className={styles.badge}>{t("media.liveBadge")}</span> : null}
            <Text className={styles.meta}>
              {formatDuration(manifest.durationSeconds, t.lang)} ·{" "}
              {t(pluralKey("media.count.video", manifest.videos.length), { n: formatNumber(manifest.videos.length, t.lang) })} ·{" "}
              {t(pluralKey("media.count.audio", manifest.audios.length), { n: formatNumber(manifest.audios.length, t.lang) })} ·{" "}
              {t(pluralKey("media.count.subtitle", manifest.subtitles.length), { n: formatNumber(manifest.subtitles.length, t.lang) })}
            </Text>
          </div>
          <Text className={styles.meta}>{manifest.webpageUrl}</Text>

          {manifest.videos.length > 0 ? (
            <>
              <Text className={styles.section}>{t("media.section.video")}</Text>
              <div className={styles.table} role="table" aria-label={t("media.table.videoAria")}>
                <div className={styles.head} role="row">
                  <span style={{ width: 60 }} role="columnheader">{t("media.col.id")}</span>
                  <span style={{ width: 110 }} role="columnheader">{t("media.col.resolution")}</span>
                  <span style={{ width: 50 }} role="columnheader">{t("media.col.fps")}</span>
                  <span style={{ width: 120 }} role="columnheader">{t("media.col.videoCodec")}</span>
                  <span style={{ width: 110 }} role="columnheader">{t("media.col.bitrate")}</span>
                  <span style={{ width: 80 }} role="columnheader">{t("media.col.size")}</span>
                  <span role="columnheader">{t("media.col.ext")}</span>
                </div>
                {manifest.videos.map((v: VideoFormat) => (
                  <div
                    className={`${styles.row} ${styles.rowSelectable} ${styles.rowFocusable} ${
                      selection.videoFormatId === v.formatId ? styles.rowSelected : ""
                    }`}
                    key={v.formatId}
                    role="row"
                    tabIndex={0}
                    aria-selected={selection.videoFormatId === v.formatId}
                    onClick={() =>
                      setSelection({
                        videoFormatId:
                          selection.videoFormatId === v.formatId ? null : v.formatId,
                      })
                    }
                    onKeyDown={(e) =>
                      onRowKeyDown(e, () =>
                        setSelection({
                          videoFormatId:
                            selection.videoFormatId === v.formatId ? null : v.formatId,
                        }),
                      )
                    }
                  >
                    <span style={{ width: 60 }} role="cell">{v.formatId}</span>
                    <span style={{ width: 110 }} role="cell">
                      {v.width && v.height ? `${v.width}×${v.height}` : "—"}
                    </span>
                    <span style={{ width: 50 }} role="cell">{v.fps ?? "—"}</span>
                    <span style={{ width: 120 }} role="cell">{v.vcodec}</span>
                    <span style={{ width: 110 }} role="cell">{formatBitrate(v.vbitrateBps, t.lang)}</span>
                    <span style={{ width: 80 }} role="cell">{formatBytes(v.fileSizeBytes, t.lang)}</span>
                    <span role="cell">{v.extension}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {manifest.audios.length > 0 ? (
            <>
              <Text className={styles.section}>{t("media.section.audio")}</Text>
              <div className={styles.table} role="table" aria-label={t("media.table.audioAria")}>
                <div className={styles.head} role="row">
                  <span style={{ width: 60 }} role="columnheader">{t("media.col.id")}</span>
                  <span style={{ width: 120 }} role="columnheader">{t("media.col.codec")}</span>
                  <span style={{ width: 90 }} role="columnheader">{t("media.col.bitrate")}</span>
                  <span style={{ width: 90 }} role="columnheader">{t("media.col.sampleRate")}</span>
                  <span style={{ width: 70 }} role="columnheader">{t("media.col.channels")}</span>
                  <span style={{ width: 80 }} role="columnheader">{t("media.col.size")}</span>
                  <span role="columnheader">{t("media.col.ext")}</span>
                </div>
                {manifest.audios.map((a: AudioFormat) => (
                  <div
                    className={`${styles.row} ${styles.rowSelectable} ${styles.rowFocusable} ${
                      selection.audioFormatId === a.formatId ? styles.rowSelected : ""
                    }`}
                    key={a.formatId}
                    role="row"
                    tabIndex={0}
                    aria-selected={selection.audioFormatId === a.formatId}
                    onClick={() =>
                      setSelection({
                        audioFormatId:
                          selection.audioFormatId === a.formatId ? null : a.formatId,
                      })
                    }
                    onKeyDown={(e) =>
                      onRowKeyDown(e, () =>
                        setSelection({
                          audioFormatId:
                            selection.audioFormatId === a.formatId ? null : a.formatId,
                        }),
                      )
                    }
                  >
                    <span style={{ width: 60 }} role="cell">{a.formatId}</span>
                    <span style={{ width: 120 }} role="cell">{a.acodec}</span>
                    <span style={{ width: 90 }} role="cell">{formatBitrate(a.abitrateBps, t.lang)}</span>
                    <span style={{ width: 90 }} role="cell">
                      {a.sampleRateHz ? `${formatNumber(a.sampleRateHz, t.lang)} Hz` : "—"}
                    </span>
                    <span style={{ width: 70 }} role="cell">{a.channels ?? "—"}</span>
                    <span style={{ width: 80 }} role="cell">{formatBytes(a.fileSizeBytes, t.lang)}</span>
                    <span role="cell">{a.extension}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {manifest.subtitles.length > 0 ? (
            <>
              <Text className={styles.section}>{t("media.section.subtitles")}</Text>
              <div className={styles.table} role="table" aria-label={t("media.table.subtitlesAria")}>
                {manifest.subtitles.slice(0, 40).map((track: SubtitleTrack) => {
                  const checked = selection.subtitles.some(
                    (s) => s.language === track.language && s.extension === track.extension,
                  );
                  return (
                    <div
                      className={styles.row}
                      key={track.formatId}
                      role="row"
                      onClick={() => toggleSubtitle(track)}
                    >
                      <Checkbox
                        checked={checked}
                        aria-label={t("media.subtitle.checkboxAria", { lang: track.language })}
                        onChange={() => toggleSubtitle(track)}
                      />
                      <span style={{ width: 100 }} role="cell">{track.language}</span>
                      <span style={{ width: 180, overflow: "hidden", textOverflow: "ellipsis" }} role="cell">
                        {track.title ?? "—"}
                      </span>
                      <span style={{ width: 50 }} role="cell">{track.extension}</span>
                      <span className={styles.meta} role="cell">
                        {track.isAutoGenerated ? t("media.subtitle.auto") : t("media.subtitle.manual")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {manifest.isLive ? (
            <MessageBar intent="warning">
              <MessageBarBody>{t("media.liveWarning")}</MessageBarBody>
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
                {hasSelection ? t("media.downloadSelected", { summary: selectionSummary }) : t("media.downloadPickFirst")}
              </Button>
              <Text className={styles.meta}>{t("common.saving", { path: downloadDir })}</Text>
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
        <Text className={styles.note}>{t("media.note")}</Text>
      ) : null}

      {jobs.length > 0 ? (
        <>
          <Text as="h2" size={400} weight="semibold" style={{ marginTop: "8px" }}>
            {t("media.section.jobs")}
          </Text>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </>
      ) : null}
    </div>
  );
}
