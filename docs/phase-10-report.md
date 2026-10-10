# Phase 10 Report — Bundled Media Toolkit

> Status: **delivered (2026-10-10)** · Baseline: Phase 9 (`697b6db`) · Contract **v1.5.0** ·
> Plan: `docs/phase-10-plan.md`

## What was delivered

The end user never installs FFmpeg, yt-dlp or Deno. The app now ships a **version manifest**
with exact pinned versions + authoring-time SHA-256 hashes per platform, and a main-process
**ToolkitManager** that fetches → verifies → extracts → activates the tools into the user
profile, then pushes ONLY the checksum-proven executable paths into the Rust core.

### Pinned artifacts (authored live by `scripts/pin-toolchains.mjs`)

| Tool | Version | win32-x64 | linux-x64 | Source |
|------|---------|-----------|-----------|--------|
| yt-dlp | 2026.08.19 | `yt-dlp.exe` 17,840,399 B | `yt-dlp_linux` 40,446,224 B | GitHub release (PyInstaller standalones — no host Python) |
| deno | 2.9.7 | msvc zip 42,630,221 B | gnu zip 41,596,794 B | GitHub release |
| ffmpeg | N-127259-gb91a82d6dd | win64-gpl zip 200,234,231 B | linux64-gpl tar.xz 156,185,880 B | BtbN dated autobuild (permanent release assets) |

- yt-dlp hashes were **cross-checked against the official `SHA2-256SUMS`** of the release
  (both platforms MATCH). Deno/BtbN publish no sums file; our measured hash IS the pin.
- The manifest lives at `apps/desktop/resources/toolchains.json` (dev) /
  `resourcesPath/toolchains.json` (packaged) and is zod-validated at load — an invalid or
  missing manifest fails classified (`toolkit_manifest_invalid`), never silently.

### Pipeline (main process, `src/main/toolkit/`)

1. **fetch** (`fetcher.ts`) — streamed download hashing as it goes, hard byte cap
   (pin + 1 MiB) that cuts runaway streams mid-flight, ×3 attempts with backoff,
   AbortSignal-driven cancellation.
2. **verify** (`verify.ts`) — independent second pass over the FILE on disk: exact size +
   SHA-256 against the pin. Mismatch → `toolkit_checksum_mismatch`, staging deleted,
   nothing ever activated.
3. **extract** (`extract.ts`) — zip (yauzl) / tar.xz (lzma-native + tar-stream) with
   zip-slip/tar-escape guards (`safeJoin`), symlink/link entries rejected, parent
   directories materialized for file entries, exec bits set on non-win32.
4. **activate** (`manager.ts`) — atomic rename into `userData/tools/<id>/<version>/`,
   registry persisted (atomic tmp+rename, corrupt file quarantined), superseded versions
   pruned, paths pushed to the core; stale staging wiped at startup; registry entries whose
   executable vanished are dropped (fail-closed — unproven bytes are invisible).

### Wire surface (contracts v1.5.0, additive)

- `toolkit.getStatus` / `toolkit.ensureAll` / `toolkit.ensure` / `toolkit.cancel` (main) —
  status shape carries state machine (`missing → fetching → verifying → ready | failed`),
  throttled progress via the `toolkit.progress` event (≥200 ms; state transitions immediate).
- `toolkit.setPaths` (core) — full replace of the core's in-memory `ToolkitMap`
  (`download-core/src/toolkit.rs`, staged-validate-then-swap: a rejected push never leaves a
  partial map). Re-pushed after every core restart and after each activation.
- Error codes (append-only): `toolkit_unsupported_platform`, `toolkit_manifest_invalid`,
  `toolkit_fetch_failed`, `toolkit_extract_failed`, `toolkit_checksum_mismatch`.
- Settings: `mediaToolsAutoFetch` (default true) — startup auto-fetch of missing tools.
- Fixtures `toolkitManifest` / `toolkitStatus` / `toolkitPaths` shared by vitest and cargo.

### UI

Settings → "Media toolkit": per-tool card (label, pinned version, state badge, live
progress bar during fetch, Install / Cancel actions, classified failure message with the
error code) plus the auto-fetch toggle. The renderer is read-mostly: every lifecycle
decision stays in main, and no manifest URL or hash is exposed as an editable surface.

## Test evidence

- **Unit/fixture**: contracts 48 ✓ (v1.5 schemas, https-only URLs, 64-hex sha256, path
  traversal rejection in execPath/extraExecs, registry of servers, settings default).
- **Main-process suites** (`__tests__/toolkit-manifest.test.ts` 11,
  `toolkit-pipeline.test.ts` 13): real local **HTTPS** server (throwaway self-signed cert,
  test-process-only trust override) serving real archives built by yazl / tar-stream +
  lzma-native. Covered: raw-single-file + zip + tar.xz happy paths (registry, core push,
  exec bits); checksum mismatch; clean-short-body size gate; transient-failure retry
  (3 requests); size-cap cut; **zip-slip rejection via a hand-assembled hostile zip**
  (honest zip writers refuse traversal names); cancel mid-fetch; corrupt registry
  quarantine; vanished-executable drop; re-pin pruning; unsupported-platform
  classification; ensureAll idempotency.
- **LIVE opt-in E2E** (`toolkit-live.test.ts`, `RUN_LIVE_TOOLKIT=1`): the REAL manager
  against the REAL shipped manifest — all three production tools fetched from GitHub,
  hashes verified byte-exact, ffmpeg tar.xz extracted, everything activated **in 47 s**.
  Skipped by default to keep the CI gate offline/deterministic.
- **Core**: dc-protocol toolkit wire types + fixture parity; `ToolkitMap`
  staged-replace semantics (duplicates/empty rejected without partial apply);
  integration tests through the manager. cargo **115** tests total (was 107).

## Verification gate

cargo fmt ✓ · clippy `-D warnings` ✓ · cargo test **115 passed** ✓ · vitest **94 + 1 opt-in
live** ✓ · typecheck ×4 ✓ · vite build ✓

## Fixed during Test/Fix

- zod `z.record(PlatformKey, …)` is an exhaustive record — switched to `z.partialRecord`
  so a tool may legitimately ship for a subset of platforms.
- Zip entries need not carry explicit directory entries → always `mkdir` the parent chain
  before writing (was ENOENT on yazl-produced archives).
- ToolkitManager must derive the platform key from the INJECTED platform/arch (tests
  inject `darwin`), not process defaults.
- `ToolkitMap.replace` staged the whole set before swapping (the clear-then-insert draft
  left a partial map on a rejected push — caught by the fail-closed test).
- Test harness: `NODE_TLS_REJECT_UNAUTHORIZED=0` is set ONLY inside the live-pipeline test
  process to accept the throwaway certificate; production fetch keeps default trust.

## Security review notes

- https-only URLs + pinned hashes enforced by the contract schema itself; a checksum
  mismatch can never reach extraction, activation, or the core push.
- Escape guards run BEFORE any write; hostile archives were tested end-to-end.
- The renderer never receives manifest URLs or registry internals; the core never receives
  a path main did not verify.
- Downloads are capped; staging lives under `userData/tools/.staging` and is wiped at
  startup.

## Next

Phase 11 — media inspector/extractor (`media.inspect`, manifests) on top of these
verified tool paths. Phase 19 decides whether the installer pre-seeds the tools dir
(the manager already accepts an existing, registry-valid installation).
