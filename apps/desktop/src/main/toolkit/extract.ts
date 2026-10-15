import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SyntaxDmError } from "@syntaxdm/contracts";

/**
 * Archive extraction (Phase 10) — the security boundary between downloaded bytes and the
 * filesystem.
 *
 * Every entry name is validated BEFORE extraction:
 *  - absolute paths, drive-qualified paths, `..` segments and empty names are rejected;
 *  - the resolved destination of every entry must stay inside the extraction root
 *    (zip-slip / tar-escape protection — rejected with `toolkit_extract_failed`);
 *  - symlink entries are materialized only when their target stays inside the root, and
 *    only on non-win32 platforms (Windows archives here contain none; creating symlinks
 *    there needs privileges we do not require).
 *
 * Extraction happens ONLY into the manager's staging directory; nothing outside the root
 * is ever touched, and the caller activates via rename afterwards.
 */

export type ArchiveType = "none" | "zip" | "tar.xz";

export interface ExtractOptions {
  readonly archivePath: string;
  readonly archiveType: ArchiveType;
  /** Directory the archive may write into (must already exist). */
  readonly destDir: string;
  /** Relative executable paths (forward slashes) to chmod 0755 on unix. */
  readonly execPaths: readonly string[];
  readonly platform: string;
}

export async function extractArtifact(opts: ExtractOptions): Promise<void> {
  if (opts.archiveType === "none") {
    // Single-file artifact: the "archive" is the executable itself; move it into place.
    const target = safeJoin(opts.destDir, opts.execPaths[0] ?? "tool.bin");
    const { rename } = await import("node:fs/promises");
    await rename(opts.archivePath, target);
    if (opts.platform !== "win32") await chmod(target, 0o755).catch(() => undefined);
    return;
  }
  if (opts.archiveType === "zip") {
    await extractZip(opts);
  } else {
    await extractTarXz(opts);
  }
  if (opts.platform !== "win32") {
    for (const rel of opts.execPaths) {
      await chmod(safeJoin(opts.destDir, rel), 0o755).catch(() => undefined);
    }
  }
}

/** Validate an entry name and return its safe absolute destination inside `destDir`. */
export function safeJoin(destDir: string, entryName: string): string {
  if (entryName.length === 0) {
    throw new SyntaxDmError("toolkit_extract_failed", "archive entry has an empty name");
  }
  const normalized = entryName.replace(/\\/g, "/");
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new SyntaxDmError("toolkit_extract_failed", `archive entry escapes the root: ${entryName}`);
  }
  const parts = normalized.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new SyntaxDmError("toolkit_extract_failed", `archive entry escapes the root: ${entryName}`);
  }
  const target = resolve(destDir, ...parts);
  const root = resolve(destDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SyntaxDmError("toolkit_extract_failed", `archive entry escapes the root: ${entryName}`);
  }
  return target;
}

async function mkdirp(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function extractZip(opts: ExtractOptions): Promise<void> {
  const yauzl = (await import("yauzl")) as typeof import("yauzl");
  await new Promise<void>((res, rej) => {
    yauzl.open(opts.archivePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) return rej(new SyntaxDmError("toolkit_extract_failed", `zip open failed: ${err}`));
      const fail = (e: Error) => rej(new SyntaxDmError("toolkit_extract_failed", `zip extract failed: ${e.message}`));
      zipfile.on("error", fail);
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name)) {
          // Directory entry — create it inside the root.
          mkdirp(safeJoin(opts.destDir, name))
            .then(() => zipfile.readEntry())
            .catch(fail);
          return;
        }
        const target = (() => {
          try {
            return safeJoin(opts.destDir, name);
          } catch (e) {
            fail(e as Error);
            return null;
          }
        })();
        if (target === null) return;
        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2 || !readStream) return fail(err2 ?? new Error("no stream"));
          import("node:fs")
            .then(({ createWriteStream }) => {
              // Archives are not required to carry explicit directory entries — always
              // materialize the parent chain before writing the file.
              return mkdir(dirname(target), { recursive: true }).then(() => {
                const out = createWriteStream(target, { mode: opts.platform !== "win32" ? 0o755 : undefined });
                readStream.on("error", fail);
                out.on("error", fail);
                out.on("finish", () => zipfile.readEntry());
                readStream.pipe(out);
              });
            })
            .catch(fail);
        });
      });
      zipfile.on("end", () => res());
    });
  });
}

async function extractTarXz(opts: ExtractOptions): Promise<void> {
  const lzma = (await import("lzma-native")) as typeof import("lzma-native");
  const tar = (await import("tar-stream")) as typeof import("tar-stream");
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");

  const extract = tar.extract();
  const root = resolve(opts.destDir);

  extract.on("entry", (header, stream, next) => {
    void (async () => {
      const name = header.name;
      if (header.type === "symlink" || header.type === "link") {
        // Hardlinks/symlinks from pinned archives are not needed; resolving an in-root
        // link target is not worth the risk surface — reject outright.
        throw new SyntaxDmError("toolkit_extract_failed", `archive link entry rejected: ${name}`);
      }
      if (header.type !== "file" && header.type !== "directory") {
        stream.resume();
        return next();
      }
      const target = safeJoin(opts.destDir, name);
      if (header.type === "directory") {
        await mkdirp(target);
        return next();
      }
      // Directory traversal double-check on the resolved path.
      if (!target.startsWith(root + sep) && target !== root) {
        throw new SyntaxDmError("toolkit_extract_failed", `archive entry escapes the root: ${name}`);
      }
      await mkdirp(target.slice(0, target.lastIndexOf(sep)));
      const mode = opts.platform !== "win32" ? 0o755 : undefined;
      await pipeline(stream, createWriteStream(target, { mode }));
      next();
    })().catch((err) => {
      extract.destroy(err);
    });
  });

  await pipeline(createReadStream(opts.archivePath), lzma.createDecompressor({ threads: 1 }), extract);
}
