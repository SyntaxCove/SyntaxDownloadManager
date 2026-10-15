#!/usr/bin/env node
/**
 * Syntax Download Manager maintainer tool: pin the bundled media toolkit (Phase 10).
 *
 * Resolves the current stable release of each tool (GitHub atom feeds — the REST API is
 * rate-limited), downloads the artifacts for BOTH platforms (win32-x64 + linux-x64),
 * measures the exact byte size, computes SHA-256 over the REAL bytes, verifies the pinned
 * exec path exists inside the archive, and writes apps/desktop/resources/toolchains.json.
 *
 * Supply-chain cross-checks where upstream publishes sums:
 *  - yt-dlp: the release's SHA2-256SUMS asset must match our measured hash;
 *  - deno:   the release's sha256sums asset (when present) must match.
 *
 * Re-running re-pins "current stable" for every tool; the resulting manifest is committed
 * so end users always get byte-identical, checksum-proven artifacts.
 *
 * Usage: node scripts/pin-toolchains.mjs [--cache DIR]
 */

import { createHash } from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const CACHE = (() => {
  const i = process.argv.indexOf("--cache");
  return i > -1 ? process.argv[i + 1] : join(tmpdir(), "syntaxdm-pin-cache");
})();
const MANIFEST_OUT = fileURLToPath(new URL("../apps/desktop/resources/toolchains.json", import.meta.url));

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Syntax Download Manager pin tool" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

/** Latest release tag from the GitHub atom feed, filtered by a predicate. */
async function latestTag(repo, predicate) {
  const xml = await fetchText(`https://github.com/${repo}/releases.atom`);
  const tags = [...xml.matchAll(/releases\/tag\/([^<"/]+)/g)].map((m) => decodeURIComponent(m[1]));
  const tag = [...new Set(tags)].find(predicate);
  if (!tag) throw new Error(`${repo}: no release tag matching the predicate (saw: ${tags.slice(0, 8).join(", ")})`);
  return tag;
}

/** Asset file names attached to a release (public page fragment; no API quota). */
async function releaseAssets(repo, tag) {
  const html = await fetchText(`https://github.com/${repo}/releases/expanded_assets/${tag}`);
  const names = [...html.matchAll(/download\/[^"]*?\/([^"/]+\.(?:zip|tar\.xz|7z|txt))"/g)].map((m) => m[1]);
  return [...new Set(names)];
}

const downloadUrl = (repo, tag, asset) => `https://github.com/${repo}/releases/download/${tag}/${asset}`;

async function fetchToCache(url, name) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, name);
  try {
    const s = await stat(file);
    if (s.size > 0) {
      console.log(`  [cache] ${name} (${s.size} bytes)`);
      return file;
    }
  } catch {
    /* not cached yet */
  }
  console.log(`  [fetch ] ${name} …`);
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Syntax Download Manager pin tool" } });
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

async function hashFile(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

async function unzipList(file) {
  const yauzl = await import("yauzl");
  return new Promise((res, rej) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return rej(err);
      const names = [];
      zip.on("entry", (e) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on("end", () => res(names));
      zip.on("error", rej);
      zip.readEntry();
    });
  });
}

async function untarList(file) {
  const lzma = await import("lzma-native");
  const tar = await import("tar-stream");
  const names = [];
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    names.push(header.name);
    stream.resume();
    next();
  });
  await pipeline(createReadStream(file), lzma.createDecompressor({ threads: 1 }), extract);
  return names;
}

/** Cross-check a measured hash against an upstream SHA2-256SUMS document. */
function assertUpstreamSum(sumsDoc, fileName, measured) {
  if (!sumsDoc) return;
  const line = sumsDoc
    .split("\n")
    .find((l) => l.trim().split(/\s+/).pop()?.replace(/^\*/, "") === fileName);
  if (!line) return; // upstream does not list this file — pin our measurement
  const upstream = line.trim().split(/\s+/)[0].toLowerCase();
  if (upstream !== measured) {
    throw new Error(
      `SUPPLY-CHAIN CHECK FAILED for ${fileName}: upstream ${upstream} != measured ${measured}`,
    );
  }
}

// ---- per-tool pinning ----

async function pinYtDlp() {
  console.log("[yt-dlp] resolving latest stable release …");
  const tag = await latestTag("yt-dlp/yt-dlp", (t) => /^\d{4}\.\d{2}\.\d{2}$/.test(t));
  const version = tag;
  const platforms = {};
  let sumsDoc = null;
  try {
    sumsDoc = await fetchText(downloadUrl("yt-dlp/yt-dlp", tag, "SHA2-256SUMS"));
  } catch {
    console.log("  (no upstream SHA2-256SUMS found — pinning our measurement)");
  }
  for (const [key, assetName] of [
    // PyInstaller standalones ONLY: the end user must never need Python on the host.
    ["win32-x64", "yt-dlp.exe"],
    ["linux-x64", "yt-dlp_linux"],
  ]) {
    const url = downloadUrl("yt-dlp/yt-dlp", tag, assetName);
    const file = await fetchToCache(url, `yt-dlp-${version}-${assetName}`);
    const sha256 = await hashFile(file);
    assertUpstreamSum(sumsDoc, assetName, sha256);
    const { size: sizeBytes } = await stat(file);
    console.log(`  ${key}: ${version} ${sizeBytes}B sha256=${sha256.slice(0, 16)}…`);
    platforms[key] = { url, sha256, sizeBytes, archiveType: "none", execPath: assetName };
  }
  return { id: "yt-dlp", version, platforms };
}

async function pinDeno() {
  console.log("[deno] resolving latest stable release …");
  const tag = await latestTag("denoland/deno", (t) => /^v\d+\.\d+\.\d+$/.test(t));
  const version = tag.replace(/^v/, "");
  const assets = await releaseAssets("denoland/deno", tag);
  const sumsName = assets.find((n) => /sha256/i.test(n));
  const sumsDoc = sumsName ? await fetchText(downloadUrl("denoland/deno", tag, sumsName)) : null;
  const platforms = {};
  for (const [key, assetName] of [
    ["win32-x64", "deno-x86_64-pc-windows-msvc.zip"],
    ["linux-x64", "deno-x86_64-unknown-linux-gnu.zip"],
  ]) {
    if (sumsDoc === null && !assets.includes(assetName)) {
      throw new Error(`deno ${tag} lacks asset ${assetName} (have: ${assets.slice(0, 10).join(", ")})`);
    }
    const url = downloadUrl("denoland/deno", tag, assetName);
    const file = await fetchToCache(url, `deno-${version}-${assetName}`);
    const sha256 = await hashFile(file);
    assertUpstreamSum(sumsDoc, assetName, sha256);
    const { size: sizeBytes } = await stat(file);
    const names = await unzipList(file);
    const execPath = key === "win32-x64" ? "deno.exe" : "deno";
    if (!names.some((n) => n.split("/").pop() === execPath)) {
      throw new Error(`deno zip lacks ${execPath} (entries: ${names.slice(0, 5).join(", ")}…)`);
    }
    console.log(`  ${key}: ${version} ${sizeBytes}B sha256=${sha256.slice(0, 16)}…`);
    platforms[key] = { url, sha256, sizeBytes, archiveType: "zip", execPath };
  }
  return { id: "deno", version, platforms };
}

async function pinFfmpeg() {
  console.log("[ffmpeg] resolving latest BtbN autobuild release …");
  const repo = "BtbN/FFmpeg-Builds";
  const tag = await latestTag(repo, (t) => /^autobuild-/.test(t));
  const assets = await releaseAssets(repo, tag);
  const pick = (platform) => {
    const name = assets.find((n) => new RegExp(`^ffmpeg-N-[^/]+-${platform}-gpl\\.${platform === "win64" ? "zip" : "tar\\.xz"}$`).test(n));
    if (!name) throw new Error(`BtbN ${tag} lacks a ${platform}-gpl archive (have: ${assets.slice(0, 12).join(", ")})`);
    return name;
  };
  const winAsset = pick("win64");
  const linuxAsset = pick("linux64");
  const winVer = winAsset.match(/^ffmpeg-(N-[^/]+?)-win64/)?.[1];
  const linuxVer = linuxAsset.match(/^ffmpeg-(N-[^/]+?)-linux64/)?.[1];
  const version = winVer && winVer === linuxVer ? winVer : tag;
  const platforms = {};

  {
    const url = downloadUrl(repo, tag, winAsset);
    const file = await fetchToCache(url, `ffmpeg-${winAsset}`);
    const sha256 = await hashFile(file);
    const { size: sizeBytes } = await stat(file);
    const names = await unzipList(file);
    const exec = names.find((n) => /\/ffmpeg\.exe$/.test(n));
    const probe = names.find((n) => /\/ffprobe\.exe$/.test(n));
    if (!exec) throw new Error("win64 zip lacks ffmpeg.exe");
    console.log(`  win32-x64: ${version} ${sizeBytes}B sha256=${sha256.slice(0, 16)}…`);
    platforms["win32-x64"] = {
      url,
      sha256,
      sizeBytes,
      archiveType: "zip",
      execPath: exec,
      extraExecs: probe ? [probe] : [],
    };
  }

  {
    const url = downloadUrl(repo, tag, linuxAsset);
    const file = await fetchToCache(url, `ffmpeg-${linuxAsset}`);
    const sha256 = await hashFile(file);
    const { size: sizeBytes } = await stat(file);
    const names = await untarList(file);
    const exec = names.find((n) => /\/ffmpeg$/.test(n));
    const probe = names.find((n) => /\/ffprobe$/.test(n));
    if (!exec) throw new Error("linux64 tar.xz lacks ffmpeg");
    console.log(`  linux-x64: ${version} ${sizeBytes}B sha256=${sha256.slice(0, 16)}…`);
    platforms["linux-x64"] = {
      url,
      sha256,
      sizeBytes,
      archiveType: "tar.xz",
      execPath: exec,
      extraExecs: probe ? [probe] : [],
    };
  }

  return { id: "ffmpeg", version, platforms };
}

async function main() {
  const tools = [await pinYtDlp(), await pinDeno(), await pinFfmpeg()];
  const manifest = { manifestVersion: 1, tools };
  await mkdir(dirname(MANIFEST_OUT), { recursive: true });
  await writeFile(MANIFEST_OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`\nmanifest written: ${MANIFEST_OUT}`);
  for (const t of tools) {
    for (const [plat, a] of Object.entries(t.platforms)) {
      console.log(`  ${t.id}@${t.version} ${plat}: ${a.sizeBytes}B ${a.sha256.slice(0, 12)}…`);
    }
  }
}

main().catch((err) => {
  console.error("PIN FAILED:", err.message);
  process.exit(1);
});
