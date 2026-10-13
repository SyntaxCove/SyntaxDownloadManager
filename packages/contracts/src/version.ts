/**
 * Contract versions. Mirrored by core/crates/dc-protocol (Rust); a mismatch fails fast at startup.
 */
export const CONTRACT_VERSION = "1.10.0";

/** Wire protocol version carried by every envelope (`v` field). */
export const PROTOCOL_VERSION = 1 as const;
