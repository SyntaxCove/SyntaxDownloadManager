# Phase 0 — Monorepo Foundation (delivered)
**Plan**: npm-workspaces monorepo; pinned toolchain from registry (electron 44.5.1, TS 5.9.3,
vite 8.3.3, vitest 5.0.3, zod 4.6.5, zustand 5.0.15, Fluent 9.74.9, react 19.3.0); authoritative
phase map after sandbox reset; engineering conventions (no TODOs/mocks in deliverables, verify-all
gate). Sandbox installs Electron with ELECTRON_SKIP_BINARY_DOWNLOAD=1 (no GUI here; Windows device
runs GUI + installer builds).
**Test**: npm install succeeds; node/cargo/gcc verified (Node 24.21, Rust 1.99, gcc 14.2).
**Result**: commit `60801e6`. Layout: packages/contracts, apps/desktop, core/ (Rust), docs/, scripts/.
