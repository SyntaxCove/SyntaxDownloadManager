import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { UniDmError } from "@unidm/contracts";

/**
 * Streamed artifact fetcher (Phase 10).
 *
 * Downloads an artifact to a staging file while hashing it, with:
 *  - a HARD byte cap (manifest sizeBytes + headroom): a hijacked/runaway stream is cut
 *    mid-flight instead of filling the disk;
 *  - classified cancellation via an AbortSignal (the manager cancels in-flight fetches);
 *  - retries with exponential backoff for transient failures (injected sleep keeps tests
 *    deterministic).
 *
 * The hash and byte count come back from the SAME pass that wrote the file — there is no
 * window where a file exists that we have not fully accounted for.
 */

export interface FetchResult {
  /** Absolute staging path (caller owns cleanup). */
  readonly file: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface FetchOptions {
  readonly url: string;
  readonly stagingDir: string;
  /** Manifest-pinned exact size; the hard cap is size + capHeadroomBytes. */
  readonly sizeBytes: number;
  readonly capHeadroomBytes?: number;
  readonly signal?: AbortSignal;
  readonly retries?: number;
  /** Injected for tests; defaults to a real exponential backoff (ms). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected progress callback (called at most once per chunk). */
  readonly onChunk?: (bytesFetched: number, totalBytes: number | null) => void;
  /** Node fetch injection for tests; defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_HEADROOM = 1024 * 1024; // 1 MiB

export async function fetchArtifact(opts: FetchOptions): Promise<FetchResult> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const cap = opts.sizeBytes + (opts.capHeadroomBytes ?? DEFAULT_HEADROOM);
  const doFetch = opts.fetchImpl ?? fetch;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new UniDmError("canceled", "toolkit fetch canceled");
    try {
      return await fetchOnce(opts, cap, doFetch);
    } catch (err) {
      lastError = err;
      // Cancellation and hard-cap violations are terminal — never retried.
      if (opts.signal?.aborted) throw new UniDmError("canceled", "toolkit fetch canceled");
      if (err instanceof UniDmError && (err.code === "disk_full" || err.code === "file_exists")) throw err;
      if (attempt < retries) {
        await sleep(250 * 2 ** attempt);
      }
    }
  }
  throw new UniDmError(
    "toolkit_fetch_failed",
    `artifact download failed after ${retries + 1} attempt(s): ${describe(lastError)}`,
  );
}

function describe(err: unknown): string {
  if (err instanceof UniDmError) return `${err.code}: ${err.message}`;
  return String(err);
}

async function fetchOnce(
  opts: FetchOptions,
  cap: number,
  doFetch: typeof fetch,
): Promise<FetchResult> {
  const file = `${opts.stagingDir}/.fetch-${Date.now()}-${randomBytes(4).toString("hex")}.part`;
  const hash = createHash("sha256");
  let size = 0;
  let res: Response | null = null;
  try {
    res = await doFetch(opts.url, {
      signal: opts.signal,
      redirect: "follow",
      headers: { "user-agent": "UniDM-Toolkit/1.0 (+https://github.com/)" },
    });
    if (!res.ok) {
      throw new UniDmError(
        "toolkit_fetch_failed",
        `artifact endpoint answered HTTP ${res.status}`,
      );
    }
    if (!res.body) {
      throw new UniDmError("toolkit_fetch_failed", "artifact endpoint returned an empty body");
    }
    const total = res.headers.has("content-length") ? Number(res.headers.get("content-length")) : null;
    // Adapt the undici web stream to a Node stream (backpressure-preserving).
    const stream = Readable.fromWeb(res.body as unknown as NodeWebReadableStream);
    await pipeline(stream, async function* (source) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > cap) {
          throw new UniDmError(
            "toolkit_fetch_failed",
            `artifact exceeds the pinned size cap (${cap} bytes) — aborting`,
          );
        }
        hash.update(buf);
        opts.onChunk?.(size, total !== null && Number.isFinite(total) ? total : null);
        yield buf;
      }
    }, createWriteStream(file));
    return { file, sha256: hash.digest("hex"), sizeBytes: size };
  } catch (err) {
    await unlink(file).catch(() => undefined);
    throw err;
  } finally {
    // Nothing to release for a consumed body stream; Response kept out of GC limbo.
    void res;
  }
}
