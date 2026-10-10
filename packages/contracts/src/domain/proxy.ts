import { z } from "zod";
import { Ulid } from "../ids.js";
import { HttpUrl } from "./download.js";

/**
 * Proxy domain (Phase 9, v1.4): profiles usable by browser tabs and download jobs.
 *
 * Secret handling:
 *  - `ProxyProfileInput.password` crosses the boundary ONLY on create/update (renderer form).
 *  - `ProxyProfilePublic.password` is ALWAYS null — main redacts; the renderer never receives
 *    secrets, and results must never be logged by handlers.
 *  - At rest, main persists only safeStorage ciphertext (`enc:v1:<base64>`); plaintext lives
 *    in main-process memory and in the core's runtime map (`proxy.setRuntime` push), never in
 *    the core's SQLite database.
 *  - `bypassList` entries are a documented Chromium-compatible subset: `<local>`, exact host,
 *    `.domain` (apex + subdomains), `*.domain` (subdomains only), each optionally `:port`.
 */

export const ProxyScheme = z.enum(["http", "https", "socks5"]);
export type ProxyScheme = z.infer<typeof ProxyScheme>;

export const ProxyProfileInput = z.object({
  name: z.string().min(1).max(120),
  scheme: ProxyScheme,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(253).nullable(),
  password: z.string().max(1024).nullable(),
  bypassList: z.array(z.string().min(1).max(253)).max(64),
});
export type ProxyProfileInput = z.infer<typeof ProxyProfileInput>;

/** What the renderer is allowed to see: the saved password is always redacted to null. */
export const ProxyProfilePublic = ProxyProfileInput.extend({
  id: Ulid,
  password: z.null(),
});
export type ProxyProfilePublic = z.infer<typeof ProxyProfilePublic>;

/** Core-facing runtime endpoint (main → core push only; includes decrypted secrets). */
export const ProxyEndpoint = z.object({
  id: Ulid,
  scheme: ProxyScheme,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(253).nullable(),
  password: z.string().max(1024).nullable(),
  bypassList: z.array(z.string().min(1).max(253)).max(64),
});
export type ProxyEndpoint = z.infer<typeof ProxyEndpoint>;

// ---- main-served CRUD (secrets in, redaction out) ----

export const ProxyListParams = z.object({});
export const ProxyListResult = z.object({ profiles: z.array(ProxyProfilePublic) });
export type ProxyListResult = z.infer<typeof ProxyListResult>;

export const ProxyCreateParams = z.object({ profile: ProxyProfileInput });
export const ProxyCreateResult = z.object({ profile: ProxyProfilePublic });
export type ProxyCreateResult = z.infer<typeof ProxyCreateResult>;

/** Patch semantics: only provided keys are updated (password omitted = keep existing). */
export const ProxyUpdateParams = z.object({ id: Ulid, profile: ProxyProfileInput.partial() });
export const ProxyUpdateResult = z.object({ profile: ProxyProfilePublic });
export type ProxyUpdateResult = z.infer<typeof ProxyUpdateResult>;

export const ProxyRemoveParams = z.object({ id: Ulid });
export const ProxyRemoveResult = z.object({ removed: z.literal(true) });

// ---- core-served runtime push + connectivity test ----

/** Full replace of the core's in-memory runtime map (main is the single source of truth). */
export const ProxySetRuntimeParams = z.object({ profiles: z.array(ProxyEndpoint).max(64) });
export const ProxySetRuntimeResult = z.object({ applied: z.literal(true) });

export const ProxyTestParams = z.object({
  profileId: Ulid,
  /** Probe URL override; must be http(s). Default: https://api.ipify.org (echoes exit IP). */
  url: HttpUrl.optional(),
});
export const ProxyTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().nullable(),
  exitIp: z.string().nullable(),
  status: z.number().int().nullable(),
  errorCode: z.string().nullable(),
});
export type ProxyTestResult = z.infer<typeof ProxyTestResult>;
