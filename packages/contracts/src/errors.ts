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
