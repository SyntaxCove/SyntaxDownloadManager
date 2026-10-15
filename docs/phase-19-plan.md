# Phase 19 Plan — Packaging (electron-builder NSIS installer + portable zip)

Status: PLANNED (2026-10-15). Prior state: Phases 0–18 delivered and verified; repository
published at github.com/SyntaxCove/SyntaxDownloadManager (v0.5.0 = phases 0–18 snapshot).
Contracts stay **1.13.0** (packaging adds zero IPC/core surface). App version 0.5.0 →
**0.6.0** (root + desktop; the Rust workspace is already 0.6.0). electron-updater 6.8.10
(Phase 18) is the transport; the electron-builder line it pairs with is **26.15.3**
(current stable, pinned exact).

## Scope

1. **electron-builder config (apps/desktop/electron-builder.json)** producing, for
   Windows x64:
   - **NSIS assisted installer** (`SyntaxDownloadManager-Setup-<version>.exe`):
     `oneClick: false`, per-user install (no UAC), editable install dir, desktop +
     Start-menu shortcuts, run-after-finish. `deleteAppDataOnUninstall: false` — the
     download database is user data; uninstall must never destroy it (data integrity
     outranks tidiness).
   - **Portable zip** (`SyntaxDownloadManager-<version>-portable.zip`): the win `zip`
     target — a real unpack-and-run folder, per the product requirement that the portable
     distribution be a zip, not a single-file portable exe.
   - `appId com.syntaxdm.desktop` (matches the Phase 17 AppUserModelID), `productName
     "Syntax Download Manager"`, space-free `executableName "SyntaxDownloadManager"`.
   - `publish: {provider: github, owner: SyntaxCove, repo: SyntaxDownloadManager}` —
     electron-builder then generates `resources/app-update.yml` at package time, which is
     exactly the packaged feed source the Phase 18 controller resolves (fail-closed).
2. **Packaged layout — already pinned by the code; zero main-process changes.** The
   Phase 2–10 code fixes the packaged contract (`appRoot = process.resourcesPath`):
   - `resources/dist/renderer/**` + `resources/dist/preload/preload.cjs` (real files,
     outside asar — extraResources),
   - `resources/toolchains.json` + `resources/syntaxdm-tray.png` (extraResources, flat),
   - `resources/bin/download-core/download-core.exe` (extraResources; the Rust core is
     spawned as a child process and must never live inside asar),
   - `app.asar`: `package.json` + `dist/main/**` + production runtime deps
     (`@syntaxdm/contracts`, `electron-updater`, `yauzl`, `tar-stream`, `lzma-native`;
     the native module unpacked).
3. **Installer icon** — a proper multi-resolution `build/icon.ico` (16–256 px) generated
   from the Phase 17 tray artwork by `scripts/gen-app-icon.py` (Pillow), committed as a
   source asset. No screenshot-grade raster surprises: single provenance script.
4. **Build orchestration** — desktop `npm run dist` (electron-builder `--win nsis zip`),
   root `npm run dist:win`, and **scripts/build-windows.ps1**: the canonical user-side
   one-shot (npm install → build → `cargo build --release` → copy
   `download-core.exe` into `apps/desktop/build/core/` → electron-builder). Artifacts land
   in `apps/desktop/release/` (already gitignored).
5. **Sandbox validation by real cross-build** — the ground rule "installer builds happen on
   the user's device" stays true for *supporting* the flow; this phase additionally
   validates the entire config by actually producing Windows artifacts here: Rust core
   cross-compiled with the `x86_64-pc-windows-gnu` target (mingw-w64; reqwest is rustls —
   no OpenSSL in the chain), then `electron-builder --win nsis zip` on Linux (bundled
   makensis runs natively; signing skipped — documented honestly). Produced artifacts are
   attached to the v0.6.0 GitHub release; the user-side script remains the canonical path.
6. **Drift-guard test** — `package-layout.test.ts` asserts electron-builder.json's
   `files`/`extraResources` produce exactly the paths `paths.ts` +
   `resolveCoreBinaryPath` + `main.ts` expect in packaged mode, so a future rename cannot
   silently break the installer again.

## Non-goals

- Code signing / Authenticode (needs a certificate; release-engineering phase, documented
  as the authenticity upgrade path per the Phase 18 plan).
- Auto-update delivery wiring (uploading `latest.yml` alongside release assets happens at
  release engineering; the app-side channel is already complete and fail-closed).
- Linux/macOS targets (Windows-first product; the config is structured to add them later).

## Test plan

- Unit: the drift-guard layout test (config ⇄ code contract).
- Build: full `verify-all` gate (typecheck, vitest, vite build, cargo fmt/clippy/test).
- Packaging: electron-builder completes for both targets from this sandbox; artifact
  inventory check (installer exe exists, zip contains `dist/`, `bin/download-core/
  download-core.exe`, `toolchains.json`, tray icon at the exact packaged paths).

## Risks

- electron-builder collecting workspace-hoisted dependencies into asar — verified
  empirically by the sandbox build; fallback is explicit `files` entries.
- mingw cross-compile of bundled SQLite (cc) and ring — time-boxed; if blocked, artifacts
  are produced user-side only and the report says so.
