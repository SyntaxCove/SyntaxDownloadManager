import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  EVENTS,
  METHODS,
  newUlid,
  SyntaxDmError,
  type ProxyEndpoint,
  type ProxyProfileInput,
  type ProxyProfilePublic,
} from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";
import type { SettingsStore } from "./settings.js";

/**
 * Proxy profile store (main process, Phase 9).
 *
 * Security posture:
 *  - Persistence: userData/proxy-profiles.json, written atomically (tmp + rename); a file
 *    that fails validation is quarantined like settings.json.
 *  - Passwords NEVER touch the disk in plaintext: they are stored as safeStorage ciphertext
 *    with an `enc:v1:<base64>` marker (DPAPI on Windows). If the keychain is unavailable,
 *    saving a profile that carries a password is REFUSED (fail-closed) — the store never
 *    silently downgrades to plaintext.
 *  - The renderer never receives secrets: every result is redacted (`password: null`).
 *  - Decrypted credentials exist only in main-process memory, in two consumers:
 *    `runtimeEndpoints()` (pushed to the Rust core via proxy.setRuntime) and the Chromium
 *    tab-session resolver. They are never logged; error paths embed ids/names only.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** What the tab manager needs to wire a Chromium session onto a proxy (no creds in rules). */
export interface ResolvedTabProxy {
  proxyRules: string;
  proxyBypassRules: string;
  username: string | null;
  password: string | null;
}

interface StoredProfile {
  id: string;
  name: string;
  scheme: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  /** `enc:v1:<base64>` ciphertext or null. */
  password: string | null;
  bypassList: string[];
}

interface StoreFile {
  version: 1;
  profiles: StoredProfile[];
}

const ENC_MARKER = "enc:v1:";

export const redact = (p: StoredProfile): ProxyProfilePublic => ({
  id: p.id,
  name: p.name,
  scheme: p.scheme,
  host: p.host,
  port: p.port,
  username: p.username,
  password: null,
  bypassList: p.bypassList,
});

export class ProxyProfileStore {
  private profiles: StoredProfile[] = [];

  constructor(
    private readonly userDataDir: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly now: () => number = Date.now,
  ) {}

  get filePath(): string {
    return join(this.userDataDir, "proxy-profiles.json");
  }

  async load(): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true });
    let raw: string | null = null;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return; // first run
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantineCorrupt();
      return;
    }
    const doc = parsed as Partial<StoreFile>;
    if (!doc || !Array.isArray(doc.profiles)) {
      await this.quarantineCorrupt();
      return;
    }
    // Defensive per-profile shape check (the file is outside the IPC contract).
    this.profiles = doc.profiles.filter(
      (p): p is StoredProfile =>
        !!p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.host === "string" &&
        typeof p.port === "number" &&
        (p.scheme === "http" || p.scheme === "https" || p.scheme === "socks5") &&
        Array.isArray(p.bypassList),
    );
  }

  list(): ProxyProfilePublic[] {
    return this.profiles.map(redact);
  }

  has(id: string): boolean {
    return this.profiles.some((p) => p.id === id);
  }

  async create(input: ProxyProfileInput): Promise<ProxyProfilePublic> {
    const profile: StoredProfile = {
      id: newUlid(),
      name: input.name,
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      username: input.username,
      password: await this.encryptPassword(input.password),
      bypassList: [...input.bypassList],
    };
    this.profiles.push(profile);
    await this.persist();
    return redact(profile);
  }

  /** Patch semantics: omitted keys keep the stored value; `password: undefined` keeps it. */
  async update(id: string, patch: Partial<ProxyProfileInput>): Promise<ProxyProfilePublic> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) {
      throw new SyntaxDmError("proxy_profile_not_found", `proxy profile ${id} not found`);
    }
    if (patch.name !== undefined) profile.name = patch.name;
    if (patch.scheme !== undefined) profile.scheme = patch.scheme;
    if (patch.host !== undefined) profile.host = patch.host;
    if (patch.port !== undefined) profile.port = patch.port;
    if (patch.username !== undefined) profile.username = patch.username;
    if (patch.bypassList !== undefined) profile.bypassList = [...patch.bypassList];
    if (patch.password !== undefined) {
      profile.password = await this.encryptPassword(patch.password);
    }
    await this.persist();
    return redact(profile);
  }

  /** Removes the profile. Callers guard in-use jobs (`proxy_in_use`) before invoking. */
  async remove(id: string): Promise<void> {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.profiles.length === before) {
      throw new SyntaxDmError("proxy_profile_not_found", `proxy profile ${id} not found`);
    }
    await this.persist();
  }

  /** Decrypted endpoints for the core runtime push — the ONLY core-facing secret path. */
  async runtimeEndpoints(): Promise<ProxyEndpoint[]> {
    const out: ProxyEndpoint[] = [];
    for (const p of this.profiles) {
      const password = await this.decryptPassword(p);
      out.push({
        id: p.id,
        scheme: p.scheme,
        host: p.host,
        port: p.port,
        username: p.username,
        password,
        bypassList: p.bypassList,
      });
    }
    return out;
  }

  /** Chromium session resolver for the tab manager; unknown profile → null (direct). */
  async resolveForTab(id: string): Promise<ResolvedTabProxy | null> {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return null;
    const password = await this.decryptPassword(p);
    return {
      proxyRules: `${p.scheme}://${p.host}:${p.port}`,
      proxyBypassRules: p.bypassList.join(","),
      username: p.username,
      password,
    };
  }

  private async encryptPassword(plain: string | null): Promise<string | null> {
    if (plain === null || plain === "") return null;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new SyntaxDmError(
        "proxy_keychain_unavailable",
        "OS keychain is unavailable; refusing to store the proxy password in plaintext",
      );
    }
    try {
      return ENC_MARKER + this.safeStorage.encryptString(plain).toString("base64");
    } catch {
      throw new SyntaxDmError(
        "proxy_keychain_unavailable",
        "the OS keychain refused to encrypt the proxy password",
      );
    }
  }

  private async decryptPassword(p: StoredProfile): Promise<string | null> {
    const stored = p.password;
    if (!stored) return null;
    if (!stored.startsWith(ENC_MARKER)) {
      // Not our ciphertext (legacy/corrupt) — treat as no password rather than guess.
      return null;
    }
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    try {
      const plain = this.safeStorage.decryptString(Buffer.from(stored.slice(ENC_MARKER.length), "base64"));
      return plain === "" ? null : plain;
    } catch {
      // Keychain locked or profile re-keyed: report "no credentials" — the connection will
      // surface a 407 through the normal classified error paths. Never log the ciphertext.
      return null;
    }
  }

  private async persist(): Promise<void> {
    const doc: StoreFile = { version: 1, profiles: this.profiles };
    const tmp = `${this.filePath}.tmp-${this.now()}`;
    try {
      await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new SyntaxDmError("io_error", `proxy profiles persist failed: ${String(err)}`);
    }
  }

  private async quarantineCorrupt(): Promise<void> {
    await rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`).catch(() => undefined);
    this.profiles = [];
    await this.persist();
  }
}

/**
 * Registers proxy.list/create/update/remove on the router. Results are redacted. Every
 * successful mutation triggers `onChanged` (main re-pushes the runtime set to the core).
 * Removal is refused with `proxy_in_use` (+ job count) while any download job still
 * references the profile — the UI surfaces the count and offers reassignment.
 *
 * Phase 16: removal also keeps the settings coherent — a `defaultProxyProfileId` pointing
 * at the removed profile is cleared (with a `settings.changed` broadcast) so settings never
 * reference a nonexistent profile. Jobs keep their persisted Phase 9 fail-closed semantics.
 */
export function registerProxyDomain(
  router: IpcRouter,
  store: ProxyProfileStore,
  supervisor: CoreSupervisor,
  onChanged: () => void,
  settingsStore?: SettingsStore,
): void {
  const entry = (method: keyof typeof METHODS) => {
    const e = METHODS[method];
    return {
      paramsSchema: e.params as NonNullable<typeof e.params>,
      resultSchema: e.result as NonNullable<typeof e.result>,
    };
  };

  router.handle("proxy.list", {
    ...entry("proxy.list"),
    handler: async () => ({ profiles: store.list() }),
  });

  router.handle("proxy.create", {
    ...entry("proxy.create"),
    handler: async (params) => {
      const { profile } = params as { profile: ProxyProfileInput };
      const created = await store.create(profile);
      onChanged();
      return { profile: created };
    },
  });

  router.handle("proxy.update", {
    ...entry("proxy.update"),
    handler: async (params) => {
      const { id, profile } = params as { id: string; profile: Partial<ProxyProfileInput> };
      const updated = await store.update(id, profile);
      onChanged();
      return { profile: updated };
    },
  });

  router.handle("proxy.remove", {
    ...entry("proxy.remove"),
    handler: async (params) => {
      const { id } = params as { id: string };
      let jobCount = 0;
      try {
        const { jobs } = await supervisor.request<{ jobs: Array<{ proxyProfileId?: string | null }> }>(
          "download.list",
          {},
        );
        jobCount = jobs.filter((j) => j.proxyProfileId === id).length;
      } catch {
        // Core unavailable: refuse to delete rather than orphan a bound job silently.
        throw new SyntaxDmError("core_unavailable", "cannot verify proxy usage while the core is unavailable");
      }
      if (jobCount > 0) {
        throw new SyntaxDmError(
          "proxy_in_use",
          `${jobCount} download job(s) still reference this profile`,
          { jobCount },
        );
      }
      await store.remove(id);
      // Phase 16: settings must never reference a nonexistent profile.
      if (settingsStore && settingsStore.settings.defaultProxyProfileId === id) {
        const next = await settingsStore.update({ defaultProxyProfileId: null });
        router.emit("settings.changed", EVENTS["settings.changed"].payload, { settings: next });
      }
      onChanged();
      return { removed: true as const };
    },
  });
}
