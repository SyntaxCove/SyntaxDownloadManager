# Third-Party Notices

Syntax Download Manager is MIT-licensed (see `LICENSE`) but **bundles and ships**
third-party software. This file names what ships inside the distributed binaries; the
exact versions and hashes of everything below are recorded in the per-release SBOM
(`SyntaxDownloadManager-<version>-sbom.cdx.json`, CycloneDX 1.5 — attached to every
GitHub release since 0.17.0) and pinned in `apps/desktop/resources/toolchains.json`.

## Bundled binaries

| Component | Version shipped (at time of writing) | License | Source |
|-----------|--------------------------------------|---------|--------|
| FFmpeg (incl. ffprobe) — BtbN GPL auto-build | N-127259-gb91a82d6dd | GPL-3.0-or-later | https://github.com/BtbN/FFmpeg-Builds |
| yt-dlp | 2026.08.19 | Unlicense | https://github.com/yt-dlp/yt-dlp |
| Deno | 2.9.7 | MIT | https://github.com/denoland/deno |

These are separate executables invoked as subprocesses; bundling them is mere
aggregation and does not relicense this project. FFmpeg is used only through its CLI as
a media mux/inspect tool. yt-dlp is used only as an extraction helper; this project adds
no DRM circumvention of any kind. Each binary is verified at fetch time against the
sha256 pinned in the toolchains manifest before it is adopted.

## Runtime (app.asar)

- **Electron** (Chromium/Node runtime) — MIT — https://github.com/electron/electron
- **electron-updater** — MIT — https://github.com/electron-userland/electron-builder
- **@syntaxdm/contracts** — first-party (this repository), which brings **zod** — MIT
- **lzma-native** — MIT/LGPL — https://github.com/addaleax/lzma-native
- **tar-stream**, **yauzl**, **yazl** — MIT — archive readers/writers for bundled-tool staging

## Renderer bundle (Vite-bundled into app.bundle.js)

- **react**, **react-dom** — MIT — https://react.dev
- **zustand** — MIT — https://github.com/pmndrs/zustand
- **@fluentui/react-components**, **@fluentui/react-icons** — MIT — https://react.fluentui.dev

## Rust core (download-core)

All crate dependencies are recorded — with their Cargo.lock sha256 checksums — in the
per-release SBOM (`pkg:cargo/*` components). Notable third-party crates: **tokio**
(MIT), **reqwest/hyper/rustls** (MIT/Apache-2.0), **rusqlite/libsqlite3-sys** (MIT),
**serde/serde_json** (MIT/Apache-2.0). The complete, version-exact list for any given
release is the SBOM; `core/Cargo.lock` in the matching tag is the authoritative source.

## npm components

License identifiers for every npm component are carried inside the per-release SBOM
(taken from `package-lock.json`). The SBOM is the authoritative machine-readable
inventory; this file is the human-readable summary.

## Tooling (not shipped)

Build/test tooling — TypeScript, Vite, esbuild, vitest, electron-builder, cargo/rustc —
is used to produce the artifacts but is not distributed inside them and is therefore
excluded from the SBOM by design (scoping statement in the SBOM metadata).
