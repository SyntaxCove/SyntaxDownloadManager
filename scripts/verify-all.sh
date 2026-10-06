# UniDM build/dev helper: runs the full headless verification used in CI and the Linux sandbox.
# Windows users run: scripts\dev-setup.ps1 (documented in docs/phases/phase-0.md)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[unidm] typecheck (contracts, desktop)"
npm run typecheck

echo "[unidm] TS tests"
npm run test

echo "[unidm] renderer build"
npm run build:desktop

if command -v cargo >/dev/null 2>&1; then
  echo "[unidm] Rust core: fmt check, clippy, tests"
  cargo fmt --manifest-path core/Cargo.toml --all -- --check
  cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
  cargo test --manifest-path core/Cargo.toml
else
  echo "[unidm] cargo not found — skipping Rust core checks (install rustup)"
fi

echo "[unidm] all checks passed"
