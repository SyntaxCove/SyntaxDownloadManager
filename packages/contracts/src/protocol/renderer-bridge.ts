/**
 * The renderer↔preload API surface (exposed as `window.syntaxdm`).
 * Declared here so preload implements it and the renderer consumes the same type.
 * Runtime input/output validation lives on both ends (preload envelope checks + renderer
 * zod re-validation) — this interface is the compile-time shape.
 */
export interface SyntaxDmBridge {
  /**
   * Invoke a registered main-process method. Rejects with a ContractError-shaped object
   * (`{ code, message, data? }`) when the main process returns an error envelope.
   */
  rpc(method: string, params?: unknown): Promise<unknown>;
  /** Subscribe to a main-broadcast event. Returns an unsubscribe function. */
  onEvent(name: string, cb: (payload: unknown) => void): () => void;
}

export type IpcErrorCode =
  | "parse_error"
  | "invalid_params"
  | "method_not_found"
  | "unsupported_version"
  | "internal_error"
  | "timeout"
  | "core_unavailable"
  | "storage_error"
  | "io_error"
  | "file_exists"
  | "disk_full"
  | "network_error"
  | "http_error"
  | "range_not_satisfiable"
  | "url_invalid"
  | "canceled"
  | "invalid_state"
  | "checksum_mismatch";
