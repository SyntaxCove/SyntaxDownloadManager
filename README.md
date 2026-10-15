# Syntax Download Manager

A production-grade **Windows 11 x64 desktop application** that fuses a Chromium-based browser with an advanced, resumable download manager — powered by a supervised **Rust core** process. Think "1DM-class" downloading, built natively for Windows 11.

- **Unified browser** — real tabbed browsing on Electron `WebContentsView` with Fluent UI tabs, address bar, bookmarks, history, and per-tab proxy routing
- **Advanced download engine** — segmented, multi-connection, byte-exactly resumable HTTP downloads with integrity gates and a full recovery/rebinding engine
- **Zero extra installs for end users** — FFmpeg, yt-dlp, Deno, and a native BitTorrent stack ship **inside** the app; nothing else to download

> **Status:** development phases 0–19 of 31 are delivered and fully tested. Windows x64
> packaging is in place (electron-builder NSIS installer + portable zip) — a portable zip
> ships on the [releases page](https://github.com/SyntaxCove/SyntaxDownloadManager/releases);
> the installer exe is built from source via [`scripts/build-windows.ps1`](scripts/build-windows.ps1)
> (see [Run on Windows](#run-on-windows)).

---

## Table of contents

- [Feature highlights](#feature-highlights)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Verification gate](#verification-gate)
- [Run on Windows](#run-on-windows)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Security & policy stance](#security--policy-stance)
- [License](#license)

## Feature highlights

### Downloads (the core of the product)

- **Persistent, resumable jobs** — every download is a durable database row. A download is never "lost" because a URL expired: the recovery engine re-acquires the source, validates it, and resumes with all received bytes kept.
- **Segmented multi-connection engine** — files split into segments downloaded in parallel, each with its own on-disk journal (`If-Range` / `Content-Range` integrity gates), window-capped writes, and clean-restart policy.
- **Streaming SHA-256 verification** — expected checksums are verified while streaming, with an explicit per-job verdict.
- **Recovery engine v2** — multi-signal revalidation (`Content-Length`, `ETag`, `Last-Modified`, `Content-Type`) before every resume; classified re-acquisition outcomes (`source_gone`, `source_forbidden`, `source_changed`); `download.recover` / `download.replaceUrl` / `download.retry` with a full rebind audit trail; checksum-arbitrated gap-fill that only fetches missing ranges.
- **Managed queue** — persisted queue positions with reorder, start-all/pause-all, auto-start parking, and a daily download window that pauses auto-started runs.
- **Bandwidth management** — token-bucket rate limiting; a global speed limit plus per-job speed limits, both live-updatable.

### Browser

- Tabbed browsing via `WebContentsView` (one sandboxed view per tab, `persist:browser` session), LRU tab activation, overlay bounds sync, popups open as tabs.
- Permission allow-list, hardened `url-input` normalization, browser history of settled main-frame http(s) visits, star/bookmarks with transactional ordering.
- Per-tab proxy routing.

### Media (video/audio extraction)

- **Bundled, pinned toolkit** — yt-dlp, FFmpeg, and Deno are resolved through a pinned manifest, fetched, hash-verified, extracted, and activated inside the app data directory. The user installs nothing.
- `media.inspect` runs the bundled yt-dlp (hardened argv spawn, timeout/cap guards, playlist classification) and projects a normalized, best-first `MediaManifest`.
- Media jobs pipeline: format selection → bundled yt-dlp stream downloads → FFmpeg mux — with byte-preserving resume (completed streams detected on disk and skipped).

### Torrents

- Native BitTorrent stack in the Rust core (no external client): bencode, v1 metainfo with traversal-proof paths, magnet parsing, HTTP(S) + UDP trackers (BEP 15/23), peer wire protocol (BEP 3) with per-piece SHA-1 verification, rarest-first piece picker with on-demand endgame, BEP 9/10 metadata exchange for magnets, BEP 5 DHT.
- **Fail-closed proxy routing** — when a torrent job is bound to a proxy, DHT/UDP traffic is suspended rather than allowed to leak direct.

### Proxies

- Proxy profiles stored with OS-keychain-backed secrets, per-tab and per-job routing, fail-closed runtime map (a missing profile pauses the job instead of falling back to a direct connection).

### Automation & shell integration

- **Scheduler** — persistent, recurring jobs (download create/start-all/pause-all, media download, torrent add) fired by a 1-second tick inside the core; wall-clock recurrence so DST/travel keeps fires at the same local time; catch-up after downtime; outcome recording; manual run-now.
- **Notifications & tray** — OS notifications (Windows toast identity via AppUserModelID), in-app toasts with a non-error budget, and a tray controller with live counts, start/pause-all, close-to-tray, and second-instance window reveal.
- **Auto-update** — fail-closed, HTTPS-validated update feed resolution (`SYNTAXDM_UPDATE_FEED_URL`), consent-gated download/install lifecycle, throttled progress, sanitized state snapshots.

### Privacy & correctness by design

- All state lives in a local SQLite database (WAL, `FULL` synchronous) owned by the Rust core — no telemetry, no cloud accounts.
- Contract-first IPC: every message crossing the renderer ↔ main ↔ core boundary is schema-validated at runtime against versioned contracts shared between TypeScript and Rust.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Renderer (React 19 + Fluent UI v9 + Zustand stores)               │
│      ↕ typed, validated IPC (preload bridge)                       │
│  Electron main (Node) — domains, tray, notifications, updater,     │
│  toolkit manager, supervised core lifecycle                        │
│      ↕ JSONL JSON-RPC over stdio (versioned contracts)             │
│  download-core (Rust, Tokio) — download engine, recovery, proxy,   │
│  media jobs, torrents (dc-bt), scheduler, SQLite storage           │
│      ↕ spawns & consumes                                           │
│  Bundled tools: yt-dlp + Deno, FFmpeg   (pinned, hash-verified)    │
└────────────────────────────────────────────────────────────────────┘
```

Key decisions:

- The **Rust core owns the database and all download state**; the Electron shell is a supervised frontend. If the core crashes, it is restarted with backoff and state is recovered from SQLite on boot.
- `packages/contracts` is the **single source of truth**: versioned TypeScript schemas mirrored crate-for-crate by the Rust `dc-protocol` crate, with cross-language fixtures tested on both sides.
- Everything user-visible lives behind additive-only contract versions — no breaking wire changes within a major version.

## Repository layout

```
├── apps/desktop/        Electron app: main (domains, core supervisor, IPC router,
│                        toolkit, tray, updater), preload bridge, React renderer
├── packages/contracts/  Versioned domain schemas, protocol envelopes, error codes,
│                        cross-language fixtures (TypeScript side)
├── core/                Rust workspace
│   ├── crates/download-core/   Binary: engine, recovery, proxy, media, scheduler, RPC server
│   ├── crates/dc-protocol/     Wire-type mirror of contracts (Rust side)
│   ├── crates/dc-storage/      SQLite storage layer + migrations
│   └── crates/dc-bt/           Native BitTorrent stack
├── docs/                Authoritative phase map, architecture decisions, per-phase reports
├── scripts/             Verification and tooling scripts
└── worklog.md           Full engineering work log (phase by phase)
```

## Development

Prerequisites:

- **Node.js ≥ 22** (npm workspaces; exact dependency versions are pinned in the lockfiles)
- **Rust (stable)** — only needed to build/test the core; `rustup` is the easiest route
- **Windows 11 x64** to run the GUI (the shell is Windows-first; headless verification also runs on Linux/CI)

```bash
# install (Electron binary downloads automatically on a normal machine)
npm install

# build the contracts package first (desktop typecheck needs its dist/)
npm run build:contracts

# typecheck every workspace
npm run typecheck

# run all TypeScript test suites (contracts + desktop)
npm test

# build renderer + main + preload bundles
npm run build

# run the Rust core test suite
npm run test:core
```

## Verification gate

Every phase lands only after `scripts/verify-all.sh` passes end to end:

- `tsc --noEmit` across all workspaces
- Vitest suites for `@syntaxdm/contracts` and `@syntaxdm/desktop`
- `vite build` production bundle
- `cargo fmt --check`, `cargo clippy`, `cargo test` for the Rust workspace

The suites cover the download engine (segmenting, resume, integrity, recovery, rebind),
proxy fail-closed routing, media pipeline parsing, torrent stack units, scheduler recurrence
and catch-up semantics, settings persistence and corruption quarantine, security policies
(CSP, permission allow-list, URL validation), tray/notification behavior, and the update
controller's fail-closed feed resolution.

## Run on Windows

Two supported paths:

### A. Build the installer / portable zip yourself (recommended)

```powershell
git clone https://github.com/SyntaxCove/SyntaxDownloadManager.git
cd SyntaxDownloadManager
.\scripts\build-windows.ps1
```

Requires Node.js ≥ 22 and a stock Rust stable toolchain. The script installs
dependencies, builds everything (contracts, Electron shell, Rust core in release mode),
and produces in `apps/desktop/release/`:

- `SyntaxDownloadManager-Setup-<version>.exe` — assisted, per-user installer (no admin
  required; uninstalling never deletes your download database)
- `SyntaxDownloadManager-<version>-portable.zip` — unpack anywhere and run

### B. Run directly from source

```powershell
npm install
npm run build
npm start
```

First launch creates the local database and (for media features) fetches the pinned
toolkit bundle. All download/browser/media features work from a source checkout.

## Documentation

- [`docs/PHASES.md`](docs/PHASES.md) — the authoritative 0–31 phase map and build rules
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process architecture and key decisions
- [`docs/phases/`](docs/phases/) — per-phase plans and reports (plan → implement → test → fix → document → review)
- [`worklog.md`](worklog.md) — the full, honest engineering work log

## Roadmap

Delivered: **phases 0–19** (scaffold, contracts, shell, browser engine, download core,
segmented engine, recovery, queue/bandwidth, proxies, media toolkit, media inspector,
media pipeline, torrents, library, scheduler, settings completion, notifications/tray,
auto-update, **packaging**).

Next: **phase 20 — diagnostics** (structured logs, log export, health report), followed by
the remaining phases in `docs/PHASES.md`.

## Security & policy stance

- **No DRM or paywall circumvention.** Media extraction uses publicly available tooling
  against content the user has legitimate access to; the app never attempts to defeat
  content protection.
- **No AI features.** Nothing in the pipeline calls model services; everything is local
  and deterministic.
- **Hardened by default** — sandboxed renderer, strict CSP, validated typed IPC on every
  boundary, permission allow-lists, hardened argv spawns for bundled tools, and
  fail-closed proxy routing that prefers pausing over leaking traffic.
- **Local-first storage** — all user data (jobs, history, settings, proxy secrets) stays
  in a local SQLite database and the OS keychain.

## License

This project is licensed under a custom permissive license: the standard **MIT** grant,
plus an **attribution requirement** and a **project-name reservation**.

In short:

- You may freely use, modify, and redistribute this code — including commercially — as
  long as you **credit the original project** and keep the copyright notice.
- You may **not** name, brand, or promote a fork or derived product as
  **"Syntax Download Manager"** (or any shortened form of it) without written permission —
  forks must use their own name and branding.

See [`LICENSE`](LICENSE) for the exact text.
