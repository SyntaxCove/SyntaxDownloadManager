import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AppSettings,
  EVENTS,
  METHODS,
  SETTINGS_DEFAULTS,
  SyntaxDmError,
  type AppSettings as AppSettingsT,
} from "@syntaxdm/contracts";
import { IpcRouter } from "../ipc/router.js";

/**
 * Settings domain (main process). Persistence: userData/settings.json, written atomically
 * (tmp file + rename) so a crash mid-write can never corrupt the file. A file that fails
 * validation is renamed to settings.json.corrupt-<ts> and defaults are reinstated — the app
 * always starts with a *valid* settings state.
 */

export class SettingsStore {
  private current: AppSettingsT = { ...SETTINGS_DEFAULTS };

  constructor(
    private readonly userDataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  get filePath(): string {
    return join(this.userDataDir, "settings.json");
  }

  get settings(): AppSettingsT {
    return this.current;
  }

  /** Load + validate persisted settings; merge with defaults for forward compatibility. */
  async load(): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true });
    let raw: string | null = null;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return; // first run — keep defaults
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      await this.quarantineCorrupt();
      return;
    }
    const merged = AppSettings.safeParse({ ...SETTINGS_DEFAULTS, ...(parsedJson as object) });
    if (!merged.success) {
      await this.quarantineCorrupt();
      return;
    }
    this.current = merged.data;
  }

  /** Apply a validated patch, persist atomically, return the new state. */
  async update(patch: Partial<AppSettingsT>): Promise<AppSettingsT> {
    // zod failure here bubbles to the router and maps to invalid_params — by design.
    const merged = AppSettings.parse({ ...this.current, ...patch });
    await this.persist(merged);
    this.current = merged;
    return merged;
  }

  private async persist(settings: AppSettingsT): Promise<void> {
    const tmp = `${this.filePath}.tmp-${this.now()}`;
    try {
      await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new SyntaxDmError("io_error", `settings persist failed: ${String(err)}`);
    }
  }

  private async quarantineCorrupt(): Promise<void> {
    await rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`).catch(() => undefined);
    this.current = { ...SETTINGS_DEFAULTS };
    // Persist defaults so subsequent runs start from a valid file (stable state).
    await this.persist(this.current);
  }
}

/** Registers settings.get / settings.setAll on the router, contract schemas enforced. */
export function registerSettingsDomain(router: IpcRouter, store: SettingsStore): void {
  const getEntry = METHODS["settings.get"] as (typeof METHODS)["settings.get"] & {
    params: NonNullable<(typeof METHODS)["settings.get"]["params"]>;
    result: NonNullable<(typeof METHODS)["settings.get"]["result"]>;
  };
  const setEntry = METHODS["settings.setAll"] as (typeof METHODS)["settings.setAll"] & {
    params: NonNullable<(typeof METHODS)["settings.setAll"]["params"]>;
    result: NonNullable<(typeof METHODS)["settings.setAll"]["result"]>;
  };

  router.handle("settings.get", {
    paramsSchema: getEntry.params,
    resultSchema: getEntry.result,
    handler: async () => ({ settings: store.settings }),
  });

  router.handle("settings.setAll", {
    paramsSchema: setEntry.params,
    resultSchema: setEntry.result,
    handler: async (params) => {
      const { settings } = params as { settings: Partial<AppSettingsT> };
      const next = await store.update(settings);
      router.emit("settings.changed", EVENTS["settings.changed"].payload, { settings: next });
      return { settings: next };
    },
  });
}
