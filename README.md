# UniDM — Unified Browser + Advanced Download Manager

Production-grade Windows 11 x64 desktop application: a Chromium-based browser (Electron
`WebContentsView` tabs) fused with an advanced, resumable download manager powered by a supervised
Rust core (`download-core.exe`). No AI features. All external engines (FFmpeg, yt-dlp, Deno,
torrent client) are bundled — the end user installs nothing else.

- **docs/PHASES.md** — authoritative phase map (0–31) and build rules
- **docs/ARCHITECTURE.md** — process architecture and key decisions
- **docs/phases/** — per-phase reports (Plan / Test / Fix / Review)
- **worklog.md** — multi-agent work log

Engineering priority: data integrity > security > reliability/recovery > correctness >
maintainability > performance > UX > feature breadth.

## Headless verification (Linux sandbox / CI)

```bash
npm install
scripts/verify-all.sh   # typecheck + vitest + vite build + cargo fmt/clippy/test
```

Windows full build & installer packaging are performed on the user's device (see
docs/phases/phase-0.md).
