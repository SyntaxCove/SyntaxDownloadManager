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
import { useI18n } from "../i18n/context.js";
import { formatBytes, formatEta, formatNumber } from "../i18n/format.js";
import { pluralKey } from "../i18n/translate.js";
import type { DownloadJob, QueueDirection } from "@syntaxdm/contracts";

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
  actions: { display: "flex", gap: "4px", marginInlineStart: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
});

export function DownloadsPage(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
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

  const banner: Partial<Record<CoreStatus, string>> = {
    starting: t("downloads.banner.starting"),
    restarting: t("downloads.banner.restarting"),
    unavailable: t("downloads.banner.unavailable"),
  };

  return (
    <div className={styles.page}>
      {banner[core] ? (
        <MessageBar intent={core === "unavailable" ? "error" : "info"}>
          <MessageBarBody>{banner[core]}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.form}>
        <Input
          value={url}
          onChange={(_, data) => setUrl(data.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={t("downloads.urlPlaceholder")}
          style={{ flex: 1 }}
          aria-label={t("downloads.urlAria")}
        />
        <Dropdown
          value={
            proxyChoice === undefined
              ? t("common.appDefault")
              : proxyChoice === null
                ? t("common.direct")
                : (proxyProfiles.find((p) => p.id === proxyChoice)?.name ?? t("common.proxy"))
          }
          selectedOptions={[proxyChoice === undefined ? "__default" : proxyChoice === null ? "__direct" : proxyChoice]}
          onOptionSelect={(_, d) =>
            setProxyChoice(
              d.optionValue === "__default" ? undefined : d.optionValue === "__direct" ? null : (d.optionValue as string),
            )
          }
          style={{ minWidth: "150px" }}
          aria-label={t("downloads.proxyChoiceAria")}
        >
          <Option value="__default">{t("common.appDefault")}</Option>
          <Option value="__direct">{t("common.direct")}</Option>
          {proxyProfiles.map((p) => (
            <Option key={p.id} value={p.id}>
              {p.name}
            </Option>
          ))}
        </Dropdown>
        <Button appearance="primary" icon={<AddRegular />} onClick={submit} disabled={core !== "ready"}>
          {t("downloads.create")}
        </Button>
      </div>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.row}>
        <Text className={styles.meta}>{t("common.saving", { path: downloadDir })}</Text>
        <div className={styles.actions}>
          <Button
            appearance="subtle"
            size="small"
            icon={<PlayRegular />}
            disabled={!hasPaused}
            onClick={() => startAll().catch((e) => setError(String(e?.message ?? e)))}
            aria-label={t("downloads.startAllAria")}
          >
            {t("downloads.startAll")}
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<PauseRegular />}
            disabled={!hasPausable}
            onClick={() => pauseAll().catch((e) => setError(String(e?.message ?? e)))}
            aria-label={t("downloads.pauseAllAria")}
          >
            {t("downloads.pauseAll")}
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
          <Spinner size="tiny" /> {t("downloads.empty")}
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
  const { t } = useI18n();
  const { job } = props;
  const active = job.status === "downloading" || job.status === "probing" || job.status === "queued";
  const finished = job.status === "completed";
  const progress = job.totalBytes ? Math.min(1, job.receivedBytes / job.totalBytes) : undefined;
  const failedOrStopped = job.status === "failed" || job.status === "canceled";
  const hintKey =
    job.status === "failed" || job.errorCode === "proxy_profile_not_found"
      ? job.errorCode !== null && job.errorCode !== undefined
        ? HINT_KEYS[job.errorCode]
        : undefined
      : undefined;
  const hint = typeof hintKey === "string" ? t(hintKey) : undefined;
  const inQueue = job.status === "queued";
  const statusKey: string | undefined = STATUS_KEYS[job.status];
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacementUrl, setReplacementUrl] = useState("");
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitKbps, setLimitKbps] = useState(String(job.speedLimitKBps ?? 0));
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyPick, setProxyPick] = useState<string | null>(job.proxyProfileId);
  const proxyProfiles = useProxyStore((s) => s.profiles);
  const proxyName = job.proxyProfileId
    ? (proxyProfiles.find((p) => p.id === job.proxyProfileId)?.name ?? t("common.unavailable"))
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
        <Text className={styles.meta}>{statusKey ? t(statusKey) : job.status}</Text>
        {inQueue && job.queuePosition !== null ? (
          <Text className={styles.meta} title={t("downloads.queuePositionTitle")}>
            #{formatNumber((job.queuePosition ?? 0) + 1, t.lang)}
          </Text>
        ) : null}
        <div className={styles.actions}>
          {inQueue ? (
            <>
              <Button appearance="subtle" size="small" icon={<CaretUpRegular />} onClick={() => props.onQueueMove("up")} aria-label={t("downloads.moveUp")} title={t("downloads.moveUpTitle")} />
              <Button appearance="subtle" size="small" icon={<CaretDownRegular />} onClick={() => props.onQueueMove("down")} aria-label={t("downloads.moveDown")} title={t("downloads.moveDownTitle")} />
            </>
          ) : null}
          {active ? (
            <Button appearance="subtle" size="small" icon={<PauseRegular />} onClick={props.onPause} aria-label={t("downloads.pause")} />
          ) : null}
          {job.status === "paused" ? (
            <Button appearance="subtle" size="small" icon={<PlayRegular />} onClick={props.onResume} aria-label={t("downloads.resume")} />
          ) : null}
          {active ? (
            <Button appearance="subtle" size="small" icon={<StopRegular />} onClick={props.onCancel} aria-label={t("downloads.cancel")} />
          ) : null}
          {failedOrStopped ? (
            <Button appearance="subtle" size="small" icon={<ArrowClockwiseRegular />} onClick={props.onRetry} aria-label={t("common.retry")} />
          ) : null}
          {failedOrStopped || job.status === "paused" ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowRepeatAllRegular />}
              onClick={props.onRecover}
              aria-label={t("downloads.recover")}
              title={t("downloads.recoverTitle")}
            />
          ) : null}
          {failedOrStopped || job.status === "paused" ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<LinkEditRegular />}
              onClick={() => setReplaceOpen(true)}
              aria-label={t("downloads.replaceUrl")}
              title={t("downloads.replaceUrlTitle")}
            />
          ) : null}
          {finished || failedOrStopped ? (
            <Button appearance="subtle" size="small" icon={<DeleteRegular />} onClick={props.onRemove} aria-label={t("common.remove")} />
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
              aria-label={t("downloads.speedLimit")}
              title={t("downloads.speedLimitTitle")}
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
              aria-label={t("common.proxy")}
              title={t("downloads.proxyTitle")}
            />
          ) : null}
        </div>
      </div>
      <ProgressBar value={progress} shape="rounded" aria-label={t("downloads.progressAria")} />
      <div className={styles.row}>
        <Text className={styles.meta}>
          {formatBytes(job.receivedBytes, t.lang)} / {formatBytes(job.totalBytes, t.lang)}
        </Text>
        {job.status === "downloading" ? (
          <>
            <Text className={styles.meta}>· {formatBytes(job.speedBps, t.lang)}/s</Text>
            <Text className={styles.meta}>· {t("downloads.meta.eta", { eta: formatEta(job.etaSeconds, t.lang) })}</Text>
          </>
        ) : null}
        {job.segmentCount && job.segmentCount > 1 && job.status === "downloading" ? (
          <Text className={styles.meta} title={t("downloads.meta.connectionsTitle")}>
            · <PlugConnectedRegular style={{ verticalAlign: -2 }} /> {t(pluralKey("downloads.meta.connections", job.segmentCount), { n: formatNumber(job.segmentCount, t.lang) })}
          </Text>
        ) : null}
        {job.recoveryCount && job.recoveryCount > 0 ? (
          <Text className={styles.meta} title={t("downloads.meta.recoveredTitle")}>
            · <ArrowRepeatAllRegular style={{ verticalAlign: -2 }} /> {t("downloads.meta.recovered", { n: formatNumber(job.recoveryCount, t.lang) })}
          </Text>
        ) : null}
        {job.checksumVerified === true ? (
          <Text className={styles.meta} title={t("downloads.meta.checksumOkTitle", { hash: job.checksumActual ?? "" })}>
            · <ShieldCheckmarkRegular style={{ verticalAlign: -2, color: tokens.colorPaletteGreenForeground1 }} /> {t("downloads.meta.checksumOk")}
          </Text>
        ) : null}
        {job.checksumVerified === false ? (
          <Text className={styles.meta} title={t("downloads.meta.checksumBadTitle", { expected: job.checksumExpected ?? "", actual: job.checksumActual ?? "" })}>
            · <ShieldErrorRegular style={{ verticalAlign: -2, color: tokens.colorPaletteRedForeground1 }} /> {t("downloads.meta.checksumBad")}
          </Text>
        ) : null}
        {job.speedLimitKBps ? (
          <Text className={styles.meta} title={t("downloads.meta.cappedTitle")}>
            · <TopSpeedRegular style={{ verticalAlign: -2 }} /> {t("downloads.meta.capped", { n: formatNumber(job.speedLimitKBps, t.lang) })}
          </Text>
        ) : null}
        {proxyName ? (
          <Text className={styles.meta} title={t("downloads.meta.proxyDesc")}>
            · <GlobeShieldRegular style={{ verticalAlign: -2 }} /> {t("downloads.meta.proxyLabel", { name: proxyName })}
          </Text>
        ) : null}
        {job.errorCode ? <Text className={styles.meta}>· {t("downloads.meta.errorLabel", { code: job.errorCode })}</Text> : null}
      </div>
      {hint ? <Text className={styles.meta}>{hint}</Text> : null}

      <Dialog open={proxyOpen} onOpenChange={(_, d) => setProxyOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("downloads.proxyDialog.title")}</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                {t("downloads.proxyDialog.body")}
              </Text>
              <Dropdown
                value={proxyPick ? (proxyProfiles.find((p) => p.id === proxyPick)?.name ?? t("common.proxy")) : t("common.direct")}
                selectedOptions={proxyPick ? [proxyPick] : []}
                onOptionSelect={(_, d) => setProxyPick((d.optionValue as string) || null)}
                style={{ width: "240px", marginTop: "8px" }}
                aria-label={t("downloads.proxyDialog.profileAria")}
              >
                <Option value="">{t("common.direct")}</Option>
                {proxyProfiles.map((p) => (
                  <Option key={p.id} value={p.id}>
                    {p.name}
                  </Option>
                ))}
              </Dropdown>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setProxyOpen(false)}>{t("common.cancel")}</Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setProxyOpen(false);
                  props.onSetProxy(proxyPick);
                }}
              >
                {t("common.apply")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={replaceOpen} onOpenChange={(_, d) => setReplaceOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("downloads.replaceDialog.title")}</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                {t("downloads.replaceDialog.body")}
              </Text>
              <Input
                value={replacementUrl}
                onChange={(_, data) => setReplacementUrl(data.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitReplace();
                }}
                placeholder="https://…"
                style={{ width: "100%", marginTop: "8px" }}
                aria-label={t("downloads.replaceDialog.urlAria")}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setReplaceOpen(false)}>{t("common.cancel")}</Button>
              <Button appearance="primary" disabled={!replacementUrl.trim()} onClick={submitReplace}>
                {t("downloads.replaceDialog.action")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={limitOpen} onOpenChange={(_, d) => setLimitOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("downloads.limitDialog.title")}</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                {t("downloads.limitDialog.body")}
              </Text>
              <Input
                value={limitKbps}
                onChange={(_, data) => setLimitKbps(data.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitLimit();
                }}
                inputMode="numeric"
                style={{ width: "160px", marginTop: "8px" }}
                aria-label={t("downloads.limitDialog.inputAria")}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setLimitOpen(false)}>{t("common.cancel")}</Button>
              <Button appearance="primary" onClick={submitLimit}>{t("common.apply")}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

const STATUS_KEYS: Record<string, string> = {
  queued: "downloads.status.queued",
  probing: "downloads.status.probing",
  downloading: "downloads.status.downloading",
  paused: "downloads.status.paused",
  completed: "downloads.status.completed",
  failed: "downloads.status.failed",
  canceled: "downloads.status.canceled",
};

const HINT_KEYS: Record<string, string> = {
  source_gone: "downloads.hint.source_gone",
  source_forbidden: "downloads.hint.source_forbidden",
  source_changed: "downloads.hint.source_changed",
  network_error: "downloads.hint.network_error",
  http_error: "downloads.hint.http_error",
  proxy_profile_not_found: "downloads.hint.proxy_profile_not_found",
};
