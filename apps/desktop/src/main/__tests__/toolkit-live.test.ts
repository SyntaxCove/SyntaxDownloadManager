import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolkitManager } from "../toolkit/manager.js";
import { loadManifest } from "../toolkit/manifest.js";

/**
 * LIVE end-to-end probe (opt-in): `RUN_LIVE_TOOLKIT=1 npx vitest run src/main/__tests__/toolkit-live.test.ts`
 * Runs the REAL ToolkitManager against the REAL shipped manifest with production artifacts
 * from the real internet (fetch → verify → extract → activate). Proves the pinned URLs are
 * reachable and the hashes are byte-exact. Skipped by default so the CI gate stays offline
 * and deterministic.
 */

const LIVE = process.env.RUN_LIVE_TOOLKIT === "1";
const d = LIVE ? it : it.skip;

/** The shipped manifest lives at apps/desktop/resources/toolchains.json; resolve without
 *  import.meta (this package compiles to CommonJS). */
function findShippedManifest(): string {
  const candidates = [
    process.env.UNIDM_TOOLCHAINS_MANIFEST,
    resolve("apps/desktop/resources/toolchains.json"),
    resolve("resources/toolchains.json"),
  ].filter((p): p is string => !!p);
  return candidates[0]!;
}

describe("toolkit live pipeline (opt-in)", () => {
  d("installs every manifest tool from the real pinned sources", { timeout: 20 * 60_000 }, async () => {
    const manifestPath = findShippedManifest();
    const { manifest, platform } = await loadManifest(manifestPath);
    expect(manifest.manifestVersion).toBe(1);
    expect(platform).not.toBeNull();

    const root = await mkdtemp(join(tmpdir(), "unidm-live-"));
    try {
      const manager = new ToolkitManager({
        manifestPath,
        toolsRoot: join(root, "tools"),
        statePath: join(root, "toolkit-state.json"),
        onStatus: () => undefined,
        onReadyToolsChanged: () => undefined,
      });
      await manager.load();
      manager.ensureAll();
      const deadline = Date.now() + 18 * 60_000;
      for (;;) {
        const st = manager.getStatus();
        if (st.tools.every((t) => t.state === "ready" || t.state === "failed")) {
          for (const t of st.tools) {
            expect(t.state, `${t.id} must activate`).toBe("ready");
            expect(t.path, `${t.id} must expose a path`).toBeTruthy();
          }
          break;
        }
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise((r) => setTimeout(r, 1000));
      }
      // Every ready tool left a real, executable file on disk.
      for (const entry of manager.readyToolPaths()) {
        const st = await stat(entry.path);
        expect(st.isFile()).toBe(true);
        expect(st.size).toBeGreaterThan(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
