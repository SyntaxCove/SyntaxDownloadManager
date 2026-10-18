# Syntax Download Manager — Phase Map (Authoritative)

> Reconstruction note: the original 65-section master prompt chunks and the phase documents of the
> previous sandbox session were lost to a sandbox reset. This file is the authoritative phase map
> going forward, reconstructed from the persisted specification summary. Phases are executed
> strictly in order; each phase follows Plan → Implement → Test → Fix → Document → Review → Commit.
> Engineering priority: data integrity > security > reliability/recovery > correctness >
> maintainability > performance > UX > feature breadth.

## Ground rules (from the master specification)

- Downloads are **persistent resumable jobs**: an expired URL never destroys the job or the bytes
  already downloaded. Recovery re-acquires a source, revalidates with multiple signals
  (Content-Length / ETag / Last-Modified / Content-Type), rebinds the job to the new source, and
  fills only the missing ranges.
- No AI features anywhere in the product.
- The end user must not install FFmpeg / Deno / Python / Node / yt-dlp / torrent client — all are
  bundled by later phases.
- No DRM or paywall circumvention of any kind. YouTube must never be blocked or degraded.
- Rust core (`download-core.exe` on Windows) is an independent supervised subprocess that owns the
  persistent database. Electron supervises it; the renderer never touches storage directly.
- Browser tabs use `WebContentsView` (never the deprecated `BrowserView`).
- Linux sandbox builds the full codebase and runs headless tests; Windows GUI execution and .exe
  installer builds happen on the user's device.

## Phase map

| # | Title | Status |
|---|-------|--------|
| 0 | Monorepo foundation, tooling, conventions, phase map | delivered (this session) |
| 1 | `packages/contracts` v1 — versioned domain schemas, protocol envelopes, cross-language fixtures | delivered (this session) |
| 2 | Electron main shell — lifecycle, security hardening, typed IPC router, preload bridge | delivered (this session) |
| 3 | Renderer foundation — Vite + React + Fluent UI v9, theme engine, app shell, settings persistence | delivered (this session) |
| 4 | Browser engine — `WebContentsView` tab manager, `browser.*` IPC, tab strip UI | delivered (this session) |
| 5 | Rust core v1 — stdio JSONL RPC, SQLite storage, supervised lifecycle, resumable HTTP engine, Downloads UI | delivered (this session) |
| 6 | Segmented multi-connection engine, per-segment journal, integrity (checksums) | delivered (2026-10-07) |
| 7 | Recovery engine v2 — source re-acquisition, multi-signal revalidation, rebind, gap-fill | delivered (2026-10-08) |
| 8 | Queue, scheduler policies, concurrency and bandwidth management | delivered (2026-10-08) |
| 9 | Proxy engine — profiles, per-tab / per-job routing | delivered (2026-10-10) |
| 10 | Bundled media toolkit — pinned FFmpeg / yt-dlp / Deno fetch + version manifest | delivered (2026-10-10) |
| 11 | Media inspector / extractor — `media.inspect`, manifests | delivered (2026-10-11) |
| 12 | Media download & merge pipeline (video/audio/subtitle mux) | delivered (2026-10-12) |
| 13 | Torrent engine + UI | delivered (2026-10-12) |
| 14 | Browser history, bookmarks, downloads library | delivered (2026-10-13) |
| 15 | Scheduler jobs + automation | delivered (2026-10-13) |
| 16 | Settings domain completion | delivered (2026-10-13) |
| 17 | Notifications, toasts, tray integration | delivered (2026-10-13) |
| 18 | Auto-update channel | delivered (2026-10-14) |
| 19 | Packaging — electron-builder NSIS installer (user-side build) | delivered (2026-10-15) |
| 20 | Diagnostics — structured logs, log export, health report | delivered (2026-10-17) |
| 21 | Accessibility + i18n (fa / en) | delivered (2026-10-17) |
| 22 | Performance budgets — startup, memory, UI latency | delivered (2026-10-18) |
| 23 | Security audit — IPC surface, CSP, permission policy review | delivered (2026-10-18) |
| 24 | Hardening — fault injection, framing limits, crash recovery | delivered (2026-10-18) |
| 25 | E2E suites — headless renderer+main+core integration | pending |
| 26 | Release engineering — CI, checksums, artifact pipeline | pending |
| 27 | Docs — in-app help, FAQ, troubleshooting | pending |
| 28 | Data-integrity validation sweep — checksum/recovery deep verification | pending |
| 29 | Performance validation — real-device budget report harness | pending |
| 30 | Security & privacy final review — supply chain, SBOM | pending |
| 31 | 1.0.0 — final QA, version, release | pending |

## Contract versioning

- `packages/contracts` exports `CONTRACT_VERSION`. The Rust mirror crate `dc-protocol` declares the
  same value and fails on mismatch.
- Breaking changes bump the major version; additive changes bump the minor. The IPC boundary
  validates every request, response and event against zod schemas (TS side) / serde types (Rust
  side) at runtime.
- Cross-language fixtures live in `packages/contracts/fixtures/` and are consumed by both vitest
  and `cargo test` to prove both implementations agree on the wire format.
