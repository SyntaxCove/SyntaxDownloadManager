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
import type { SchedulerJob } from "@syntaxdm/contracts";

/**
 * Scheduler page (Phase 15): persistent automation jobs fired by the core's 1 s tick.
 * The renderer only edits rows — every fire time is computed and recorded by the core.
 * Catch-up semantics are stated honestly: a job whose time passed while the app was
 * closed runs at the next opportunity.
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
  actions: { display: "flex", gap: "4px", marginLeft: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
  field: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" },
});

const ACTION_LABELS: Record<SchedulerActionChoice, string> = {
  "download.create": "Download a file (URL)",
  "download.startAll": "Start all paused downloads",
  "download.pauseAll": "Pause all active downloads",
  "media.download": "Download media (page URL)",
  "torrent.add": "Add torrent / magnet",
};

function describePayload(job: SchedulerJob): string {
  const p = job.payload as Record<string, unknown>;
  switch (job.kind) {
    case "download.create":
      return typeof p.url === "string" ? p.url : "—";
    case "media.download":
      return typeof p.url === "string" ? p.url : "—";
    case "torrent.add":
      return typeof p.magnetUri === "string"
        ? p.magnetUri.slice(0, 72)
        : "torrent file";
    default:
      return "queue-wide action";
  }
}

function formatWhen(epoch: number | null): string {
  if (epoch === null) return "nothing scheduled";
  return new Date(epoch).toLocaleString();
}

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
        if (!f.url.trim()) return "a URL is required";
        const payload: Record<string, unknown> = { url: f.url.trim(), destinationDir: f.destinationDir };
        // Frozen at save time: scheduler payloads bypass main's app-default injection.
        if (f.proxyProfileId) payload.proxyProfileId = f.proxyProfileId;
        return payload;
      }
      case "media.download": {
        if (!f.url.trim()) return "a page URL is required";
        if (!f.videoFormatId.trim() && !f.audioFormatId.trim())
          return "select at least one of video/audio format ids";
        const payload: Record<string, unknown> = { url: f.url.trim(), destinationDir: f.destinationDir };
        if (f.videoFormatId.trim()) payload.videoFormatId = f.videoFormatId.trim();
        if (f.audioFormatId.trim()) payload.audioFormatId = f.audioFormatId.trim();
        return payload;
      }
      case "torrent.add": {
        if (!f.magnetUri.trim()) return "a magnet URI is required";
        return { magnetUri: f.magnetUri.trim(), destinationDir: f.destinationDir };
      }
      default:
        return {};
    }
  };

  const submit = async () => {
    if (!form) return;
    const payload = buildPayload(form);
    if (typeof payload === "string") {
      setPageError(payload);
      return;
    }
    if (editing) {
      const startAt = new Date(form.startLocal).getTime();
      if (!Number.isFinite(startAt)) {
        setPageError("pick a start date and time");
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

  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <Text weight="semibold">Scheduled jobs</Text>
        <div className={styles.actions}>
          <Button appearance="primary" icon={<AddRegular />} onClick={openCreate}>
            New job
          </Button>
        </div>
      </div>
      <Text className={styles.meta}>
        Automation runs inside the download engine and survives restarts. Repeating jobs
        keep their local time across daylight-saving changes; a job missed while the app
        was closed runs at the next opportunity.
      </Text>
      {pageError || storeError ? (
        <MessageBar intent="error">
          <MessageBarBody>{pageError ?? storeError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {!loaded ? <Spinner label="Loading schedules" /> : null}

      {loaded && jobs.length === 0 ? (
        <Text className={styles.empty}>No scheduled jobs yet.</Text>
      ) : null}

      {jobs.map((job) => (
        <div key={job.id} className={styles.card}>
          <div className={styles.row}>
            <Switch
              checked={job.enabled}
              onChange={(_e, data) => void toggle(job, data.checked)}
              aria-label={`Enable ${job.kind}`}
            />
            <Text className={styles.name}>{ACTION_LABELS[job.kind]}</Text>
            <div className={styles.actions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<PlayRegular />}
                title="Run now (does not change the schedule)"
                onClick={() => void runNow(job.id).catch((e) => setPageError(String(e?.message ?? e)))}
              >
                Run now
              </Button>
              <Button
                appearance="subtle"
                size="small"
                icon={<EditRegular />}
                onClick={() => openEdit(job)}
              >
                Edit
              </Button>
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                onClick={() => void removeJob(job.id).catch((e) => setPageError(String(e?.message ?? e)))}
              >
                Remove
              </Button>
            </div>
          </div>
          <Text className={styles.meta} title={describePayload(job)}>
            {describePayload(job)}
          </Text>
          <div className={styles.row}>
            <Text className={styles.meta}>
              {job.repeat === "none"
                ? "one-shot"
                : job.repeat === "daily"
                  ? "daily"
                  : "weekly"}{" "}
              · anchor {formatWhen(job.startAt)} · next {formatWhen(job.nextRunAt)}
            </Text>
          </div>
          {job.lastFiredAt !== null ? (
            <Text className={`${styles.meta} ${job.lastResultCode === "ok" ? styles.ok : styles.bad}`}>
              last run {formatWhen(job.lastFiredAt)} — {job.lastResultCode}
              {job.lastResultMessage ? `: ${job.lastResultMessage}` : ""}
            </Text>
          ) : (
            <Text className={styles.meta}>never fired</Text>
          )}
        </div>
      ))}

      <Dialog open={editorOpen} onOpenChange={(_e, d) => setEditorOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? "Edit scheduled job" : "New scheduled job"}</DialogTitle>
            <DialogContent>
              {form ? (
                <>
                  <div className={styles.field}>
                    <Text>Action</Text>
                    <Dropdown
                      value={ACTION_LABELS[form.kind]}
                      disabled={editing !== null}
                      onOptionSelect={(_e, d) => {
                        if (typeof d.optionValue === "string") {
                          setForm({ ...form, kind: d.optionValue as SchedulerActionChoice });
                        }
                      }}
                    >
                      {(Object.keys(ACTION_LABELS) as SchedulerActionChoice[]).map((k) => (
                        <Option key={k} value={k} text={ACTION_LABELS[k]}>
                          {ACTION_LABELS[k]}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>

                  {form.kind === "download.create" || form.kind === "media.download" ? (
                    <div className={styles.field}>
                      <Text>{form.kind === "media.download" ? "Page URL" : "URL"}</Text>
                      <Input
                        value={form.url}
                        onChange={(_e, d) => setForm({ ...form, url: d.value })}
                        placeholder="https://…"
                      />
                    </div>
                  ) : null}

                  {form.kind === "media.download" ? (
                    <div className={styles.grid2}>
                      <div className={styles.field}>
                        <Text>Video format id (optional)</Text>
                        <Input
                          value={form.videoFormatId}
                          onChange={(_e, d) => setForm({ ...form, videoFormatId: d.value })}
                          placeholder="e.g. 137"
                        />
                      </div>
                      <div className={styles.field}>
                        <Text>Audio format id (optional)</Text>
                        <Input
                          value={form.audioFormatId}
                          onChange={(_e, d) => setForm({ ...form, audioFormatId: d.value })}
                          placeholder="e.g. 140"
                        />
                      </div>
                    </div>
                  ) : null}

                  {form.kind === "torrent.add" ? (
                    <div className={styles.field}>
                      <Text>Magnet URI</Text>
                      <Input
                        value={form.magnetUri}
                        onChange={(_e, d) => setForm({ ...form, magnetUri: d.value })}
                        placeholder="magnet:?xt=…"
                      />
                    </div>
                  ) : null}

                  {form.kind !== "download.startAll" && form.kind !== "download.pauseAll" ? (
                    <div className={styles.field}>
                      <Text>Destination directory</Text>
                      <Input
                        value={form.destinationDir}
                        onChange={(_e, d) => setForm({ ...form, destinationDir: d.value })}
                      />
                    </div>
                  ) : null}

                  {form.kind === "download.create" ? (
                    <div className={styles.field}>
                      <Text>Proxy (frozen with the job — the app default is not applied here)</Text>
                      <Dropdown
                        value={
                          form.proxyProfileId
                            ? (proxyProfiles.find((p) => p.id === form.proxyProfileId)?.name ?? "unavailable profile")
                            : "Direct"
                        }
                        selectedOptions={form.proxyProfileId ? [form.proxyProfileId] : ["__direct"]}
                        onOptionSelect={(_e, d) =>
                          setForm({
                            ...form,
                            proxyProfileId: d.optionValue === "__direct" ? null : (d.optionValue as string),
                          })
                        }
                      >
                        <Option value="__direct">Direct (no proxy)</Option>
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
                      <Text>Start (local time)</Text>
                      <Input
                        type="datetime-local"
                        value={form.startLocal}
                        onChange={(_e, d) => setForm({ ...form, startLocal: d.value })}
                      />
                    </div>
                    <div className={styles.field}>
                      <Text>Repeat</Text>
                      <Dropdown
                        value={form.repeat === "none" ? "Once" : form.repeat === "daily" ? "Daily" : "Weekly"}
                        onOptionSelect={(_e, d) => {
                          if (d.optionValue === "none" || d.optionValue === "daily" || d.optionValue === "weekly") {
                            setForm({ ...form, repeat: d.optionValue });
                          }
                        }}
                      >
                        <Option value="none" text="Once">Once</Option>
                        <Option value="daily" text="Daily">Daily</Option>
                        <Option value="weekly" text="Weekly">Weekly</Option>
                      </Dropdown>
                    </div>
                  </div>

                  <div className={styles.field}>
                    <Checkbox
                      label="Enabled"
                      checked={form.enabled}
                      onChange={(_e, d) => setForm({ ...form, enabled: d.checked === true })}
                    />
                  </div>
                  <Text className={styles.meta}>
                    One-shot jobs run once at the start time (or at the next opportunity if
                    the app was closed) and then disable themselves. Repeating jobs keep
                    running even when a run fails — the outcome is always recorded.
                  </Text>
                </>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                icon={<ArrowClockwiseRegular />}
                onClick={() => setEditorOpen(false)}
              >
                Cancel
              </Button>
              <Button appearance="primary" onClick={() => void submit()}>
                {editing ? "Save changes" : "Create job"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
