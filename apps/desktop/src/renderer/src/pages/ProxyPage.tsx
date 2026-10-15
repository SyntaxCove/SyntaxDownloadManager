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
import type { ProxyProfilePublic } from "@syntaxdm/contracts";

/**
 * Proxy page (Phase 9): profile management for per-tab and per-job routing.
 * The renderer only ever sees redacted profiles (password always null); editing sends
 * the form password to main, which encrypts it into the OS keychain.
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
  actions: { display: "flex", gap: "4px", marginLeft: "auto" },
  empty: { color: tokens.colorNeutralForeground3, padding: "24px", textAlign: "center" },
  field: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px" },
  grid: { display: "grid", gridTemplateColumns: "1fr 140px", gap: "8px" },
});

const EMPTY_DRAFT: ProxyDraft = {
  name: "",
  scheme: "http",
  host: "",
  port: 8080,
  username: null,
  password: null,
  bypassList: [],
};

export function ProxyPage(): ReactNode {
  const styles = useStyles();
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
        <Text weight="semibold">Proxy profiles</Text>
        <div className={styles.actions}>
          <Button
            appearance="primary"
            icon={<AddRegular />}
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            New profile
          </Button>
        </div>
      </div>
      <Text className={styles.meta}>
        Route browser tabs and downloads through a proxy. Passwords are stored in the OS
        keychain and are never shown again after saving.
      </Text>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {profiles.map((p) => {
        const t = testStates[p.id];
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
                aria-label={`Edit ${p.name}`}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DeleteRegular />}
                onClick={() => setRemoving(p)}
                aria-label={`Delete ${p.name}`}
              />
            </div>
            <div className={styles.row}>
              <Text className={styles.meta} title="Proxy endpoint">
                · <PlugConnectedRegular style={{ verticalAlign: -2 }} /> {p.scheme}://{p.host}:{p.port}
              </Text>
              <Text className={styles.meta}>· auth: {p.username ? p.username : "anonymous"}</Text>
              {p.bypassList.length > 0 ? (
                <Text className={styles.meta} title="Requests to these hosts skip the proxy">
                  · bypass: {p.bypassList.join(", ")}
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
                Test
              </Button>
              {t?.running ? <Spinner size="tiny" /> : null}
              {t?.ok === true ? (
                <Text className={styles.meta} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                  reachable · {t.latencyMs} ms · exit IP {t.exitIp ?? "unknown"}
                </Text>
              ) : null}
              {t?.ok === false ? (
                <Text className={styles.meta} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  failed{t.error ? ` · ${t.error}` : t.errorCode ? ` · ${t.errorCode}` : ""}
                  {t.status ? ` (HTTP ${t.status})` : ""}
                </Text>
              ) : null}
            </div>
          </div>
        );
      })}
      {profiles.length === 0 && loaded ? (
        <div className={styles.empty}>No proxy profiles — everything connects directly.</div>
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
            <DialogTitle>Delete proxy profile</DialogTitle>
            <DialogContent>
              <Text className={styles.meta} block>
                {removing
                  ? `Delete "${removing.name}"? Downloads and tabs using it must be reassigned first.`
                  : ""}
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                appearance="primary"
                icon={<DismissRegular />}
                onClick={() => {
                  const id = removing?.id;
                  setRemoving(null);
                  if (id) remove(id).catch((e) => setError(String(e?.message ?? e)));
                }}
              >
                Delete
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
          <DialogTitle>{profile ? "Edit proxy profile" : "New proxy profile"}</DialogTitle>
          <DialogContent>
            {profile ? (
              <Text className={styles.meta} block>
                Leave the password blank to keep the one stored in the keychain.
              </Text>
            ) : null}
            <div className={styles.field}>
              <Text size={200}>Name</Text>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Office exit" aria-label="Profile name" />
            </div>
            <div className={styles.field}>
              <Text size={200}>Scheme</Text>
              <Dropdown
                value={scheme}
                selectedOptions={[scheme]}
                onOptionSelect={(_, d) => setScheme((d.optionValue ?? "http") as ProxySchemeChoice)}
                aria-label="Proxy scheme"
              >
                <Option value="http">http</Option>
                <Option value="https">https</Option>
                <Option value="socks5">socks5</Option>
              </Dropdown>
            </div>
            <div className={styles.field}>
              <Text size={200}>Endpoint</Text>
              <div className={styles.grid}>
                <Input value={host} onChange={(_, d) => setHost(d.value)} placeholder="proxy.example.com" aria-label="Proxy host" />
                <Input
                  value={port}
                  onChange={(_, d) => setPort(d.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  aria-label="Proxy port"
                />
              </div>
            </div>
            <div className={styles.field}>
              <Text size={200}>Authentication (optional)</Text>
              <div className={styles.grid}>
                <Input value={username} onChange={(_, d) => setUsername(d.value)} placeholder="Username" aria-label="Proxy username" />
                <Input
                  value={password}
                  onChange={(_, d) => setPassword(d.value)}
                  type="password"
                  placeholder={profile ? "•••••••• (saved)" : "Password"}
                  aria-label="Proxy password"
                />
              </div>
            </div>
            <div className={styles.field}>
              <Text size={200}>Bypass list (comma-separated, optional)</Text>
              <Input
                value={bypass}
                onChange={(_, d) => setBypass(d.value)}
                placeholder=".internal.example.com, <local>"
                aria-label="Bypass list"
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={props.onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!valid || busy} onClick={submit}>
              {profile ? "Save" : "Create"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
