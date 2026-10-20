# Syntax Download Manager build/dev helper: runs the full headless verification used in CI and the Linux sandbox.
# Windows users run: scripts\dev-setup.ps1 (documented in docs/phases/phase-0.md)
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v cargo >/dev/null 2>&1; then
  # Phase 25: build the core binary BEFORE the TS test step — the E2E suites
  # (apps/desktop/src/e2e) supervise the real download-core subprocess.
  echo "[syntaxdm] Rust core: build (debug binary for the E2E suites)"
  cargo build --manifest-path core/Cargo.toml -p download-core
fi

echo "[syntaxdm] typecheck (contracts, desktop incl. E2E)"
npm run typecheck

echo "[syntaxdm] TS tests (unit + E2E)"
npm run test

echo "[syntaxdm] renderer build"
npm run build:desktop

echo "[syntaxdm] performance budgets (renderer bundle, Phase 22 gate)"
node scripts/check-budgets.mjs

echo "[syntaxdm] checksum tooling selftest (Phase 26 release engineering)"
node scripts/checksums.mjs --selftest

echo "[syntaxdm] SBOM generator selftest (Phase 30 supply chain)"
node scripts/sbom.mjs --selftest

echo "[syntaxdm] runtime dependency audit gate (Phase 30: shipped deps must stay at zero)"
npm audit --omit=dev

if command -v cargo >/dev/null 2>&1; then
  echo "[syntaxdm] Rust core: fmt check, clippy, tests"
  cargo fmt --manifest-path core/Cargo.toml --all -- --check
  cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
  cargo test --manifest-path core/Cargo.toml
else
  echo "[syntaxdm] cargo not found — skipping Rust core checks (E2E suites skip visibly; install rustup)"
fi

echo "[syntaxdm] all checks passed"
