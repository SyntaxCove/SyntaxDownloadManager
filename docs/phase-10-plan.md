# Phase 10 Plan — Bundled Media Toolkit (pinned FFmpeg / yt-dlp / Deno fetch + version manifest)

> Precondition verified: the Phase 0–9 gate is green (cargo 107, vitest 108, typecheck ×4,
> vite build) after the usual sandbox toolchain repair. Baseline commit: `697b6db` (phase 9).

## Goal

The end user never installs FFmpeg, yt-dlp or Deno. The app ships a **version manifest**
that pins exact artifact versions + SHA-256 hashes per platform, and a **toolkit manager**
in the Electron main process that fetches, verifies, extracts and activates the tools into
the user profile, then pushes the resolved executable paths into the Rust core for
Phases 11–12 (media inspect / merge).

Design center (per engineering priority): **data integrity** (no byte is executed or kept
without a proven SHA-256) → **security** (zip-slip / symlink-escape rejected, checksum
mismatch never activates, fail-closed everywhere) → **reliability** (retry with backoff,
staging + atomic activation, registry rebuild from disk scan) → correctness.

## Non-goals

- Not the installer packaging itself (Phase 19 decides whether the tools dir is pre-seeded
  from installer resources; the manager accepts an already-populated dir).
- Not yt-dlp self-update channels (pinned = exact; auto-update policy is a later phase).
- No media functionality yet — `media.inspect` lands in Phase 11 on top of these paths.

## Contract v1.5.0 (additive)

New domain `toolkit.ts`:

- `ToolId = "ffmpeg" | "yt-dlp" | "deno"`; `PlatformKey = "win32-x64" | "linux-x64"`.
- `ToolkitArtifact`: { url (https only), sha256 (64 hex), sizeBytes, archiveType
  (`none|zip|tar.xz`), execPath (relative, forward slashes), optional extraExecs[] }.
- `ToolkitToolSpec`: { id, version, platforms: Record<PlatformKey, ToolkitArtifact> }.
- `ToolkitManifest`: { manifestVersion: 1, tools: ToolkitToolSpec[] (≤16) }.
- `ToolkitToolStatus`: { id, version, state (`missing|fetching|verifying|ready|failed`),
  path (null unless ready), bytesFetched, totalBytes (null for non-fetch states),
  errorCode (null | string), message (null) }.
- `ToolkitStatusResult`: { manifestVersion, platform, tools[] }.
- Main methods: `toolkit.getStatus` {} → status; `toolkit.ensureAll` {} → { started: ToolId[] };
  `toolkit.ensure` { id }; `toolkit.cancel` { id } (in-flight only).
- Core method: `toolkit.setPaths` { tools: [{ id, version, path }] } → { applied: true }
  — full replace of the core's in-memory toolkit map (main is the single source of truth;
  only checksum-proven tools cross this boundary).
- Event: `toolkit.progress` (main → renderer) with `ToolkitToolStatus` (throttled ≥200 ms
  except on state transitions).
- Error codes (append-only): `toolkit_unsupported_platform`, `toolkit_manifest_invalid`,
  `toolkit_fetch_failed`, `toolkit_extract_failed`, `toolkit_checksum_mismatch`.
- Settings: `mediaToolsAutoFetch` boolean, default true (v1.5 additive with default).
- Fixtures: `toolkitManifest` (trimmed 1-tool), `toolkitStatus`, `toolkitPaths` (setPaths
  params) added to `fixtures/domain.json`; consumed by vitest AND cargo test.

## Architecture

```
toolchains.json (app resources, pinned + hashed at pin time by scripts/pin-toolchains.mjs)
        │ zod-validated at load (fail-closed: toolkit_manifest_invalid)
        ▼
ToolkitManager (main) ── state machine per tool: missing→fetching→verifying→ready|failed
   │ fetch: Node 24 global fetch, streamed to tools/.staging/<id>-<ver>.part
   │   retry ×3 exponential backoff, hard size cap (sizeBytes + 1 MiB), progress events
   │ verify: streaming SHA-256 + exact byte length (mismatch → delete, failed, never activate)
   │ extract: zip (yauzl) / tar.xz (lzma-native + tar-stream), escape-guarded
   │ activate: rename staging → tools/<id>/<version>/, prune older versions, persist registry
   ▼
userData/toolkit-state.json (atomic tmp+rename, corrupt → quarantine, rebuilt from disk scan)
        │ toolkit.setPaths (only ready tools) — re-pushed after every core restart
        ▼
Rust core ToolkitPaths (in-memory, mirror of the Phase 9 ProxyMap pattern)
```

- Windows executables: `yt-dlp.exe` (PyInstaller standalone — no Python needed), ffmpeg +
  ffprobe from the pinned essentials build, `deno.exe`. Linux sandbox mirrors the pipeline
  with linux-x64 artifacts (yt-dlp PyInstaller, Deno zip, FFmpeg static tar.xz) so the whole
  flow is exercised headlessly; `chmod +x` applied on non-win32.
- The manifest ships with the app (dev: `apps/desktop/resources/toolchains.json`; packaged:
  `process.resourcesPath`). A platform key missing for the running platform surfaces as
  `toolkit_unsupported_platform` on `toolkit.ensure`, and `missing/unsupported` in status.

## Security & integrity gates

1. Manifest rejected unless every URL is https and every sha256 is 64-hex (zod).
2. Downloaded bytes are hashed while streaming; `toolkit_checksum_mismatch` deletes the
   staging file and never activates. Byte length must equal `sizeBytes` exactly.
3. Extraction entries: path traversal (`..`, absolute, drive-qualified) and symlink escapes
   are rejected with `toolkit_extract_failed` before any write lands outside the staging
   root; nothing outside the staging dir is ever written.
4. Executables are activated ONLY via the registry; the core receives paths exclusively from
   main's post-verification push. No path input ever flows renderer → core directly.
5. Download cap (sizeBytes + 1 MiB) aborts runaway/hijacked streams mid-flight.

## Implementation files

- contracts: `src/domain/toolkit.ts` (+ index/version/errors/settings/registries wiring),
  fixtures, `test/contracts.test.ts` cases.
- main: `src/main/toolkit/{manifest,fetcher,verify,extract,manager}.ts`,
  `src/main/domains/toolkit.ts` (IPC + core push), `paths.ts` (+ toolchainsManifestPath),
  `main.ts` wiring (load, auto-ensure when `mediaToolsAutoFetch`, re-push on core ready).
- renderer: `stores/toolkit.ts`, SettingsPage "Media toolkit" section (per-tool state chips,
  progress bar, Install/Retry/Cancel, auto-fetch toggle).
- core: `src/toolkit.rs` (ToolkitPaths), `manager.rs` forward, `server.rs` arm,
  dc-protocol error codes + `CONTRACT_VERSION` → 1.5.0.
- resources: `apps/desktop/resources/toolchains.json` — authored live by the pin script.
- scripts: `scripts/pin-toolchains.mjs` (maintainer: fetch pinned artifacts, measure size,
  compute sha256, write manifest; cross-checks yt-dlp against its published SHA2-256SUMS).
- deps (exact pins, desktop app): `yauzl` (zip read), `lzma-native` + `tar-stream`
  (tar.xz), dev-only `yazl` (test fixture zip writer).

## Test plan

- contracts: fixture parse + wire shape; https/hex regex rejections; settings default.
- main `toolkit-manifest.test.ts`: valid load, corrupt rejection, platform resolution,
  unsupported platform error.
- main `toolkit-pipeline.test.ts` (local http server): happy path (zip + tar.xz) → ready +
  registry + exec bits + core push; checksum mismatch; truncated stream; retry-then-success;
  size cap; zip-slip rejection; tar symlink escape; cancel mid-fetch; registry corrupt →
  quarantine + rebuild; double-ensure is idempotent; prune of old versions.
- core: `toolkit.setPaths` round-trip + wholesale replace semantics; fixture parity.
- Live (this session, maintainer-side): run the pin script for real — proves every pinned
  URL is reachable and hashes are reproducible; yt-dlp hash cross-checked against the
  official SHA2-256SUMS of that release.
- Verification gate: cargo fmt/clippy/test, vitest, typecheck ×4, vite build — all green.

## Risks

- Network flakiness during the live pin run → retry per artifact; hashes are computed
  locally so a re-run is deterministic.
- yauzl/tar-stream API quirks → keep extract.ts small, dependency-free of Electron, fully
  unit-tested with crafted archives.
- Total pinned artifact size (~250 MB) is a one-time maintainer cost, not user setup.
