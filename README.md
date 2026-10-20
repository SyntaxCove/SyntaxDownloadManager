# Syntax Download Manager

[![ci](https://github.com/SyntaxCove/SyntaxDownloadManager/actions/workflows/ci.yml/badge.svg)](https://github.com/SyntaxCove/SyntaxDownloadManager/actions/workflows/ci.yml)

A production-grade **Windows 11 x64 desktop application** that fuses a Chromium-based browser with an advanced, resumable download manager — powered by a supervised **Rust core** process. Think "1DM-class" downloading, built natively for Windows 11.

- **Unified browser** — real tabbed browsing on Electron `WebContentsView` with Fluent UI tabs, address bar, bookmarks, history, and per-tab proxy routing
- **Advanced download engine** — segmented, multi-connection, byte-exactly resumable HTTP downloads with integrity gates and a full recovery/rebinding engine
- **Zero extra installs for end users** — FFmpeg, yt-dlp, Deno, and a native BitTorrent stack ship **inside** the app; nothing else to download

> **Status:** **1.1.0** — all 31 development phases are delivered and fully tested; the
> phase map (`docs/PHASES.md`) is complete, and post-1.0 iterations continue on top
> (phase 32: an editable, localized **browser user agent** in Settings plus the fix for
> the browser pane not filling the window in browse mode). Windows x64
> packaging is in place (electron-builder NSIS installer + portable zip) — releases are
> built **by the CI artifact pipeline** (GitHub Actions, Windows runner) and published
> with **SHA-256 checksums** on the
> [releases page](https://github.com/SyntaxCove/SyntaxDownloadManager/releases)
> (see [Releases & checksums](#releases--checksums)); the installer exe can also be built
> from source via [`scripts/build-windows.ps1`](scripts/build-windows.ps1)
> (see [Run on Windows](#run-on-windows)). Built-in **Diagnostics** (structured logs, log
> export, health report) shipped with phase 20, phase 21 added full **interface
> localization — English and Persian (فارسی, RTL) — with an accessibility pass** (live
> language switching, Jalali/Persian dates and digits, keyboard-operable tab strips and
> format tables, skip-to-content, ARIA-complete controls), phase 22 turned **performance
> into enforced budgets**, phase 23 delivered a full **security audit** — sender
> firewall hardening (session identity + exact packaged origin), http/https-only OS
> handoffs, deny-by-default permission checks, a global webview attach ban, and an
> explicit hardened `webPreferences` policy on every browsing surface — and phase 24
> **hardened the system under fault injection**: bounded request framing in the Rust
> core (4 MiB lines, 64 in-flight, content never echoed), bounded renderer crash
> recovery (3 reloads per 60 s, never a reload loop), and storage corruption drills
> (garbage input fails typed, corruption never reports a false-green integrity check).
> Phase 26 turned delivery itself into engineering: a **CI gate on GitHub Actions**
> (the full headless verification plus a Windows MSVC core-test job), a **tag-triggered
> artifact pipeline** that builds the Windows installer and portable zip through the
> documented packaging script on a real Windows runner, and **SHA-256 checksums** for
> every shipped binary. Phase 27 added a fully localized **in-app Help surface** — topic
> guides, FAQ and step-by-step troubleshooting that speak the engine's own typed error
> vocabulary, in English and Persian (RTL). Phases 28–31 closed the map: a **data-integrity
> validation sweep**, a **real-device budget report harness**, the **security & privacy final
> review** with a shipped CycloneDX SBOM, and the **1.0.0** final-QA gate + release.

---

## Table of contents

- [Feature highlights](#feature-highlights)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Verification gate](#verification-gate)
- [Run on Windows](#run-on-windows)
- [Releases & checksums](#releases--checksums)
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
- Vitest suites for `@syntaxdm/contracts` and `@syntaxdm/desktop` — including the **E2E
  suites** (`apps/desktop/src/e2e`) that boot the real main-process composition over the
  real Rust core binary and drive complete user stories (download lifecycle with real
  bytes and HTTP Range resume, persistence across core death, renderer stores over the
  live event stream, scheduler/history storage) headlessly
- `vite build` production bundle
- `cargo fmt --check`, `cargo clippy`, `cargo test` for the Rust workspace
- `node scripts/checksums.mjs --selftest` — the Phase 26 release-engineering tooling
  drills its own digest math, sidecar format and failure modes
- `node scripts/sbom.mjs --selftest` — the Phase 30 SBOM generator proves its own
  structural invariants (shipped-component inventory, dev-only exclusion)
- `node scripts/final-qa.mjs` — the Phase 31 final-QA gate: the app version agrees
  across every manifest and lockfile, the contracts wire version is consistent, and
  the phase map is fully delivered with a report per phase

The same gate runs on **GitHub Actions** (`.github/workflows/ci.yml`) on every push and
pull request, plus a Windows MSVC job that runs the Rust core suite on the shipping
platform — the sandbox gate and the CI gate are one and the same.

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

## Releases & checksums

Tagging a release (`v*`) triggers `.github/workflows/release.yml`: a Windows runner
checks that the tag matches `package.json`, runs the exact same
[`scripts/build-windows.ps1`](scripts/build-windows.ps1) a human would run
(contracts + desktop + Rust core in release mode + electron-builder), generates a
CycloneDX 1.5 **SBOM** from the exact sources being released, computes SHA-256
checksums over the produced bytes, and publishes the GitHub release with every asset
attached — the installer, the portable zip, the differential-update blockmaps, the
`SyntaxDownloadManager-<version>-sbom.cdx.json` software bill of materials, the
`latest.yml` auto-update feed, and a `.sha256` sidecar for each binary artifact.

Every published release notes carries a checksum table. Verify your download before
running it:

```powershell
# Windows (PowerShell)
Get-FileHash .\SyntaxDownloadManager-<version>-portable.zip
# compare against the SHA-256 in the release notes, or:
sha256sum -c SyntaxDownloadManager-<version>-portable.zip.sha256   # if you have Git for Windows
```

```bash
# Linux / macOS
sha256sum -c SyntaxDownloadManager-<version>-portable.zip.sha256
```

**Unsigned build notice:** binaries are not code-signed yet (no certificate). Windows
SmartScreen may show a warning on first run — choose "More info → Run anyway" if the
checksum matches, and see the phase 19 report for the planned signing upgrade path.

Continuous integration (`.github/workflows/ci.yml`) runs on every push and pull
request: the full headless verification gate (contracts, typecheck, desktop unit + E2E
suites over the real Rust core binary, fmt/clippy/cargo test, renderer build,
performance budget gate, checksum/SBOM selftests, runtime dependency audit,
final-QA gate) plus a Windows MSVC job that runs the Rust
core test suite on the shipping platform.

## Documentation

- [`docs/PHASES.md`](docs/PHASES.md) — the authoritative 0–31 phase map and build rules
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process architecture and key decisions
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting + security architecture in one page
- [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — bundled third-party software and licenses
- [`docs/security-privacy-review.md`](docs/security-privacy-review.md) — the final pre-1.0 security & privacy review (Phase 30)
- [`docs/phases/`](docs/phases/) — per-phase plans and reports (plan → implement → test → fix → document → review)
- [`worklog.md`](worklog.md) — the full, honest engineering work log

## Roadmap

Delivered: **all 31 phases — the map is complete** (scaffold, contracts, shell, browser engine, download core,
segmented engine, recovery, queue/bandwidth, proxies, media toolkit, media inspector,
media pipeline, torrents, library, scheduler, settings completion, notifications/tray,
auto-update, **packaging**, **diagnostics**, **accessibility + i18n fa/en**,
**performance budgets**, **security audit**, **hardening**, **E2E suites** — headless
renderer+main+core integration over the real Rust core binary, which found and fixed
three real defects including a silent wire-contract violation that had always disabled
`deletePartialFile` — **release engineering**: CI on GitHub Actions, a tag-triggered
Windows artifact pipeline through the documented packaging script, and SHA-256
checksums on every shipped binary — and **in-app help**: a localized Help page with
topic guides, FAQ and troubleshooting wired to the engine's real error codes — and a
**data-integrity validation sweep** that reconciles the segment journal against what is
actually on disk (external `.part` deletion/truncation, crash-between-rename windows,
power-loss durability) and honors every declared checksum algorithm, with the fix for each
of the four real defects the sweep found locked by adversarial tests — and a **real-device
budget report harness**: the Diagnostics page measures the running app against the shipped
performance budgets (core cold start, core memory — including a new Windows RSS sampler —
echo latency, bundle bytes, IPC dispatch, store hot path, queue ordering) and produces a
schema-checked, log-persisted pass/breach verdict report the user can copy or export).

Post-1.0 iterations continue on the same discipline. **Phase 32** added an editable,
localized **browser user agent** (Settings shows the effective UA with a default/custom
badge; the override persists, applies live to the browser and per-proxy tab sessions,
and resets to the Electron default) — and fixed the **browser pane fill** bug: the shell
collapsed to content width inside the row-flex `FluentProvider` wrapper, leaving most of
the window empty in browse mode (root-caused and regression-harnessed in real Chromium
via `scripts/layout-repro.cjs`).

Phase 31 closed the map as **1.0.0**: a codified final-QA gate (`scripts/final-qa.mjs`)
that keeps the app version aligned across every manifest and lockfile (enforced in CI
next to the checksum and SBOM selftests), the 1.0.0 version bump across all manifests,
and the v1.0.0 release through the artifact pipeline — installer, portable zip,
blockmap, auto-update feed, SBOM, each binary with a SHA-256 sidecar.

Phase 30 (delivered) completed the **security & privacy final review**: every Phase 23
trust boundary re-verified against current sources, the supply chain hardened (GitHub
Actions pinned to commit SHAs, tokenless checkouts, an `npm audit --omit=dev` hard gate
on shipped dependencies, a weekly scheduled `cargo-audit` + npm sweep — the sweep's
first run caught and fixed four rustls RustSec advisories), a deterministic
zero-dependency **CycloneDX 1.5 SBOM** now attached to every release with the full
shipped-component inventory (npm runtime + renderer closures, Electron, all Rust crates
with Cargo.lock hashes, the sha256-pinned bundled toolchains), plus `SECURITY.md`,
`THIRD-PARTY-NOTICES.md`, and a complete privacy data-flow inventory in
[`docs/security-privacy-review.md`](docs/security-privacy-review.md).

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
