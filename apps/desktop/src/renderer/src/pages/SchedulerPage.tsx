import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  Checkbox,
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
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  DeleteRegular,
  EditRegular,
  PlayRegular,
} from "@fluentui/react-icons";
import { useSchedulerStore, epochMsToLocalInput, type SchedulerActionChoice } from "../stores/scheduler.js";
import { useSettingsStore } from "../stores/settings.js";
import { useProxyStore } from "../stores/proxy.js";
import { useI18n } from "../i18n/context.js";
import { formatDateTime } from "../i18n/format.js";
import type { SchedulerJob } from "@syntaxdm/contracts";

/**
 * Scheduler page (Phase 15): persistent automation jobs fired by the core's 1 s tick.
 * The renderer only edits rows — every fire time is computed and recorded by the core.
 * Catch-up semantics are stated honestly: a job whose time passed while the app was
 * closed runs at the next opportunity. Phase 21: localized strings (dates render in the
 * interface language — Persian resolves to the Jalali calendar via Intl).
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "900px" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  name: { fontWeight: tokens.fontWeightSemibold, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  bad: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: "flex", gap: "4px", marginInlineStart: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
  field: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" },
});

const ACTION_KEYS: Record<SchedulerActionChoice, string> = {
  "download.create": "scheduler.action.download.create",
  "download.startAll": "scheduler.action.download.startAll",
  "download.pauseAll": "scheduler.action.download.pauseAll",
  "media.download": "scheduler.action.media.download",
  "torrent.add": "scheduler.action.torrent.add",
};

interface FormState {
  kind: SchedulerActionChoice;
  url: string;
  destinationDir: string;
  videoFormatId: string;
  audioFormatId: string;
  magnetUri: string;
  /** Proxy for scheduled `download.create` payloads: null = direct (frozen at save time —
   *  scheduler payloads bypass main's app-default injection by design, Phase 15/16). */
  proxyProfileId: string | null;
  startLocal: string;
  repeat: "none" | "daily" | "weekly";
  enabled: boolean;
}

export function SchedulerPage(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const jobs = useSchedulerStore((s) => s.jobs);
  const loaded = useSchedulerStore((s) => s.jobsLoaded);
  const loadJobs = useSchedulerStore((s) => s.loadJobs);
  const storeError = useSchedulerStore((s) => s.error);
  const createJob = useSchedulerStore((s) => s.createJob);
  const updateJob = useSchedulerStore((s) => s.updateJob);
  const removeJob = useSchedulerStore((s) => s.removeJob);
  const runNow = useSchedulerStore((s) => s.runNow);
  const setEnabledLocal = useSchedulerStore((s) => s.setEnabledLocal);
  const downloadDir = useSettingsStore((s) => s.settings?.downloadDir ?? "");
  const proxyProfiles = useProxyStore((s) => s.profiles);
  const loadProxies = useProxyStore((s) => s.load);
  const proxyLoaded = useProxyStore((s) => s.loaded);

  const [pageError, setPageError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SchedulerJob | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    if (!loaded) void loadJobs().catch((e) => setPageError(String(e?.message ?? e)));
  }, [loaded, loadJobs]);
  useEffect(() => {
    if (!proxyLoaded) void loadProxies().catch(() => undefined);
  }, [proxyLoaded, loadProxies]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      kind: "download.create",
      url: "",
      destinationDir: downloadDir,
      videoFormatId: "",
      audioFormatId: "",
      magnetUri: "",
      proxyProfileId: null, // privacy-safe: a scheduled download is never proxied silently
      startLocal: epochMsToLocalInput(Date.now() + 60 * 60 * 1000),
      repeat: "none",
      enabled: true,
    });
    setEditorOpen(true);
  };

  const openEdit = (job: SchedulerJob) => {
    const p = job.payload as Record<string, unknown>;
    setEditing(job);
    setForm({
      kind: job.kind,
      url: typeof p.url === "string" ? p.url : "",
      destinationDir: typeof p.destinationDir === "string" ? p.destinationDir : downloadDir,
      videoFormatId: typeof p.videoFormatId === "string" ? p.videoFormatId : "",
      audioFormatId: typeof p.audioFormatId === "string" ? p.audioFormatId : "",
      magnetUri: typeof p.magnetUri === "string" ? p.magnetUri : "",
      proxyProfileId: typeof p.proxyProfileId === "string" ? p.proxyProfileId : null,
      startLocal: epochMsToLocalInput(job.startAt),
      repeat: job.repeat,
      enabled: job.enabled,
    });
    setEditorOpen(true);
  };

  const buildPayload = (f: FormState): Record<string, unknown> | string => {
    switch (f.kind) {
      case "download.create": {
        if (!f.url.trim()) return t("scheduler.error.urlRequired");
        const payload: Record<string, unknown> = { url: f.url.trim(), destinationDir: f.destinationDir };
        // Frozen at save time: scheduler payloads bypass main's app-default injection.
        if (f.proxyProfileId) payload.proxyProfileId = f.proxyProfileId;
        return payload;
      }
      case "media.download": {
        if (!f.url.trim()) return t("scheduler.error.pageUrlRequired");
        if (!f.videoFormatId.trim() && !f.audioFormatId.trim())
          return t("scheduler.error.formatRequired");
        const payload: Record<string, unknown> = { url: f.url.trim(), destinationDir: f.destinationDir };
        if (f.videoFormatId.trim()) payload.videoFormatId = f.videoFormatId.trim();
        if (f.audioFormatId.trim()) payload.audioFormatId = f.audioFormatId.trim();
        return payload;
      }
      case "torrent.add": {
        if (!f.magnetUri.trim()) return t("scheduler.error.magnetRequired");
        return { magnetUri: f.magnetUri.trim(), destinationDir: f.destinationDir };
      }
      default:
        return {};
    }
  };

  const submit = async (): Promise<void> => {
    if (!form) return;
    const payload = buildPayload(form);
    if (typeof payload === "string") {
      setPageError(payload);
      return;
    }
    if (editing) {
      const startAt = new Date(form.startLocal).getTime();
      if (!Number.isFinite(startAt)) {
        setPageError(t("scheduler.error.startRequired"));
        return;
      }
      await updateJob(editing.id, {
        startAt,
        repeat: form.repeat,
        enabled: form.enabled,
        payload,
      });
    } else {
      const ok = await createJob({
        kind: form.kind,
        payload,
        startLocal: form.startLocal,
        repeat: form.repeat,
        enabled: form.enabled,
      });
      if (!ok) return;
    }
    setEditorOpen(false);
    setForm(null);
    setEditing(null);
  };

  const toggle = useMemo(
    () => async (job: SchedulerJob, enabled: boolean) => {
      setEnabledLocal(job.id, enabled); // optimistic; the snapshot event confirms
      await updateJob(job.id, { enabled });
    },
    [setEnabledLocal, updateJob],
  );

  const describePayload = (job: SchedulerJob): string => {
    const p = job.payload as Record<string, unknown>;
    switch (job.kind) {
      case "download.create":
        return typeof p.url === "string" ? p.url : "—";
      case "media.download":
        return typeof p.url === "string" ? p.url : "—";
      case "torrent.add":
        return typeof p.magnetUri === "string"
          ? p.magnetUri.slice(0, 72)
          : t("scheduler.payload.torrentFile");
      default:
        return t("scheduler.payload.queueWide");
    }
  };

  const formatWhen = (epoch: number | null): string =>
    epoch === null ? t("scheduler.when.none") : formatDateTime(epoch, t.lang);

  const repeatLabel = (repeat: "none" | "daily" | "weekly"): string =>
    repeat === "none" ? t("scheduler.repeat.none") : repeat === "daily" ? t("scheduler.repeat.daily") : t("scheduler.repeat.weekly");

  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <Text as="h1" weight="semibold" size={500}>
          {t("scheduler.title")}
        </Text>
        <div className={styles.actions}>
          <Button appearance="primary" icon={<AddRegular />} onClick={openCreate}>
            {t("scheduler.newJob")}
          </Button>
        </div>
      </div>
      <Text className={styles.meta}>{t("scheduler.intro")}</Text>
      {pageError || storeError ? (
        <MessageBar intent="error">
          <MessageBarBody>{pageError ?? storeError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? <Spinner label={t("scheduler.loading")} /> : null}

      {loaded && jobs.length === 0 ? (
        <Text className={styles.empty}>{t("scheduler.empty")}</Text>
      ) : null}

      {jobs.map((job) => (
        <div key={job.id} className={styles.card}>
          <div className={styles.row}>
            <Switch
              checked={job.enabled}
              onChange={(_e, data) => void toggle(job, data.checked)}
              aria-label={t("scheduler.enableAria", { kind: t(ACTION_KEYS[job.kind]) })}
            />
            <Text className={styles.name}>{t(ACTION_KEYS[job.kind])}</Text>
            <div className={styles.actions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<PlayRegular />}
                title={t("scheduler.runNowTitle")}
                onClick={() => void runNow(job.id).catch((e) => setPageError(String(e?.message ?? e)))}
              >
                {t("scheduler.runNow")}
              </Button>
              <Button
                appearance="subtle"
                size="small"
                icon={<EditRegular />}
                onClick={() => openEdit(job)}
              >
                {t("scheduler.edit")}
              </Button>
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                onClick={() => void removeJob(job.id).catch((e) => setPageError(String(e?.message ?? e)))}
              >
                {t("common.remove")}
              </Button>
            </div>
          </div>
          <Text className={styles.meta} title={describePayload(job)}>
            {describePayload(job)}
          </Text>
          <div className={styles.row}>
            <Text className={styles.meta}>
              {repeatLabel(job.repeat)}{" "}
              {"· "}
              {t("scheduler.anchorNext", { anchor: formatWhen(job.startAt), next: formatWhen(job.nextRunAt) })}
            </Text>
          </div>
          {job.lastFiredAt !== null ? (
            <Text className={`${styles.meta} ${job.lastResultCode === "ok" ? styles.ok : styles.bad}`}>
              {job.lastResultMessage
                ? t("scheduler.lastRunWithMsg", {
                    when: formatWhen(job.lastFiredAt),
                    code: job.lastResultCode ?? "",
                    message: job.lastResultMessage,
                  })
                : t("scheduler.lastRun", { when: formatWhen(job.lastFiredAt), code: job.lastResultCode ?? "" })}
            </Text>
          ) : (
            <Text className={styles.meta}>{t("scheduler.neverFired")}</Text>
          )}
        </div>
      ))}

      <Dialog open={editorOpen} onOpenChange={(_e, d) => setEditorOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? t("scheduler.dialog.editTitle") : t("scheduler.dialog.createTitle")}</DialogTitle>
            <DialogContent>
              {form ? (
                <>
                  <div className={styles.field}>
                    <Text id="scheduler-action-label">{t("scheduler.dialog.action")}</Text>
                    <Dropdown
                      value={t(ACTION_KEYS[form.kind])}
                      disabled={editing !== null}
                      aria-labelledby="scheduler-action-label"
                      onOptionSelect={(_e, d) => {
                        if (typeof d.optionValue === "string") {
                          setForm({ ...form, kind: d.optionValue as SchedulerActionChoice });
                        }
                      }}
                    >
                      {(Object.keys(ACTION_KEYS) as SchedulerActionChoice[]).map((k) => (
                        <Option key={k} value={k} text={t(ACTION_KEYS[k])}>
                          {t(ACTION_KEYS[k])}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>

                  {form.kind === "download.create" || form.kind === "media.download" ? (
                    <div className={styles.field}>
                      <Text id="scheduler-url-label">{form.kind === "media.download" ? t("scheduler.dialog.pageUrl") : t("scheduler.dialog.url")}</Text>
                      <Input
                        value={form.url}
                        onChange={(_e, d) => setForm({ ...form, url: d.value })}
                        placeholder="https://…"
                        aria-labelledby="scheduler-url-label"
                      />
                    </div>
                  ) : null}

                  {form.kind === "media.download" ? (
                    <div className={styles.grid2}>
                      <div className={styles.field}>
                        <Text id="scheduler-video-label">{t("scheduler.dialog.videoFormatId")}</Text>
                        <Input
                          value={form.videoFormatId}
                          onChange={(_e, d) => setForm({ ...form, videoFormatId: d.value })}
                          placeholder={t("scheduler.dialog.videoFormatIdPlaceholder")}
                          aria-labelledby="scheduler-video-label"
                        />
                      </div>
                      <div className={styles.field}>
                        <Text id="scheduler-audio-label">{t("scheduler.dialog.audioFormatId")}</Text>
                        <Input
                          value={form.audioFormatId}
                          onChange={(_e, d) => setForm({ ...form, audioFormatId: d.value })}
                          placeholder={t("scheduler.dialog.audioFormatIdPlaceholder")}
                          aria-labelledby="scheduler-audio-label"
                        />
                      </div>
                    </div>
                  ) : null}

                  {form.kind === "torrent.add" ? (
                    <div className={styles.field}>
                      <Text id="scheduler-magnet-label">{t("scheduler.dialog.magnetUri")}</Text>
                      <Input
                        value={form.magnetUri}
                        onChange={(_e, d) => setForm({ ...form, magnetUri: d.value })}
                        placeholder="magnet:?xt=…"
                        aria-labelledby="scheduler-magnet-label"
                      />
                    </div>
                  ) : null}

                  {form.kind !== "download.startAll" && form.kind !== "download.pauseAll" ? (
                    <div className={styles.field}>
                      <Text id="scheduler-dest-label">{t("scheduler.dialog.destinationDir")}</Text>
                      <Input
                        value={form.destinationDir}
                        onChange={(_e, d) => setForm({ ...form, destinationDir: d.value })}
                        aria-labelledby="scheduler-dest-label"
                      />
                    </div>
                  ) : null}

                  {form.kind === "download.create" ? (
                    <div className={styles.field}>
                      <Text id="scheduler-proxy-label">{t("scheduler.dialog.proxyFrozen")}</Text>
                      <Dropdown
                        value={
                          form.proxyProfileId
                            ? (proxyProfiles.find((p) => p.id === form.proxyProfileId)?.name ?? t("scheduler.dialog.unavailableProfile"))
                            : t("common.direct")
                        }
                        selectedOptions={form.proxyProfileId ? [form.proxyProfileId] : ["__direct"]}
                        aria-labelledby="scheduler-proxy-label"
                        onOptionSelect={(_e, d) =>
                          setForm({
                            ...form,
                            proxyProfileId: d.optionValue === "__direct" ? null : (d.optionValue as string),
                          })
                        }
                      >
                        <Option value="__direct">{t("common.directNoProxy")}</Option>
                        {proxyProfiles.map((p) => (
                          <Option key={p.id} value={p.id}>
                            {p.name}
                          </Option>
                        ))}
                      </Dropdown>
                    </div>
                  ) : null}

                  <div className={styles.grid2}>
                    <div className={styles.field}>
                      <Text id="scheduler-start-label">{t("scheduler.dialog.start")}</Text>
                      <Input
                        type="datetime-local"
                        value={form.startLocal}
                        onChange={(_e, d) => setForm({ ...form, startLocal: d.value })}
                        aria-labelledby="scheduler-start-label"
                      />
                    </div>
                    <div className={styles.field}>
                      <Text id="scheduler-repeat-label">{t("scheduler.dialog.repeat")}</Text>
                      <Dropdown
                        value={
                          form.repeat === "none"
                            ? t("scheduler.dialog.repeat.none")
                            : form.repeat === "daily"
                              ? t("scheduler.dialog.repeat.daily")
                              : t("scheduler.dialog.repeat.weekly")
                        }
                        aria-labelledby="scheduler-repeat-label"
                        onOptionSelect={(_e, d) => {
                          if (d.optionValue === "none" || d.optionValue === "daily" || d.optionValue === "weekly") {
                            setForm({ ...form, repeat: d.optionValue });
                          }
                        }}
                      >
                        <Option value="none" text={t("scheduler.dialog.repeat.none")}>{t("scheduler.dialog.repeat.none")}</Option>
                        <Option value="daily" text={t("scheduler.dialog.repeat.daily")}>{t("scheduler.dialog.repeat.daily")}</Option>
                        <Option value="weekly" text={t("scheduler.dialog.repeat.weekly")}>{t("scheduler.dialog.repeat.weekly")}</Option>
                      </Dropdown>
                    </div>
                  </div>

                  <div className={styles.field}>
                    <Checkbox
                      label={t("scheduler.dialog.enabled")}
                      checked={form.enabled}
                      onChange={(_e, d) => setForm({ ...form, enabled: d.checked === true })}
                    />
                  </div>
                  <Text className={styles.meta}>{t("scheduler.dialog.hint")}</Text>
                </>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                icon={<ArrowClockwiseRegular />}
                onClick={() => setEditorOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button appearance="primary" onClick={() => void submit()}>
                {editing ? t("scheduler.dialog.save") : t("scheduler.dialog.create")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
