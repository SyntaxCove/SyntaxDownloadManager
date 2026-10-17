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
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowExitRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
  PlugConnectedRegular,
} from "@fluentui/react-icons";
import { useProxyStore, type ProxyDraft, type ProxySchemeChoice } from "../stores/proxy.js";
import { useI18n } from "../i18n/context.js";
import { formatNumber } from "../i18n/format.js";
import type { ProxyProfilePublic } from "@syntaxdm/contracts";

/**
 * Proxy page (Phase 9): profile management for per-tab and per-job routing.
 * The renderer only ever sees redacted profiles (password always null); editing sends
 * the form password to main, which encrypts it into the OS keychain.
 * Phase 21: localized strings; the editor's field labels are wired to their inputs
 * via aria-labelledby.
 */

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "860px" },
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
  actions: { display: "flex", gap: "4px", marginInlineStart: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
  field: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px" },
  grid: { display: "grid", gridTemplateColumns: "1fr 140px", gap: "8px" },
});

export function ProxyPage(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const profiles = useProxyStore((s) => s.profiles);
  const loaded = useProxyStore((s) => s.loaded);
  const load = useProxyStore((s) => s.load);
  const remove = useProxyStore((s) => s.remove);
  const testStates = useProxyStore((s) => s.testStates);

  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyProfilePublic | null>(null);
  const [removing, setRemoving] = useState<ProxyProfilePublic | null>(null);

  useEffect(() => {
    if (!loaded) void load().catch((e) => setError(String(e?.message ?? e)));
  }, [loaded, load]);

  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <Text as="h1" weight="semibold" size={500}>
          {t("proxy.title")}
        </Text>
        <div className={styles.actions}>
          <Button
            appearance="primary"
            icon={<AddRegular />}
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            {t("proxy.newProfile")}
          </Button>
        </div>
      </div>
      <Text className={styles.meta}>{t("proxy.intro")}</Text>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {profiles.map((p) => {
        const ts = testStates[p.id];
        return (
          <div key={p.id} className={styles.card}>
            <div className={styles.row}>
              <Text className={styles.name} title={p.name}>
                {p.name}
              </Text>
              <Button
                appearance="subtle"
                size="small"
                icon={<EditRegular />}
                onClick={() => {
                  setEditing(p);
                  setEditorOpen(true);
                }}
                aria-label={t("proxy.editAria", { name: p.name })}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                onClick={() => setRemoving(p)}
                aria-label={t("proxy.deleteAria", { name: p.name })}
              />
            </div>
            <div className={styles.row}>
              <Text className={styles.meta} title={t("proxy.endpointTitle")}>
                · <PlugConnectedRegular style={{ verticalAlign: -2 }} aria-hidden="true" /> {p.scheme}://{p.host}:{p.port}
              </Text>
              <Text className={styles.meta}>
                · {p.username ? t("proxy.auth", { user: p.username }) : t("proxy.authAnonymous")}
              </Text>
              {p.bypassList.length > 0 ? (
                <Text className={styles.meta} title={t("proxy.bypassTitle")}>
                  · {t("proxy.bypass", { list: p.bypassList.join(", ") })}
                </Text>
              ) : null}
            </div>
            <div className={styles.row}>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowExitRegular />}
                onClick={() => void useProxyStore.getState().test(p.id).catch((e) => setError(String(e?.message ?? e)))}
              >
                {t("common.test")}
              </Button>
              {ts?.running ? <Spinner size="tiny" /> : null}
              {ts?.ok === true ? (
                <Text className={styles.meta} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                  {t("proxy.testOk", {
                    ms: formatNumber(ts.latencyMs ?? 0, t.lang),
                    ip: ts.exitIp ?? t("proxy.testOkIpUnknown"),
                  })}
                </Text>
              ) : null}
              {ts?.ok === false ? (
                <Text className={styles.meta} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {t("proxy.testFailed")}
                  {ts.error ? ` · ${ts.error}` : ts.errorCode ? ` · ${ts.errorCode}` : ""}
                  {ts.status ? ` (HTTP ${formatNumber(ts.status, t.lang)})` : ""}
                </Text>
              ) : null}
            </div>
          </div>
        );
      })}
      {profiles.length === 0 && loaded ? (
        <div className={styles.empty}>{t("proxy.empty")}</div>
      ) : null}

      <ProfileEditorDialog
        open={editorOpen}
        profile={editing}
        onClose={() => setEditorOpen(false)}
        onError={setError}
      />

      <Dialog open={removing !== null} onOpenChange={(_, d) => (d.open ? undefined : setRemoving(null))}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("proxy.deleteDialog.title")}</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                {removing ? t("proxy.deleteDialog.body", { name: removing.name }) : ""}
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
              <Button
                appearance="primary"
                icon={<DismissRegular />}
                onClick={() => {
                  const id = removing?.id;
                  setRemoving(null);
                  if (id) remove(id).catch((e) => setError(String(e?.message ?? e)));
                }}
              >
                {t("common.delete")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function ProfileEditorDialog(props: {
  open: boolean;
  profile: ProxyProfilePublic | null;
  onClose: () => void;
  onError: (msg: string) => void;
}): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const create = useProxyStore((s) => s.create);
  const update = useProxyStore((s) => s.update);
  const { open, profile } = props;

  const [name, setName] = useState("");
  const [scheme, setScheme] = useState<ProxySchemeChoice>("http");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8080");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bypass, setBypass] = useState("");
  const [busy, setBusy] = useState(false);

  // (Re)seed the form each time the dialog opens for a different profile.
  const [seedFor, setSeedFor] = useState<string | null>(null);
  if (open && seedFor !== (profile?.id ?? "__new__")) {
    setSeedFor(profile?.id ?? "__new__");
    setName(profile?.name ?? "");
    setScheme(profile?.scheme ?? "http");
    setHost(profile?.host ?? "");
    setPort(String(profile?.port ?? 8080));
    setUsername(profile?.username ?? "");
    setPassword(""); // never round-trips secrets
    setBypass(profile?.bypassList.join(", ") ?? "");
  }
  if (!open && seedFor !== null) setSeedFor(null);

  const valid = name.trim().length > 0 && host.trim().length > 0 && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;

  const submit = (): void => {
    if (!valid) return;
    setBusy(true);
    const draft: ProxyDraft = {
      name: name.trim(),
      scheme,
      host: host.trim(),
      port: Number.parseInt(port, 10),
      username: username.trim() === "" ? null : username.trim(),
      password: password === "" ? null : password,
      bypassList: bypass
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };
    const action = profile ? update(profile.id, draft) : create(draft);
    action
      .then(() => {
        setBusy(false);
        props.onClose();
      })
      .catch((e) => {
        setBusy(false);
        props.onError(String(e?.message ?? e));
      });
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => (d.open ? undefined : props.onClose())}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{profile ? t("proxy.editor.editTitle") : t("proxy.editor.createTitle")}</DialogTitle>
          <DialogContent>
            {profile ? (
              <Text className={styles.meta} block>
                {t("proxy.editor.keepPasswordHint")}
              </Text>
            ) : null}
            <div className={styles.field}>
              <Text id="proxy-name-label" size={200}>{t("proxy.editor.name")}</Text>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder={t("proxy.editor.namePlaceholder")} aria-labelledby="proxy-name-label" />
            </div>
            <div className={styles.field}>
              <Text id="proxy-scheme-label" size={200}>{t("proxy.editor.scheme")}</Text>
              <Dropdown
                value={scheme}
                selectedOptions={[scheme]}
                onOptionSelect={(_, d) => setScheme((d.optionValue ?? "http") as ProxySchemeChoice)}
                aria-labelledby="proxy-scheme-label"
              >
                <Option value="http">http</Option>
                <Option value="https">https</Option>
                <Option value="socks5">socks5</Option>
              </Dropdown>
            </div>
            <div className={styles.field}>
              <Text id="proxy-endpoint-label" size={200}>{t("proxy.editor.endpoint")}</Text>
              <div className={styles.grid}>
                <Input value={host} onChange={(_, d) => setHost(d.value)} placeholder={t("proxy.editor.hostPlaceholder")} aria-labelledby="proxy-endpoint-label" />
                <Input
                  value={port}
                  onChange={(_, d) => setPort(d.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  aria-label={t("proxy.editor.portAria")}
                />
              </div>
            </div>
            <div className={styles.field}>
              <Text id="proxy-auth-label" size={200}>{t("proxy.editor.auth")}</Text>
              <div className={styles.grid}>
                <Input value={username} onChange={(_, d) => setUsername(d.value)} placeholder={t("proxy.editor.usernamePlaceholder")} aria-labelledby="proxy-auth-label" />
                <Input
                  value={password}
                  onChange={(_, d) => setPassword(d.value)}
                  type="password"
                  placeholder={profile ? t("proxy.editor.passwordPlaceholderSaved") : t("proxy.editor.passwordPlaceholder")}
                  aria-label={t("proxy.editor.passwordAria")}
                />
              </div>
            </div>
            <div className={styles.field}>
              <Text id="proxy-bypass-label" size={200}>{t("proxy.editor.bypass")}</Text>
              <Input
                value={bypass}
                onChange={(_, d) => setBypass(d.value)}
                placeholder={t("proxy.editor.bypassPlaceholder")}
                aria-labelledby="proxy-bypass-label"
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={props.onClose}>{t("common.cancel")}</Button>
            <Button appearance="primary" disabled={!valid || busy} onClick={submit}>
              {profile ? t("common.save") : t("proxy.editor.create")}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
