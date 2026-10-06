import { z } from "zod";
import { Ulid } from "../ids.js";

/** Proxy domain (Phase 9): profiles usable by browser tabs and download jobs. */

export const ProxyScheme = z.enum(["http", "https", "socks5"]);
export type ProxyScheme = z.infer<typeof ProxyScheme>;

export const ProxyProfile = z.object({
  id: Ulid,
  name: z.string().min(1),
  scheme: ProxyScheme,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().nullable(),
  /** Stored in the OS keychain via safeStorage (Phase 9); never logged. */
  password: z.string().nullable(),
  bypassList: z.array(z.string()),
});
export type ProxyProfile = z.infer<typeof ProxyProfile>;
