# Syntax Download Manager - Windows x64 packaging script (Phase 19).
#
# Builds the NSIS installer and the portable zip on a Windows machine:
#   1. installs/verifies toolchain prerequisites (Node >= 22, Rust stable);
#   2. installs workspace dependencies (full Electron binary download);
#   3. builds contracts + desktop (main, preload, renderer);
#   4. builds the Rust core in release mode;
#   5. stages the core binary where electron-builder expects it;
#   6. runs electron-builder (--win nsis zip).
#
# Artifacts land in apps/desktop/release/:
#   - SyntaxDownloadManager-Setup-<version>.exe        (assisted, per-user installer)
#   - SyntaxDownloadManager-<version>-portable.zip     (unpack-and-run)
#
# Usage (PowerShell):  .\scripts\build-windows.ps1

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Require-Tool {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing prerequisite: $Name. $Hint"
    }
}

Require-Tool "node" "Install Node.js 22 or newer from https://nodejs.org."
Require-Tool "cargo" "Install the Rust toolchain: https://rustup.rs."

Write-Host "== [1/5] npm install (downloads the Electron binary on Windows) =="
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host "== [2/5] Building contracts + desktop =="
npm run build:contracts
if ($LASTEXITCODE -ne 0) { throw "contracts build failed" }
npm run build:desktop
if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }

Write-Host "== [3/5] Building the Rust core (release) =="
cargo build --release --manifest-path (Join-Path $Root "core/Cargo.toml")
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$coreStage = Join-Path $Root "apps/desktop/build/core"
New-Item -ItemType Directory -Force -Path $coreStage | Out-Null
Copy-Item (Join-Path $Root "core/target/release/download-core.exe") $coreStage -Force

Write-Host "== [4/5] electron-builder: NSIS installer + portable zip =="
Push-Location (Join-Path $Root "apps/desktop")
try {
    # --publish never: the electron-builder config declares a github publish provider
    # (it is what electron-updater reads for the Phase 18 auto-update feed), but on a CI
    # tag build electron-builder would try to publish itself and demand GH_TOKEN. The
    # Phase 26 release pipeline (release.yml) is the ONLY publisher — it runs this same
    # script, then attaches checksummed artifacts to the release via gh. Humans and CI
    # share one packaging path; neither auto-publishes from electron-builder.
    npx electron-builder --win nsis zip --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
} finally {
    Pop-Location
}

Write-Host "== [5/5] Artifacts =="
Get-ChildItem (Join-Path $Root "apps/desktop/release") -File |
    Where-Object { $_.Extension -in ".exe", ".zip", ".yml", ".blockmap" } |
    ForEach-Object { Write-Host ("  " + $_.Name + "  (" + [math]::Round($_.Length / 1MB, 1) + " MB)") }

Write-Host "Done. Unsigned build note: see docs/phase-19-report.md for the code-signing upgrade path."
