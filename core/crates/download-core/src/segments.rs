//! Segmentation planning — pure, deterministic, unit-tested.
//!
//! Policy: a job is segmented only when the total size is known AND the server supports
//! ranges AND the file is large enough to justify parallel connections. Otherwise the job
//! runs as a single append-mode window (`end = None`), which the engine treats identically
//! to the Phase 5 single-stream path while still journaling per-segment state.

use dc_storage::SegmentRow;

/// Files smaller than this are downloaded over one connection.
pub const MIN_SEGMENT_BYTES: u64 = 1024 * 1024;

/// Absolute upper bound on connections per download (matches the contracts 1..16 range).
pub const MAX_CONNECTIONS_CAP: usize = 16;

/// One planned download window: `[start, end]` inclusive; `end = None` ⇒ open-ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start: u64,
    pub end: Option<u64>,
}

impl Window {
    /// Length of the window; `None` when open-ended (unknown total).
    pub fn byte_len(&self) -> Option<u64> {
        self.end.map(|e| e - self.start + 1)
    }
}

/// Plan contiguous windows for a download.
///
/// * total unknown OR ranges unsupported → one open-ended window (append mode; no Range
///   is ever sent — a server that ignores/mistreats ranges cannot be segmented);
/// * `total < min_segment` → one bounded window;
/// * otherwise `n = min(max_connections, ceil(total / min_segment))` windows; the remainder
///   of the division is spread one byte at a time over the first windows (deterministic,
///   stable across runs — the journal depends on it).
pub fn plan_windows(
    total: Option<u64>,
    ranges_supported: bool,
    max_connections: usize,
    min_segment: u64,
) -> Vec<Window> {
    let single = |start: u64, end: Option<u64>| vec![Window { start, end }];

    let Some(total) = total else {
        return single(0, None);
    };
    if total == 0 {
        // A zero-byte file needs no connections; the engine completes it directly.
        return Vec::new();
    }
    if !ranges_supported {
        return single(0, None);
    }
    if total < min_segment {
        return single(0, Some(total - 1));
    }

    let max_connections = max_connections.clamp(1, MAX_CONNECTIONS_CAP);
    let n = total.div_ceil(min_segment) as usize;
    let n = n.clamp(1, max_connections);

    let base = total / n as u64;
    let rem = total % n as u64;
    let mut windows = Vec::with_capacity(n);
    let mut cursor = 0u64;
    for i in 0..n {
        let len = base + if (i as u64) < rem { 1 } else { 0 };
        let start = cursor;
        let end = start + len - 1;
        windows.push(Window {
            start,
            end: Some(end),
        });
        cursor = end + 1;
    }
    debug_assert_eq!(cursor, total, "windows must tile the file exactly");
    windows
}

/// Convert planned windows into fresh journal rows (all pending, 0 written).
pub fn journal_from_plan(windows: &[Window]) -> Vec<SegmentRow> {
    windows
        .iter()
        .enumerate()
        .map(|(i, w)| SegmentRow {
            seg_index: i as u64,
            start_offset: w.start,
            end_offset: w.end,
            written_bytes: 0,
            status: "pending".into(),
        })
        .collect()
}

/// Validate that a persisted journal still matches the freshly planned windows (same count,
/// same offsets). Any mismatch ⇒ the plan changed (different total / settings) ⇒ reset.
pub fn journal_matches_plan(journal: &[SegmentRow], windows: &[Window]) -> bool {
    journal.len() == windows.len()
        && journal
            .iter()
            .zip(windows)
            .all(|(row, w)| row.start_offset == w.start && row.end_offset == w.end)
}

/// Lowercase hex encoding of a byte slice (checksum digests).
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Validate an expected checksum string for the algorithm (lowercase-hex, exact length).
/// Returns the normalized (lowercased) value.
pub fn normalize_expected(
    algorithm: dc_protocol::ChecksumAlgorithm,
    value: &str,
) -> Result<String, String> {
    let trimmed = value.trim().to_lowercase();
    if trimmed.is_empty()
        || !trimmed.chars().all(|c| c.is_ascii_hexdigit())
        || trimmed.len() != algorithm.hex_len()
    {
        return Err(format!(
            "expected {} checksum of {} hex chars",
            algorithm.as_str(),
            algorithm.hex_len()
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dc_protocol::ChecksumAlgorithm;

    fn ends(windows: &[Window]) -> Vec<(u64, Option<u64>)> {
        windows.iter().map(|w| (w.start, w.end)).collect()
    }

    #[test]
    fn unknown_total_is_open_ended_single_window() {
        assert_eq!(ends(&plan_windows(None, true, 4, 1)), vec![(0, None)]);
    }

    #[test]
    fn ranges_unsupported_falls_back_to_open_append_window() {
        assert_eq!(
            ends(&plan_windows(Some(10_000), false, 8, 1024)),
            vec![(0, None)]
        );
    }

    #[test]
    fn small_file_gets_one_window() {
        assert_eq!(
            ends(&plan_windows(Some(1024), true, 8, 4096)),
            vec![(0, Some(1023))]
        );
    }

    #[test]
    fn exact_division_tiles_evenly() {
        let w = plan_windows(Some(12), true, 3, 1);
        assert_eq!(ends(&w), vec![(0, Some(3)), (4, Some(7)), (8, Some(11))]);
    }

    #[test]
    fn remainder_is_distributed_to_first_windows() {
        // 10 bytes over 3 windows: 4 + 3 + 3
        let w = plan_windows(Some(10), true, 3, 1);
        assert_eq!(ends(&w), vec![(0, Some(3)), (4, Some(6)), (7, Some(9))]);
    }

    #[test]
    fn connections_are_capped_by_both_settings_and_file_size() {
        // total/min_segment = 2 → at most 2 windows even with 16 connections
        assert_eq!(plan_windows(Some(2048), true, 16, 1024).len(), 2);
        // 16 connections requested, cap 16 honored with a huge file
        assert_eq!(
            plan_windows(Some(u64::from(u32::MAX)), true, 16, 1024).len(),
            16
        );
        // more windows than connections never happens: 9 connections → 9 windows max
        assert_eq!(
            plan_windows(Some(u64::from(u32::MAX)), true, 9, 1024).len(),
            9
        );
    }

    #[test]
    fn zero_byte_file_needs_no_windows() {
        assert!(plan_windows(Some(0), true, 4, 1).is_empty());
    }

    #[test]
    fn journal_round_trip_and_mismatch_detection() {
        let windows = plan_windows(Some(10), true, 3, 1);
        let journal = journal_from_plan(&windows);
        assert!(journal_matches_plan(&journal, &windows));

        // A changed total re-plans → journal no longer matches → engine must reset.
        let new_windows = plan_windows(Some(12), true, 3, 1);
        assert!(!journal_matches_plan(&journal, &new_windows));

        // A resumed journal with partial writes still matches the same plan.
        let mut partial = journal_from_plan(&windows);
        partial[0].written_bytes = 2;
        partial[0].status = "downloading".into();
        assert!(journal_matches_plan(&partial, &windows));
    }

    #[test]
    fn hex_encoding_and_checksum_validation() {
        assert_eq!(to_hex(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
        assert_eq!(to_hex(&[]), "");

        let ok = normalize_expected(ChecksumAlgorithm::Sha256, &"AB".repeat(32)).unwrap();
        assert_eq!(ok, "ab".repeat(32));
        assert!(normalize_expected(ChecksumAlgorithm::Md5, "aabb").is_err()); // wrong length
        assert!(normalize_expected(ChecksumAlgorithm::Sha1, &"zz".repeat(20)).is_err());
        // not hex
    }
}
