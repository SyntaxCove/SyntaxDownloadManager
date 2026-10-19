#!/usr/bin/env node
// Phase 26 release engineering: SHA-256 checksums for shipped artifacts.
//
//   node scripts/checksums.mjs <file>... [--markdown <path>]
//     - computes SHA-256 for each file;
//     - writes a "<file>.sha256" sidecar in `sha256sum -c` format
//       ("<digest>  <basename>" — two spaces, the standard checksum listing);
//     - prints a Markdown table (and, with --markdown <path>, also writes it
//       to a file for embedding into release notes).
//
//   node scripts/checksums.mjs --selftest
//     - drills the checksum math, sidecar format, table rendering and the
//       missing-file failure in a temp dir. Run by CI (ci.yml) and by
//       scripts/verify-all.sh so the verification tooling is itself verified.
//
// Zero dependencies (node:crypto / node:fs / node:path only) so the release
// pipeline pulls nothing beyond the lockfile.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const READ_CHUNK = 4 * 1024 * 1024; // 4 MiB streaming reads — artifacts are ~170 MB

/** Stream a file through SHA-256 without loading it into memory. */
export function sha256File(path) {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null);
      if (n === 0) break;
      hash.update(n === READ_CHUNK ? buf : buf.subarray(0, n));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/**
 * Compute the digest and write the .sha256 sidecar next to the artifact.
 * Sidecar format matches `sha256sum` output: "<digest>  <basename>".
 * Returns { file, name, digest, sidecar, size }.
 */
export function checksumArtifact(path) {
  const abs = resolve(path);
  const size = statSync(abs).size; // throws (ENOENT) for missing files — fail loudly
  const digest = sha256File(abs);
  const name = basename(abs);
  const sidecar = `${abs}.sha256`;
  writeFileSync(sidecar, `${digest}  ${name}\n`, "utf8");
  return { file: abs, name, digest, sidecar, size };
}

/** Render the results as a Markdown table (release notes embed). */
export function markdownTable(rows) {
  const lines = [
    "## SHA-256 checksums",
    "",
    "| Artifact | Size (bytes) | SHA-256 |",
    "|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | ${r.size} | \`${r.digest}\` |`);
  }
  lines.push("");
  lines.push(
    "Verify a download: `sha256sum -c <file>.sha256` (Linux/macOS) or " +
      "`Get-FileHash <file>` in PowerShell and compare with the table above.",
  );
  return lines.join("\n");
}

/** --selftest: prove the math, the sidecar format, the table, the failures. */
export function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "syntaxdm-sha-"));
  try {
    const failures = [];
    const check = (label, ok) => {
      if (!ok) failures.push(label);
    };

    // 1. known vector: sha256("abc") — independently established digest
    const abcPath = join(dir, "abc.txt");
    writeFileSync(abcPath, "abc", "utf8");
    check(
      "known-vector abc",
      sha256File(abcPath) ===
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    // 2. empty input edge case (canonical empty SHA-256)
    const emptyPath = join(dir, "empty.bin");
    writeFileSync(emptyPath, Buffer.alloc(0));
    check(
      "empty-file digest",
      sha256File(emptyPath) ===
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    // 3. sidecar: exact sha256sum -c format, next to the artifact, base name only
    const bigPath = join(dir, "artifact.zip");
    writeFileSync(bigPath, Buffer.from("Syntax Download Manager artifact bytes"));
    const row = checksumArtifact(bigPath);
    const sidecarText = readFileSync(row.sidecar, "utf8");
    check(
      "sidecar format",
      sidecarText === `${row.digest}  artifact.zip\n` && existsSync(row.sidecar),
    );

    // 4. multi-chunk streaming: 9 MiB file spans several 4 MiB read chunks
    const multiPath = join(dir, "multi.bin");
    writeFileSync(multiPath, Buffer.alloc(9 * 1024 * 1024, 7));
    const expectedMulti = createHash("sha256")
      .update(Buffer.alloc(9 * 1024 * 1024, 7))
      .digest("hex");
    check("multi-chunk streaming", sha256File(multiPath) === expectedMulti);

    // 5. table: header + one row per artifact, name and digest embedded
    const table = markdownTable([row]);
    check("markdown table", table.includes("| `artifact.zip` |") && table.includes(row.digest));

    // 6. missing file must throw (ENOENT) — the pipeline fails loudly, never silently
    let threw = false;
    try {
      checksumArtifact(join(dir, "does-not-exist.bin"));
    } catch {
      threw = true;
    }
    check("missing file throws", threw);

    if (failures.length > 0) {
      console.error(`[checksums] selftest FAILED: ${failures.join("; ")}`);
      return false;
    }
    console.log("[checksums] selftest ok (6 checks)");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function usage() {
  console.error("usage: node scripts/checksums.mjs <file>... [--markdown <path>] | --selftest");
  process.exit(2);
}

function main(argv) {
  if (argv.includes("--selftest")) {
    process.exit(selftest() ? 0 : 1);
  }
  const mdIdx = argv.indexOf("--markdown");
  const mdOut = mdIdx >= 0 ? argv[mdIdx + 1] : undefined;
  const files = argv.filter((a, i) => a !== "--markdown" && i !== mdIdx + 1);
  if (files.length === 0) usage();

  const rows = [];
  let failed = false;
  for (const f of files) {
    try {
      const row = checksumArtifact(f);
      rows.push(row);
      console.log(`[checksums] ${row.name}: ${row.digest}`);
    } catch (err) {
      console.error(`[checksums] FAILED for ${f}: ${err?.message ?? err}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  const table = markdownTable(rows);
  console.log("\n" + table);
  if (mdOut) {
    writeFileSync(mdOut, table + "\n", "utf8");
    console.log(`[checksums] markdown table written to ${mdOut}`);
  }
}

main(process.argv.slice(2));
