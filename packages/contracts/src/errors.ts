import { z } from "zod";

/**
 * Error codes crossing the IPC boundary and the core wire protocol.
 * String codes (not numeric) so both TS and Rust serialize identically and remain debuggable.
 * Additive evolution: append at the end only (mirrors semantic versioning).
 */
export const ErrorCodes = [
  // protocol-level
  "parse_error",
  "invalid_params",
  "method_not_found",
  "unsupported_version",
  "internal_error",
  "timeout",
  "core_unavailable",
  // storage
  "storage_error",
  // filesystem
  "io_error",
  "file_exists",
  "disk_full",
  // network / http
  "network_error",
  "http_error",
  "range_not_satisfiable",
  "url_invalid",
  // job lifecycle
  "canceled",
  "invalid_state",
  "checksum_mismatch",
  // recovery (v1.2, Phase 7) — classified re-acquisition outcomes; append-only
  "source_gone",
  "source_forbidden",
  "source_changed",
  // proxy (v1.4, Phase 9) — append-only
  "proxy_keychain_unavailable",
  "proxy_profile_not_found",
  "proxy_in_use",
  // toolkit (v1.5, Phase 10) — append-only
  "toolkit_unsupported_platform",
  "toolkit_manifest_invalid",
  "toolkit_fetch_failed",
  "toolkit_extract_failed",
  "toolkit_checksum_mismatch",
  // media (v1.6, Phase 11) — append-only
  "media_tool_missing",
  "media_extract_failed",
  "media_playlist_unsupported",
  "media_invalid_response",
  // media pipeline (v1.7, Phase 12) — append-only
  "media_download_failed",
  "media_mux_failed",
  "media_format_not_found",
  "media_live_unsupported",
  // torrent engine (v1.8, Phase 13) — append-only
  "torrent_invalid_metainfo",
  "torrent_v2_unsupported",
  "torrent_metadata_timeout",
  "torrent_proxy_unsupported",
] as const;

export const ErrorCode = z.enum(ErrorCodes);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ContractError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** Optional structured details (e.g. HTTP status, offending field). */
  data: z.unknown().optional(),
});
export type ContractError = z.infer<typeof ContractError>;

/** Error thrown/returned by TS-side boundary implementations; mirrors ContractError. */
export class UniDmError extends Error implements ContractError {
  readonly code: ErrorCode;
  readonly data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "UniDmError";
    this.code = code;
    this.data = data;
  }

  toJSON(): ContractError {
    return { code: this.code, message: this.message, data: this.data };
  }

  static from(err: unknown): UniDmError {
    if (err instanceof UniDmError) return err;
    if (err instanceof Error) return new UniDmError("internal_error", err.message);
    return new UniDmError("internal_error", String(err));
  }
}
