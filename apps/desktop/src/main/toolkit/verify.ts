import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { UniDmError } from "@unidm/contracts";

/**
 * Post-download verification (Phase 10) — the integrity gate before ANY byte is activated.
 *
 * The fetcher already hashed while streaming; this module re-derives the hash from the
 * FILE ON DISK (independent second pass over the stored bytes — catches bugs in the
 * stream pipeline, not just the network) and enforces the pinned size exactly.
 * A mismatch deletes the artifact and fails the install (`toolkit_checksum_mismatch`);
 * nothing is ever extracted, activated or executed from unproven bytes.
 */

export interface VerifyOptions {
  readonly file: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
}

export interface VerifyResult {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export async function verifyArtifact(opts: VerifyOptions): Promise<VerifyResult> {
  let size: number;
  try {
    size = (await stat(opts.file)).size;
  } catch (err) {
    throw new UniDmError("toolkit_fetch_failed", `staged artifact vanished before verify: ${String(err)}`);
  }
  if (size !== opts.expectedSizeBytes) {
    await unlink(opts.file).catch(() => undefined);
    throw new UniDmError(
      "toolkit_checksum_mismatch",
      `staged artifact is ${size} bytes, manifest pins ${opts.expectedSizeBytes}`,
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(opts.file)) {
    hash.update(chunk as Buffer);
  }
  const actual = hash.digest("hex");
  if (actual !== opts.expectedSha256.toLowerCase()) {
    await unlink(opts.file).catch(() => undefined);
    throw new UniDmError(
      "toolkit_checksum_mismatch",
      `sha256 mismatch: staged ${actual}, manifest pins ${opts.expectedSha256.toLowerCase()}`,
    );
  }
  return { sha256: actual, sizeBytes: size };
}
