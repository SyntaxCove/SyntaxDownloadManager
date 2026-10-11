import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Dropdown,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { SearchRegular, VideoRegular } from "@fluentui/react-icons";
import { useMediaStore } from "../stores/media.js";
import { useProxyStore } from "../stores/proxy.js";
import { formatBytes } from "./DownloadsPage.js";
import type { AudioFormat, SubtitleTrack, VideoFormat } from "@unidm/contracts";

/**
 * Media page (Phase 11): inspect a media page URL with the bundled yt-dlp and present the
 * normalized manifest — video formats, audio formats and subtitle tracks. Selecting formats
 * and starting the download/merge pipeline is Phase 12; the page says so instead of faking it.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "960px" },
  bar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  urlInput: { flex: 1, minWidth: "260px" },
  proxyPicker: { width: "220px" },
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
  table: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    fontSize: tokens.fontSizeBase200,
  },
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

export function MediaPage(): ReactNode {
  const styles = useStyles();
  const { phase, url, manifest, error, setUrl, inspect } = useMediaStore();
  const profiles = useProxyStore((s) => s.profiles);
  const loadProxies = useProxyStore((s) => s.load);
  const [proxyId, setProxyId] = useState<string | undefined>(undefined);

  useEffect(() => {
    void loadProxies();
  }, [loadProxies]);

  const busy = phase === "inspecting";

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
            if (e.key === "Enter" && !busy) void inspect(proxyId);
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
          onClick={() => void inspect(proxyId)}
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
                  <span style={{ width: 70 }}>ID</span>
                  <span style={{ width: 110 }}>Resolution</span>
                  <span style={{ width: 50 }}>FPS</span>
                  <span style={{ width: 130 }}>Video codec</span>
                  <span style={{ width: 130 }}>Audio codec</span>
                  <span style={{ width: 90 }}>Bitrate</span>
                  <span style={{ width: 80 }}>Size</span>
                  <span>Ext</span>
                </div>
                {manifest.videos.map((v: VideoFormat) => (
                  <div className={styles.row} key={v.formatId} role="row">
                    <span style={{ width: 70 }}>{v.formatId}</span>
                    <span style={{ width: 110 }}>
                      {v.width && v.height ? `${v.width}×${v.height}` : "—"}
                    </span>
                    <span style={{ width: 50 }}>{v.fps ?? "—"}</span>
                    <span style={{ width: 130 }}>{v.vcodec}</span>
                    <span style={{ width: 130 }}>{v.acodec ?? "—"}</span>
                    <span style={{ width: 90 }}>{formatBitrate(v.vbitrateBps)}</span>
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
                  <span style={{ width: 70 }}>ID</span>
                  <span style={{ width: 130 }}>Codec</span>
                  <span style={{ width: 90 }}>Bitrate</span>
                  <span style={{ width: 90 }}>Sample rate</span>
                  <span style={{ width: 80 }}>Channels</span>
                  <span style={{ width: 80 }}>Size</span>
                  <span>Ext</span>
                </div>
                {manifest.audios.map((a: AudioFormat) => (
                  <div className={styles.row} key={a.formatId} role="row">
                    <span style={{ width: 70 }}>{a.formatId}</span>
                    <span style={{ width: 130 }}>{a.acodec}</span>
                    <span style={{ width: 90 }}>{formatBitrate(a.abitrateBps)}</span>
                    <span style={{ width: 90 }}>
                      {a.sampleRateHz ? `${a.sampleRateHz} Hz` : "—"}
                    </span>
                    <span style={{ width: 80 }}>{a.channels ?? "—"}</span>
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
                {manifest.subtitles.map((t: SubtitleTrack) => (
                  <div className={styles.row} key={t.formatId} role="row">
                    <span style={{ width: 110 }}>{t.language}</span>
                    <span style={{ width: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.title ?? "—"}
                    </span>
                    <span style={{ width: 50 }}>{t.extension}</span>
                    <span className={styles.meta}>
                      {t.isAutoGenerated ? "auto-generated" : "manual"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <Text className={styles.note}>
            Downloading and merging the selected formats arrives with the media pipeline phase —
            this page inspects only.
          </Text>
        </div>
      ) : null}

      {phase === "idle" && !manifest ? (
        <Text className={styles.note}>
          The inspector runs the bundled yt-dlp (installed under Settings → Media toolkit) inside
          the secure download core. Playlist or channel URLs are not supported yet.
        </Text>
      ) : null}
    </div>
  );
}
