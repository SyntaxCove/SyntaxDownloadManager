//! Phase 24 hardening (F-3): persistence fault injection.
//!
//! Corrupt-input behavior of `JobStore` must be loud and typed — never a panic, never a
//! silent success. A garbage file at `open` fails with a StorageError; a database
//! corrupted after creation must have `quick_check` stop reporting "ok".

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dc_storage::JobStore;

/// Unique temp dir per call (no tempfile crate in the dep tree — stay std-only).
fn scratch_dir(label: &str) -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "syntaxdm-corruption-{}-{}-{}",
        label,
        nanos,
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

#[test]
fn garbage_file_at_open_fails_typed_not_panic() {
    let dir = scratch_dir("open-garbage");
    let path = dir.join("corrupt.db");
    std::fs::write(&path, b"this is not a SQLite database, only noise bytes").unwrap();

    // Must return Err (typed StorageError from rusqlite), never panic, never Ok.
    let result = JobStore::open(&path);
    match result {
        Ok(_) => panic!("opening a garbage file must not succeed"),
        Err(err) => {
            let msg = err.to_string();
            assert!(
                msg.to_lowercase().contains("database")
                    || msg.to_lowercase().contains("sqlite")
                    || msg.to_lowercase().contains("open"),
                "error must identify the database failure, got: {msg}"
            );
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn zero_byte_file_opens_as_fresh_database() {
    let dir = scratch_dir("open-empty");
    let path = dir.join("empty.db");
    std::fs::write(&path, b"").unwrap();

    // SQLite treats a zero-length file as a fresh database — migrations must succeed.
    let store = JobStore::open(&path).expect("zero-byte file opens as a fresh database");
    assert_eq!(store.quick_check().expect("quick check runs"), "ok");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn post_creation_corruption_stops_quick_check_reporting_ok() {
    let dir = scratch_dir("post-corrupt");
    let path = dir.join("jobs.db");
    {
        // Build a real database with several pages (migrations + a job row).
        let store = JobStore::open(&path).expect("create database");
        store
            .quick_check()
            .expect("quick check on the healthy database");
        drop(store);
    }
    // Corrupt a page beyond the header (offset 8192) — deterministic, deep in the file.
    let mut bytes = std::fs::read(&path).expect("read database file");
    assert!(
        bytes.len() > 8192 + 128,
        "database with schema + a job row spans multiple pages (len={})",
        bytes.len()
    );
    for b in &mut bytes[8192..8192 + 128] {
        *b = 0x7f;
    }
    std::fs::write(&path, &bytes).expect("write corrupted database");

    // Reopening may succeed (SQLite defers reads) but integrity must no longer be "ok":
    // either quick_check errors, or it reports a bounded problem description.
    let outcome = JobStore::open(&path).map(|store| store.quick_check());
    match outcome {
        Err(_) => {}     // open itself rejected the corrupted file — loud and typed, fine
        Ok(Err(_)) => {} // quick_check errored — loud and typed, fine
        Ok(Ok(report)) => {
            assert_ne!(
                report.trim(),
                "ok",
                "a corrupted database must not report integrity ok"
            );
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}
