//! Part/journal reconciliation (Phase 28) — pure decision logic, exhaustively tested.
//!
//! The segment journal is trusted to describe bytes on disk. Three real events break that
//! trust: an externally deleted/truncated `.part`, a crash between the completion rename and
//! the final status update, and a power loss that drops page-cache bytes a persisted cursor
//! already claims (the engine now fsyncs before every cursor advance — F-3 — which bounds
//! the exposure to external tampering and pre-fix databases).
//!
//! Rule: the journal may only claim bytes some on-disk file proves. Anything else is
//! re-downloaded (integrity outranks bytes) or, when the pre-crash completion verified the
//! artifact by a signal we can re-check now, adopted from the final file.

/// On-disk facts gathered by the engine right before a run touches the part file.
#[derive(Debug, Clone, PartialEq)]
pub struct ReconcileFacts {
    /// Σ `written_bytes` over the persisted segment journal.
    pub journal_written_total: u64,
    pub part_exists: bool,
    pub part_len: u64,
    pub final_exists: bool,
    pub final_len: u64,
    /// Known total size; `None` = open-ended (append mode, size unknown).
    pub total_bytes: Option<u64>,
    pub has_expected_checksum: bool,
    /// Result of hashing the candidate final file against the expected checksum.
    /// `Some(true)`/`Some(false)` when a checksum exists and was verified;
    /// `None` when no expected checksum was supplied.
    pub expected_matches: Option<bool>,
}

/// What the engine must do before the run may touch the part file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Journal and disk agree — resume from the persisted cursors.
    Proceed,
    /// The journal claims bytes nothing proves. Wipe the journal and restart the plan
    /// fresh (a re-download; the part, when present, is fully rewritten by the new plan).
    ResetJournal,
    /// Append mode only: the journal leads the part by external truncation. Clamp the
    /// single open window's cursor to the provable part length and keep the bytes.
    ClampToPart(u64),
    /// The previous run completed and renamed (crash between rename and status update).
    /// The final file is the artifact: record the verification, mark completed, drop the
    /// journal rows. No bytes are downloaded.
    AdoptFinal,
}

/// Total decision table. Every branch is deliberate; see the phase-28 plan for rationale.
pub fn reconcile(f: &ReconcileFacts) -> ReconcileAction {
    if f.part_exists {
        return match f.total_bytes {
            // Offset mode: the part was pre-sized (sparse) to the total by past runs, so
            // the journal can only be trusted while the part still covers its claims.
            Some(total) => {
                if f.journal_written_total > f.part_len || f.journal_written_total > total {
                    ReconcileAction::ResetJournal
                } else {
                    ReconcileAction::Proceed
                }
            }
            // Append mode: the file must back every claimed byte; a journal that leads
            // the part (external truncation) clamps to what is provable instead of
            // throwing away 99% of a download over one lost tail.
            None => {
                if f.journal_written_total > f.part_len {
                    ReconcileAction::ClampToPart(f.part_len)
                } else {
                    ReconcileAction::Proceed
                }
            }
        };
    }

    // Part missing. The only thing that can still prove bytes is the final file — which
    // exists exactly when the previous run renamed mid-completion and died before the
    // status update (F-2). Adoption requires a re-checkable verification signal.
    if f.final_exists {
        match f.total_bytes {
            Some(total) => {
                if f.final_len != total {
                    return ReconcileAction::ResetJournal; // size never verified
                }
                if f.has_expected_checksum && f.expected_matches != Some(true) {
                    return ReconcileAction::ResetJournal; // hash refuses the file
                }
                // Size proven now; hash proven when a checksum exists (the pre-crash run
                // hashed and fsynced before renaming). Adopt.
                ReconcileAction::AdoptFinal
            }
            None => {
                if f.has_expected_checksum && f.expected_matches == Some(true) {
                    ReconcileAction::AdoptFinal // hash proven
                } else {
                    ReconcileAction::ResetJournal // no size, no hash — unprovable
                }
            }
        }
    } else {
        ReconcileAction::ResetJournal // bytes gone; nothing to adopt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> ReconcileFacts {
        ReconcileFacts {
            journal_written_total: 0,
            part_exists: false,
            part_len: 0,
            final_exists: false,
            final_len: 0,
            total_bytes: Some(1000),
            has_expected_checksum: false,
            expected_matches: None,
        }
    }

    #[test]
    fn empty_journal_proceeds_in_both_modes() {
        let f = facts();
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal); // nothing anywhere → reset

        let mut f = facts();
        f.part_exists = true;
        f.part_len = 1000;
        assert_eq!(reconcile(&f), ReconcileAction::Proceed);

        let mut f = facts();
        f.total_bytes = None; // append mode
        f.part_exists = true;
        f.part_len = 40;
        assert_eq!(reconcile(&f), ReconcileAction::Proceed);
    }

    #[test]
    fn offset_mode_resets_when_journal_leads_part_or_total() {
        let mut f = facts();
        f.part_exists = true;
        f.part_len = 600; // externally shrunk below the claims
        f.journal_written_total = 700;
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);

        f.part_len = 1000;
        f.journal_written_total = 1200; // corrupt journal beyond a sane part
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);

        f.journal_written_total = 1000; // exactly full → normal completion resume
        assert_eq!(reconcile(&f), ReconcileAction::Proceed);
    }

    #[test]
    fn append_mode_clamps_when_journal_leads_part() {
        let mut f = facts();
        f.total_bytes = None;
        f.part_exists = true;
        f.part_len = 300;
        f.journal_written_total = 512;
        assert_eq!(reconcile(&f), ReconcileAction::ClampToPart(300));

        f.part_len = 512; // caught up → proceed
        assert_eq!(reconcile(&f), ReconcileAction::Proceed);
    }

    #[test]
    fn adopt_requires_size_proof_in_offset_mode() {
        let mut f = facts();
        f.final_exists = true;
        f.final_len = 999; // wrong size — never adopted
        f.journal_written_total = 1000;
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);

        f.final_len = 1000;
        assert_eq!(reconcile(&f), ReconcileAction::AdoptFinal); // size-verified adopt

        // With an expected checksum, only a matching hash adopts.
        f.has_expected_checksum = true;
        f.expected_matches = Some(false);
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);
        f.expected_matches = Some(true);
        assert_eq!(reconcile(&f), ReconcileAction::AdoptFinal);
    }

    #[test]
    fn append_mode_adopts_only_on_hash_proof() {
        let mut f = facts();
        f.total_bytes = None; // open-ended: no size signal exists
        f.final_exists = true;
        f.final_len = 777;
        f.journal_written_total = 777;
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal); // unprovable → re-download

        f.has_expected_checksum = true;
        f.expected_matches = Some(false);
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);
        f.expected_matches = Some(true);
        assert_eq!(reconcile(&f), ReconcileAction::AdoptFinal);
    }

    #[test]
    fn missing_part_and_final_always_resets() {
        let mut f = facts();
        f.journal_written_total = 500;
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);

        f.total_bytes = None;
        f.has_expected_checksum = true;
        f.expected_matches = Some(true); // nothing to hash against — the file is gone
        assert_eq!(reconcile(&f), ReconcileAction::ResetJournal);
    }

    #[test]
    fn decision_table_is_total_over_the_invariant_dimensions() {
        // Walk the full cross product of the boolean/fact space and assert the table never
        // panics and never adopts without a re-checkable proof.
        for &part_exists in &[true, false] {
            for &final_exists in &[true, false] {
                for &total_known in &[true, false] {
                    for &checksum in &[true, false] {
                        for &matches in &[Some(true), Some(false), None] {
                            for &journal in &[0u64, 500, 1200] {
                                let mut f = facts();
                                f.part_exists = part_exists;
                                f.part_len = if part_exists { 1000 } else { 0 };
                                f.final_exists = final_exists;
                                f.final_len = if final_exists { 1000 } else { 0 };
                                f.total_bytes = if total_known { Some(1000) } else { None };
                                f.has_expected_checksum = checksum;
                                f.expected_matches = if checksum { matches } else { None };
                                f.journal_written_total = journal;
                                match reconcile(&f) {
                                    ReconcileAction::AdoptFinal => {
                                        if let Some(total) = f.total_bytes {
                                            assert_eq!(f.final_len, total);
                                        }
                                        assert!(f.final_exists);
                                        assert!(
                                            !f.has_expected_checksum
                                                || f.expected_matches == Some(true)
                                        );
                                    }
                                    ReconcileAction::ClampToPart(n) => {
                                        assert!(!total_known);
                                        assert!(part_exists);
                                        assert!(n <= f.part_len);
                                    }
                                    ReconcileAction::Proceed => {
                                        assert!(part_exists);
                                        assert!(f.journal_written_total <= f.part_len);
                                    }
                                    ReconcileAction::ResetJournal => {}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
