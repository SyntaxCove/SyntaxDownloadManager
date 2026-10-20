# Security Policy

## Supported versions

Only the latest release line receives security fixes. Releases are tagged `v*` and
published from the Phase 26 pipeline with per-artifact SHA-256 sidecars and a CycloneDX
SBOM (Phase 30).

| Version | Supported |
|---------|-----------|
| latest `v0.x` release | yes |
| older releases | no — please update |

## Reporting a vulnerability

Open a GitHub security advisory via **Security → Report a vulnerability** on this
repository (private disclosure). Please include: affected version/tag, a minimal
reproduction, and — where relevant — which trust boundary from
`docs/security-privacy-review.md` you believe failed. You will get an initial response
within 7 days. Please do not open public issues for exploitable findings.

Out of scope: the product's explicit no-DRM-circumvention policy means Widevine/EME
requests are treated as a compatibility question, not a security bypass; reports asking
for DRM circumvention will be declined.

## Security architecture in one page

- **Process model**: Electron main (privileged, no remote content) supervises the Rust
  core (`download-core(.exe)`) as an independent subprocess that owns the SQLite
  database. The renderer never touches storage; browser tabs (`WebContentsView`) never
  receive the IPC bridge.
- **IPC**: a single two-channel namespace; every envelope, parameter, and result is
  zod-validated against `@syntaxdm/contracts`; the sender firewall accepts only the
  packaged shell renderer on the default session.
- **Renderer hardening**: `sandbox: true`, `contextIsolation: true`, no Node in the
  renderer, strict CSP (meta + `onHeadersReceived`), global `<webview>` attach ban,
  deny-by-default permission request/check handlers, http(s)-only external handoff.
- **URL admission**: address bar and download core accept http(s) only; argv construction
  for bundled tools rejects leading-dash tokens.
- **Secrets**: proxy passwords are stored only as OS-keychain (safeStorage/DPAPI)
  ciphertext and are decrypted exclusively inside the proxy `login` handler; logs are
  redacted of URL credentials and secret-shaped query values.
- **Supply chain**: lockfile-authoritative installs (`npm ci`), exact version pinning,
  sha256-pinned bundled toolchains, actions pinned to commit SHAs, tokenless checkouts,
  `npm audit --omit=dev` hard gate, weekly scheduled `cargo-audit` + npm sweep, release
  SBOM + checksum sidecars.

Full detail: `docs/security-privacy-review.md`.
