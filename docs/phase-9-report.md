# Phase 9 Report — Proxy Engine (profiles, per-tab / per-job routing)

Date: 2026-10-10 · Contracts v1.3.0 → **v1.4.0** (additive) · Storage v4 → **v5**
Tests: **107 cargo** (was 93) · **108 vitest** (was 84) · typecheck + build green

## What shipped

- **Contract surface (v1.4.0, additive)**: `ProxyProfileInput` / `ProxyProfilePublic`
  (password always redacted to null) / `ProxyEndpoint` (core-facing, secrets included);
  main methods `proxy.list/create/update/remove`; core methods `proxy.setRuntime` (full
  replace of the in-memory runtime map) and `proxy.test` (GET probe URL through a profile →
  latency + exit IP or a classified error); `download.create.proxyProfileId`,
  `download.setProxy {id, proxyProfileId|null}`; `BrowserTab.proxyProfileId`,
  `TabCreateParams.proxyProfileId`, `browser.tab.setProxy`. Append-only error codes:
  `proxy_keychain_unavailable`, `proxy_profile_not_found`, `proxy_in_use`. Fixtures gained
  `proxyProfile` + `downloadJobProxied` (fail-closed paused state) and every existing
  job/tab fixture carries `"proxyProfileId": null`, round-trip-tested on both languages.
- **Secrets lifecycle (main)**: `domains/proxy.ts` — `ProxyProfileStore` persists
  `userData/proxy-profiles.json` atomically with settings-style corruption quarantine;
  passwords only as `safeStorage` ciphertext (`enc:v1:<base64>`, DPAPI on Windows). If the
  keychain is unavailable, saving a password is REFUSED (fail-closed) — never a plaintext
  downgrade. Decryption happens lazily in exactly two consumers: `runtimeEndpoints()`
  (core push) and `resolveForTab()` (Chromium session config). Every read path redacts;
  error messages embed ids/names only (never-log rule, unit-tested).
- **Per-job routing (core)**: new `proxy.rs` — `RuntimeProxy` + `ProxyMap` (Mutex, full
  replace), `proxy_url()` builder with percent-encoded userinfo (http/https/socks5, IPv6
  bracketing), and a pure `host_matches_bypass()` matcher (`<local>`, exact host, `.domain`
  apex+subs, `*.domain` subs-only, optional `:port`; case-insensitive). The engine resolves
  the run client BEFORE any network I/O (`client_for_job`): no profile → shared direct
  client; profile + host bypassed → direct; otherwise a per-run `reqwest::Client` with
  `Proxy::all(...).basic_auth(...)`. A profile missing from the runtime map pauses the run
  with `proxy_profile_not_found` (recover/retry/resume semantics intact — the job is NOT
  failed and NEVER silently routed direct); `recover()` handles the same fail-closed path.
  `manager.set_job_proxy` refuses active runs (`invalid_state`) — mutating a route mid-run
  would splice bytes from two network identities. Storage v5 adds `jobs.proxy_profile_id`
  (the only persisted artifact; no credential column by design).
- **Per-tab routing (main)**: `TabManager` keeps one persistent session per profile
  (`persist:proxy.<profileId>`, shared by tabs of that profile → stable cookies/storage per
  identity) with the permission policy, `setProxy({mode:"fixed_servers", proxyRules,
  proxyBypassRules})`, and a session `login` handler answering proxy auth challenges with
  the profile's credentials (Chromium rules never embed creds). `browser.tab.setProxy`
  recreates the tab's `WebContentsView` on the target partition at the current URL — a live
  session cannot be swapped under a webContents; documented trade-off: that tab's history
  resets, cookies stay per partition. Popups inherit the source tab's proxy. Unknown profile
  ids are refused (`proxy_profile_not_found`) rather than silently going direct.
- **Wiring**: main pushes the full runtime set at core-ready, after every profile mutation,
  and on supervisor `ready` transitions (core restarts boot with an empty map).
  `proxy.remove` refuses with `proxy_in_use` (+ job count in error data) while any job
  references the profile, and fails closed with `core_unavailable` when the core cannot be
  consulted.
- **UI (renderer)**: new **Proxy** page (nav entry): profile cards, editor dialog (name,
  scheme, host:port, username, password, bypass list), Test button showing latency + exit IP
  or the classified failure, guarded delete. DownloadsPage: proxy select on the create form,
  proxy badge on job rows, per-job "set proxy" dialog (disabled while active), and an
  actionable hint for `proxy_profile_not_found`. BrowsePage: proxied-new-tab menu + a badge
  on proxied tabs with the profile name tooltip.

## Test evidence

- **Rust unit** (`proxy.rs`): endpoint shapes (scheme/auth encoding/IPv6/rejects), bypass
  matrix (apex vs subdomain, `<local>`, port qualifiers, case), wholesale map replace.
- **Rust integration** (`tests/proxy.rs`, real TCP): a minimal absolute-URI HTTP proxy
  harness (request counter + `Proxy-Authorization` 407 gate) proves: proxied job routed and
  byte-exact; direct job never touches the proxy; bypassed host goes direct; wrong
  credentials → 407 → failed with classified code; missing runtime profile → **paused**
  `proxy_profile_not_found` then resume-after-push completes; setProxy state guard;
  `proxy.test` ok/407/unknown-profile classification; storage v5 round-trip + no credential
  column; dc-protocol proxied-fixture wire round-trip.
- **Main vitest** (10): encrypt-at-rest + plaintext-never-on-disk, reload round-trip,
  keychain-unavailable refusal, redaction + update patch semantics (omitted password kept,
  null clears), corrupt-file quarantine, never-log, `redact()`, and the domain surface:
  create/list/remove + `proxy_in_use` with count + `core_unavailable` fail-closed.
- **Renderer vitest** (6): proxy store CRUD + per-profile test state via the typed bridge
  (results schema-validated — proving redaction end-to-end), `download.create` profile
  passthrough, `download.setProxy`, `browser.tab.create`/`setProxy`.
- Gate: `cargo fmt --check` clean, `cargo clippy --all-targets` 0 warnings, cargo 107/107,
  vitest 108/108, `tsc` × 4 configs clean, `vite build` green.

## Decisions and trade-offs

- **Paused, not failed, on missing runtime profile**: preserves Phase 7 recoverability and
  matches the master rule that an environmental failure never destroys a job. The UI hint
  explains the resume path.
- **Full-replace runtime push** (not per-profile upserts): main is the single source of
  truth; one idempotent method covers create/update/delete and restarts.
- **Per-profile persistent partitions** (not per-tab ephemeral sessions): logins/cookies
  stay stable per proxy identity across restarts; two tabs on one profile share state by
  design, mirroring how proxy extensions scope containers.
- **`browser.tab.setProxy` recreates the view** instead of failing or navigating a new tab:
  honest about the Chromium constraint (session is bound at webContents creation) while
  keeping tab identity and URL.
- **Deletion guard instead of cascade**: deleting a referenced profile would silently
  reroute in-flight work; refusing with the count keeps routing changes explicit.

## Known limitations (documented, non-blocking)

- Chromium-side proxy auth and live connectivity are verified on the user's Windows device
  (Linux sandbox has no GUI/Chromium runtime) — consistent with the established boundary.
- `proxy.test` defaults to `https://api.ipify.org` (offline environments report
  `network_error`; the probe URL is overridable and validated to http(s)).
- SOCKS5 is exercised at the client-builder/wire-shape level (no SOCKS server in sandbox);
  the socks5 URL grammar is pinned by tests.

## Next

Phase 10 — bundled media toolkit: pinned FFmpeg / yt-dlp / Deno fetch + version manifest.
