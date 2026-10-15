import { existsSync } from "node:fs";
import { join } from "node:path";
import { SyntaxDmError, METHODS } from "@syntaxdm/contracts";
import type { LibraryEntryKind } from "@syntaxdm/contracts";
import type { IpcRouter } from "../ipc/router.js";
import type { CoreSupervisor } from "../core/core-supervisor.js";

/**
 * App domain (Phase 14) — downloads library reveal/open.
 *
 * Security model: the renderer supplies ONLY (kind, id, mode). Main fetches the
 * authoritative job row from the Rust core and derives the path exclusively from persisted
 * fields — a compromised renderer can never reveal or open an arbitrary filesystem path.
 *
 * Path resolution per kind:
 *  - download / media → `destinationPath` (null until the probe/mux placed the file →
 *    `entry_path_unavailable`);
 *  - torrent → `join(destinationDir, name)`; `name` is null until metadata resolves →
 *    `entry_path_unavailable`. "open" opens the content folder in Explorer, "folder"
 *    reveals it selected inside `destinationDir`.
 *
 * Existence is checked before acting; a path that no longer exists fails with
 * `file_missing` (the user moved/deleted it outside the app — never a silent no-op).
 */

/** The slice of Electron's shell the domain needs — injectable for tests. */
export interface RevealShell {
  showItemInFolder(fullPath: string): void;
  openPath(path: string): Promise<string>;
}

type JobRow = {
  job: {
    destinationPath?: string | null;
    destinationDir?: string;
    name?: string | null;
  } | null;
};

/** Resolve the artifact path for a job row; throws `entry_path_unavailable` when unset. */
export function resolveEntryPath(kind: LibraryEntryKind, row: JobRow): string {
  const job = row.job;
  if (!job) throw new SyntaxDmError("invalid_state", "job not found");
  if (kind === "torrent") {
    if (!job.destinationDir || !job.name) {
      throw new SyntaxDmError(
        "entry_path_unavailable",
        "torrent content path is not resolved yet (no metadata)",
      );
    }
    return join(job.destinationDir, job.name);
  }
  if (!job.destinationPath) {
    throw new SyntaxDmError(
      "entry_path_unavailable",
      "the artifact path is not resolved yet (probe/mux has not placed the file)",
    );
  }
  return job.destinationPath;
}

export function registerAppDomain(
  router: IpcRouter,
  supervisor: CoreSupervisor,
  shell: RevealShell,
): void {
  router.handle("app.revealEntry", {
    paramsSchema: METHODS["app.revealEntry"].params,
    resultSchema: METHODS["app.revealEntry"].result,
    handler: async (params) => {
      const { kind, id, mode } = params as {
        kind: LibraryEntryKind;
        id: string;
        mode: "folder" | "open";
      };
      const sourceMethod =
        kind === "download" ? "download.get" : kind === "media" ? "media.get" : "torrent.get";
      const row = (await supervisor.request(sourceMethod, { id })) as JobRow;
      const path = resolveEntryPath(kind, row);
      if (!existsSync(path)) {
        throw new SyntaxDmError(
          "file_missing",
          `the artifact is gone from disk: ${path}`,
        );
      }
      if (mode === "folder") {
        shell.showItemInFolder(path);
      } else {
        const error = await shell.openPath(path);
        if (error) {
          throw new SyntaxDmError("io_error", `shell could not open the path: ${error}`);
        }
      }
      return { path };
    },
  });
}
