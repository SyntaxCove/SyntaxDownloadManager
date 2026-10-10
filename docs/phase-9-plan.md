# Phase 9 Plan — Proxy Engine (profiles, per-tab / per-job routing)

Status: delivered (see phase-9-report.md) · Contracts v1.3.0 → **v1.4.0** (additive) · Storage v4 → **v5**

## Goal

First-class proxy profiles routable by **browser tabs** (Electron/Chromium side) and **download
jobs** (Rust core side), with credentials that never reach the renderer, the disk in plaintext,
or the logs. A job whose proxy disappears **pauses with an actionable code** (never loses bytes);
a tab's traffic is isolated per-proxy by a dedicated persistent Chromium partition.

## Non-goals

- PAC URLs / system-proxy auto-detection modes (fixed_servers only in v1.4; modes can be added
  additively later).
- Proxy rotation pools, upstream chaining (proxy-through-proxy).
- Settings-level "default proxy for all new downloads" (Phase 16 domain completion).

## Architecture decisions

1. **Profiles live in Electron main; the core gets ephemeral runtime credentials only.**
   `userData/proxy-profiles.json` (atomic tmp+rename write, corruption quarantine — same
   pattern as settings.json). Passwords are stored only as `safeStorage` ciphertext
   (DPAPI on Windows) with an `enc:v1:<base64>` marker; plaintext never touches disk.
   If `safeStorage.isEncryptionAvailable()` is false, save/update with a password is refused
   with a new `proxy_keychain_unavailable` error (fail-closed; security > convenience).
2. **The renderer never sees secrets.** `proxy.list/create/update` results are redacted
   (`password: null` always). Secrets cross exactly one boundary: main → Rust core, in memory
   only, via `proxy.setRuntime` (pushed at core-ready, after every profile mutation, and after
   supervisor restarts). The core never persists proxy credentials (storage v5 keeps only
   `jobs.proxy_profile_id`).
3. **Fail-closed routing for jobs.** A run whose `proxy_profile_id` is absent from the runtime
   map does **not** silently fall back to a direct connection (that would leak the user's real
   IP). The run pauses with `proxy_profile_not_found`; `download.resume` succeeds once main
   re-pushes the runtime set. Paused-not-failed preserves the resume/recover semantics of
   Phases 6–8.
4. **Per-tab isolation by partition.** Tabs with a proxy use `session.fromPartition(
   "persist:proxy.<profileId>")` — shared by all tabs of that profile (stable cookies/storage
   per proxy identity), with `setProxy({mode:"fixed_servers", proxyRules, proxyBypassRules})`
   and a session-level `login` handler that answers **proxy** auth challenges with the
   profile's credentials. Chromium rules never embed credentials.
5. **Bypass list is a documented subset**, identical semantics on both sides:
   `<local>` (hostname without a dot, `localhost`, loopback), exact host, `.example.com`
   (apex + subdomains), `*.example.com` (subdomains only), each optionally `:port`-qualified.
   Main joins the array with "," for Chromium; the core matches with its own pure function
   (unit-tested matrix).
6. **Deletion guard.** `proxy.remove` refuses with `proxy_in_use` (+ job count in `data`)
   while any job still references the profile; the UI surfaces the count. Tabs using a deleted
   profile are detached to direct on the next renderer action (tab snapshots keep the stale id
   until changed; session exists only while tabs use it).

## Contract surface (v1.4.0, additive)

- `domain/proxy.ts`: `ProxyProfileInput` (name/scheme/host/port/username/password/bypassList),
  `ProxyProfilePublic` (= input + `id`, password redacted to null), `ProxyEndpoint`
  (core-facing, secrets included), params/results for `proxy.list/create/update/remove` and
  `proxy.setRuntime`/`proxy.test`.
- `domain/download.ts`: `DownloadJob.proxyProfileId` (nullable, always serialized),
  `DownloadCreateParams.proxyProfileId` (nullish), `download.setProxy {id, proxyProfileId|null}`.
- `domain/browser.ts`: `BrowserTab.proxyProfileId` (nullable, always serialized),
  `TabCreateParams.proxyProfileId` (nullish), `browser.tab.setProxy {id, proxyProfileId|null}`.
- `errors.ts` (append-only): `proxy_keychain_unavailable`, `proxy_profile_not_found`,
  `proxy_in_use`.
- Fixtures: `proxyProfile` + `proxiedDownloadJob` added; existing job/tab fixtures get
  `"proxyProfileId": null` (wire-shape round-trip must stay exact on both languages).

## Core (Rust) implementation

- New `proxy.rs` module: `RuntimeProxy` (serde camelCase), `ProxyMap` (Mutex<HashMap>),
  `proxy_url()` builder (http/https/socks5 + URL-encoded userinfo), `host_matches_bypass()`
  pure matcher, `host_of(url)` helper.
- Engine: `client_for_job(job)` resolves the per-run client — no profile → shared client;
  profile + URL host in bypass → shared client (direct); otherwise builds a per-run
  `reqwest::Client` with `Proxy::all(url).basic_auth(u, p)` (20s connect timeout kept).
  `probe()` and every `run_segment` task receive the resolved client (no global leaks).
- `run_job`: a `proxy_profile_not_found` outcome maps to **paused** (error_code set, job
  emitted), not failed — resume is the recovery path.
- Manager: `set_runtime_proxies(vec)` (full replace), `set_job_proxy(id, Option<String>)`
  (persisted; `invalid_state` while probing/downloading), `test_proxy(profile_id, url_override)`
  → GET `https://api.ipify.org` (override must be http(s)) through the profile with 12s total
  timeout → latency + exit IP / status / classified error.
- Server dispatch: `proxy.setRuntime`, `proxy.test`, `download.setProxy`.
- dc-storage v5 migration: `ALTER TABLE jobs ADD COLUMN proxy_profile_id TEXT;` + row mapping.
- Workspace: reqwest gains the `socks` feature (same pinned 0.13.5).

## Main (Electron) implementation

- `domains/proxy.ts`: `ProxyProfileStore` (load/persist/quarantine; safeStorage injected as an
  interface for testability; encrypt on save, decrypt only in `runtimeEndpoints()` and the
  Chromium resolver; redaction on every read) + `registerProxyDomain` (4 methods; remove guarded
  by a core `download.list` reference count; every mutation returns the redacted profile and
  triggers the runtime push via a callback).
- `domains/tab-manager.ts`: sessions per profile partition (cached; permission policy +
  login handler attached once), proxy rules applied from an injected resolver callback,
  `browser.tab.setProxy` recreates the tab's view on the target partition at the current URL
  (documented trade-off: that tab's back/forward history resets; cookies stay per partition),
  popups inherit the source tab's proxy.
- `main.ts`: store load + domain registration + `pushRuntimeProxies()` on `whenReady`,
  on every profile mutation, and on supervisor `ready` transitions (covers core restarts).

## Renderer implementation

- `stores/proxy.ts`: profiles + CRUD + per-profile test state.
- New **Proxy** page (nav entry): profile cards, editor dialog (name, scheme select, host,
  port, username, password, bypass list comma-separated), Test (latency + exit IP or error),
  delete with in-use refusal surfaced.
- DownloadsPage: proxy select in the create dialog; proxy badge on job rows; "Set proxy" dialog
  reusing the same select (calls `download.setProxy`).
- BrowsePage: "+" becomes split — direct tab (main button) and a proxied-tab menu listing
  profiles; proxied tabs show a dot badge with the profile name tooltip.

## Test plan

- **Rust unit**: `proxy_url` shapes (scheme/auth/encoding), bypass matcher matrix
  (exact/.suffix/*.sub/<local>/:port/case), runtime-map replace semantics.
- **Rust integration** (in-process harness): a minimal tokio absolute-URI HTTP proxy
  (request counter, optional Proxy-Authorization gate with 407) in front of a local file
  server — proxied job routed (counter seen) and completes; direct job bypasses the proxy;
  wrong credentials → 407 → run fails; map-miss → run pauses `proxy_profile_not_found` and
  resume after `setRuntime` completes; bypassList match goes direct; `download.setProxy`
  active/`invalid_state` vs persisted-on-paused; `proxy.test` ok + auth-fail + unknown-profile;
  storage v5 migration keeps prior rows intact.
- **Contracts vitest**: new method entries validate params/results; fixture additions
  round-trip; redaction schema (password null) enforced.
- **Main vitest**: proxy store (encrypt-at-rest via fake safeStorage, atomic persist,
  corruption quarantine, keychain-unavailable refusal, redaction, never-log), Chromium payload
  assembly (proxyRules / bypass join, no creds in rules), tab-manager partition choice +
  resolver wiring with a stubbed `WebContentsView`.
- **Renderer vitest**: proxyStore CRUD + test-state transitions; downloads store
  create/setProxy passthrough; browser store setProxy action.

## Verification gate

cargo fmt + clippy clean; cargo test green (baseline 93 → target ≥ 115); vitest green
(baseline 84 → target ≥ 110); npm typecheck + build green. Then docs (PHASES.md status,
report), review pass, single `phase(9)` commit.

## Risks

- reqwest 0.13 `socks` feature interplay with rustls — socks5 client verified by unit-building
  the client (no live socks server in sandbox); http proxy auth covered end-to-end by the
  harness.
- `session.setProxy` per partition requires credentials via `login` event — covered by handler
  wiring + unit test of the credential callback; live Chromium behavior is user-device
  verification (per the established Linux-sandbox boundary).
