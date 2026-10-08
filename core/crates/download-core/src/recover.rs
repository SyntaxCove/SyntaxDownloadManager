//! Recovery engine v2 (Phase 7) — pure decision logic for source re-acquisition.
//!
//! The product promise: an expired URL never destroys the job or the bytes already
//! downloaded. Recovery re-acquires a source, revalidates it against the PART's provenance
//! with multiple signals (Content-Length / ETag / Last-Modified / Content-Type), rebinds the
//! job to the new source, and fills only the missing ranges.
//!
//! Data integrity outranks keeping bytes: the verdicts below keep the part ONLY when the
//! signals prove (or an expected checksum will arbitrate) that the on-disk bytes belong to
//! the same representation the missing ranges will come from.

use dc_protocol::ErrorCode;

/// The validator/identity signals of one source representation (or of the part on disk).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SourceSignals {
    pub total_bytes: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
}

impl SourceSignals {
    /// Build signals from a persisted job row (the part's provenance) or a fresh probe.
    pub fn new(
        total_bytes: Option<u64>,
        etag: Option<String>,
        last_modified: Option<String>,
        content_type: Option<String>,
    ) -> Self {
        Self {
            total_bytes,
            etag,
            last_modified,
            content_type,
        }
    }
}

/// What may be done with the existing part bytes after revalidation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevalidateVerdict {
    /// Same representation proven (ETag equal, or Last-Modified + equal size): keep the
    /// bytes and the journal; resume with If-Range exactly as Phase 6 does.
    Identical,
    /// Plausibly the same file (equal known size, equal media-type kind) but identity is
    /// unproven (validators differ or are absent) and the job carries an expected checksum:
    /// keep the bytes, run the gap-fill WITHOUT If-Range, and let the completion checksum
    /// arbitrate the mixed-provenance file. Every 206 Content-Range gate still applies.
    ChecksumArbitrated,
    /// The representation changed (or cannot be proven safe): discard the part and restart
    /// clean. The job survives; only the bytes are re-downloaded.
    Restart,
}

/// Multi-signal revalidation of a fresh source against the part's provenance.
///
/// Decision order (each rule only reached when the previous ones did not match):
/// 1. ETag present on both and equal → `Identical`. The ETag is the strongest identity
///    signal; a server lying about its ETag while serving a different length is caught
///    later by the 206 `Content-Range` total gate.
/// 2. Last-Modified present on both and equal AND both sizes known and equal → `Identical`.
/// 3. Both sizes known and different → `Restart`.
/// 4. Media-type kind (before `;`, case-insensitive) present on both and different →
///    `Restart` (the classic expired-URL-now-serves-HTML-login-page case).
/// 5. Both sizes known and equal (identity unproven) → `ChecksumArbitrated` when the job
///    carries an expected checksum, else `Restart` (no proof → integrity outranks bytes).
/// 6. Anything else (sizes unknown, no signal matched) → `Restart`.
pub fn revalidate(
    part: &SourceSignals,
    fresh: &SourceSignals,
    has_expected_checksum: bool,
) -> RevalidateVerdict {
    if let (Some(a), Some(b)) = (&part.etag, &fresh.etag) {
        if etag_eq(a, b) {
            return RevalidateVerdict::Identical;
        }
    }
    if let (Some(a), Some(b), Some(pa), Some(pb)) = (
        &part.last_modified,
        &fresh.last_modified,
        part.total_bytes,
        fresh.total_bytes,
    ) {
        if a == b && pa == pb {
            return RevalidateVerdict::Identical;
        }
    }
    match (part.total_bytes, fresh.total_bytes) {
        (Some(a), Some(b)) => {
            if a != b {
                return RevalidateVerdict::Restart;
            }
            if let (Some(ct_a), Some(ct_b)) = (&part.content_type, &fresh.content_type) {
                if !media_type_eq(ct_a, ct_b) {
                    return RevalidateVerdict::Restart;
                }
            }
            if has_expected_checksum {
                RevalidateVerdict::ChecksumArbitrated
            } else {
                RevalidateVerdict::Restart
            }
        }
        _ => RevalidateVerdict::Restart,
    }
}

/// ETag comparison: byte-for-byte per RFC 7232, with a tolerant variant that ignores the
/// weak/strong marker (`W/`) — many CDNs alternate between forms across re-acquisition.
fn etag_eq(a: &str, b: &str) -> bool {
    fn strip(v: &str) -> &str {
        let trimmed = v.trim();
        trimmed.strip_prefix("W/").unwrap_or(trimmed)
    }
    strip(a) == strip(b)
}

/// The media-type portion of a Content-Type value (before any `;` parameters),
/// lowercased and trimmed. `text/html; charset=utf-8` → `text/html`.
pub fn media_type_kind(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Case-insensitive media-type comparison (`kind ==` on `media_type_kind`).
pub fn media_type_eq(a: &str, b: &str) -> bool {
    media_type_kind(a) == media_type_kind(b)
}

/// Classify a probe/segment HTTP status into a recoverable, actionable error code.
///
/// 404/410 mean the resource is gone or expired (`source_gone`); 401/403 mean the URL
/// requires fresh credentials or a refreshed link (`source_forbidden`); everything else
/// keeps its existing classification (416 handled by the callers, other statuses map to
/// `http_error`).
pub fn classify_source_failure(status: u16) -> ErrorCode {
    match status {
        404 | 410 => ErrorCode::SourceGone,
        401 | 403 => ErrorCode::SourceForbidden,
        _ => ErrorCode::HttpError,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals(
        total: Option<u64>,
        etag: Option<&str>,
        last_modified: Option<&str>,
        content_type: Option<&str>,
    ) -> SourceSignals {
        SourceSignals::new(
            total,
            etag.map(String::from),
            last_modified.map(String::from),
            content_type.map(String::from),
        )
    }

    #[test]
    fn equal_etag_proves_identity_even_with_unknown_size() {
        let part = signals(Some(100), Some("\"v1\""), None, Some("video/mp4"));
        let fresh = signals(None, Some("\"v1\""), None, None);
        assert_eq!(
            revalidate(&part, &fresh, false),
            RevalidateVerdict::Identical
        );
    }

    #[test]
    fn equal_etag_wins_over_lying_length_and_kind() {
        // A server reporting the same ETag with a different length/kind is lying; the
        // verdict keeps the part (identity), and the 206 Content-Range total gate + final
        // checksum catch the lie during the run.
        let part = signals(Some(100), Some("\"v1\""), None, Some("video/mp4"));
        let fresh = signals(Some(999), Some("\"v1\""), None, Some("text/html"));
        assert_eq!(
            revalidate(&part, &fresh, false),
            RevalidateVerdict::Identical
        );
    }

    #[test]
    fn weak_etag_markers_are_tolerated() {
        let part = signals(Some(100), Some("W/\"v1\""), None, None);
        let fresh = signals(Some(100), Some("\"v1\""), None, None);
        assert_eq!(
            revalidate(&part, &fresh, false),
            RevalidateVerdict::Identical
        );
    }

    #[test]
    fn last_modified_with_equal_size_proves_identity() {
        let part = signals(Some(100), None, Some("Tue, 15 Nov 2094 12:45:26 GMT"), None);
        let fresh = signals(Some(100), None, Some("Tue, 15 Nov 2094 12:45:26 GMT"), None);
        assert_eq!(
            revalidate(&part, &fresh, false),
            RevalidateVerdict::Identical
        );
    }

    #[test]
    fn same_last_modified_with_different_size_restarts() {
        let part = signals(Some(100), None, Some("Tue, 15 Nov 2094 12:45:26 GMT"), None);
        let fresh = signals(Some(200), None, Some("Tue, 15 Nov 2094 12:45:26 GMT"), None);
        assert_eq!(revalidate(&part, &fresh, false), RevalidateVerdict::Restart);
    }

    #[test]
    fn different_size_restarts_even_with_checksum() {
        let part = signals(Some(100), Some("\"a\""), None, Some("application/zip"));
        let fresh = signals(Some(200), Some("\"b\""), None, Some("application/zip"));
        assert_eq!(revalidate(&part, &fresh, true), RevalidateVerdict::Restart);
    }

    #[test]
    fn media_type_kind_change_restarts_at_equal_size() {
        // The expired-URL trap: same length, but the body is now an HTML login page.
        let part = signals(Some(4096), None, None, Some("video/mp4"));
        let fresh = signals(Some(4096), None, None, Some("text/html; charset=utf-8"));
        assert_eq!(revalidate(&part, &fresh, true), RevalidateVerdict::Restart);
    }

    #[test]
    fn equal_size_and_kind_without_checksum_restarts() {
        let part = signals(Some(4096), Some("\"a\""), None, Some("application/zip"));
        let fresh = signals(Some(4096), Some("\"b\""), None, Some("application/zip"));
        assert_eq!(revalidate(&part, &fresh, false), RevalidateVerdict::Restart);
    }

    #[test]
    fn equal_size_and_kind_with_checksum_is_arbitrated() {
        let part = signals(Some(4096), Some("\"a\""), None, Some("application/zip"));
        let fresh = signals(Some(4096), Some("\"b\""), None, Some("application/zip"));
        assert_eq!(
            revalidate(&part, &fresh, true),
            RevalidateVerdict::ChecksumArbitrated
        );
    }

    #[test]
    fn absent_validators_with_checksum_still_arbitrate() {
        let part = signals(Some(4096), None, None, None);
        let fresh = signals(Some(4096), None, None, None);
        assert_eq!(
            revalidate(&part, &fresh, true),
            RevalidateVerdict::ChecksumArbitrated
        );
        assert_eq!(revalidate(&part, &fresh, false), RevalidateVerdict::Restart);
    }

    #[test]
    fn unknown_size_without_identity_signals_restarts() {
        let part = signals(None, Some("\"a\""), None, Some("application/zip"));
        let fresh = signals(None, Some("\"b\""), None, Some("application/zip"));
        assert_eq!(revalidate(&part, &fresh, true), RevalidateVerdict::Restart);
    }

    #[test]
    fn media_type_comparison_ignores_parameters_and_case() {
        assert!(media_type_eq("Video/MP4", "video/mp4"));
        assert!(media_type_eq("text/html; charset=utf-8", "TEXT/HTML"));
        assert!(!media_type_eq("text/html", "application/xhtml+xml"));
    }

    #[test]
    fn probe_failures_classify_into_recoverable_codes() {
        assert_eq!(classify_source_failure(404), ErrorCode::SourceGone);
        assert_eq!(classify_source_failure(410), ErrorCode::SourceGone);
        assert_eq!(classify_source_failure(401), ErrorCode::SourceForbidden);
        assert_eq!(classify_source_failure(403), ErrorCode::SourceForbidden);
        assert_eq!(classify_source_failure(500), ErrorCode::HttpError);
        assert_eq!(classify_source_failure(418), ErrorCode::HttpError);
    }
}
