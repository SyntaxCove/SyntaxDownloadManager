//! Phase 22 performance budget tests — enforced against the REAL spawned binary
//! (debug profile in CI; release is faster still). Budgets live in
//! scripts/perf-budgets.json and are mirrored here as constants with the file as the
//! source of truth; if the JSON changes, these constants change with it (the phase
//! report documents both sides).
//!
//! Honesty: these budgets are ceilings with headroom for CI noise (see the measured
//! baselines in the JSON). They catch pathological regressions — blocking startup work,
//! boot-time allocation runaways, per-request sync I/O — not micro-fluctuations.
//! Memory sampling is unix-only (`/proc`); on Windows the budget is checked user-side
//! via Diagnostics → Performance (coreRssBytes is null there, by wire contract).

use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::time::Duration;
use std::time::Instant;

/// scripts/perf-budgets.json → core.coldStartReadyMs
const BUDGET_COLD_START_READY_MS: u128 = 2_000;
/// scripts/perf-budgets.json → core.rssAfterReadyKb
const BUDGET_RSS_AFTER_READY_KB: u64 = 65_536;
/// scripts/perf-budgets.json → core.echoAvgUs
const BUDGET_ECHO_AVG_US: u128 = 2_000;
/// Ping sample count for the echo-latency budget.
const ECHO_SAMPLES: usize = 100;
/// Hard timeout for every spawned-binary test (the supervisor's own client timeout is 30 s).
const SPAWN_TIMEOUT_SECS: u64 = 25;

struct CoreProc {
    child: std::process::Child,
    db_path: std::path::PathBuf,
}

impl Drop for CoreProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.db_path);
    }
}

fn unique_db_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "dc-perf-{tag}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ))
}

fn spawn_core(tag: &str) -> (CoreProc, BufReader<std::process::ChildStdout>, Instant) {
    let exe = env!("CARGO_BIN_EXE_download-core");
    let db_path = unique_db_path(tag);
    let _ = std::fs::remove_file(&db_path);
    let mut child = std::process::Command::new(exe)
        .env("SYNTAXDM_DB", &db_path)
        .stdout(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn download-core");
    let stdout = child.stdout.take().expect("stdout piped");
    (
        CoreProc { child, db_path },
        BufReader::new(stdout),
        Instant::now(),
    )
}

/// Read lines until one containing `needle` appears; fails the test at the timeout.
fn wait_for_line<R: BufRead>(reader: &mut R, needle: &str, started: Instant) -> String {
    loop {
        assert!(
            started.elapsed() < Duration::from_secs(SPAWN_TIMEOUT_SECS),
            "timed out waiting for {needle}"
        );
        let mut line = String::new();
        let n = reader.read_line(&mut line).expect("stdout readable");
        assert!(n > 0, "core stdout closed before {needle}");
        if line.contains(needle) {
            return line;
        }
    }
}

/// Phase 22 budget: spawn → `core.ready` must stay under coldStartReadyMs.
#[test]
fn cold_start_ready_latency_under_budget() {
    let (_proc, mut reader, started) = spawn_core("coldstart");
    wait_for_line(&mut reader, "core.ready", started);
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_millis() <= BUDGET_COLD_START_READY_MS,
        "cold start to core.ready took {:?}, budget is {BUDGET_COLD_START_READY_MS} ms",
        elapsed
    );
}

/// Phase 22 budget: RSS after the ready transition must stay under rssAfterReadyKb.
/// Unix-only: /proc sampling. On Windows this compiles to nothing (the user-side
/// Diagnostics page is the honest measurement surface there).
#[cfg(unix)]
#[test]
fn rss_after_ready_under_budget() {
    let (proc, mut reader, started) = spawn_core("rss");
    wait_for_line(&mut reader, "core.ready", started);
    let pid = proc.child.id();
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).expect("/proc readable");
    let rss_kb = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .map(|rest| {
            rest.split_whitespace()
                .next()
                .and_then(|v| v.parse::<u64>().ok())
                .expect("VmRSS carries a kb value")
        })
        .expect("VmRSS present in /proc status");
    assert!(
        rss_kb <= BUDGET_RSS_AFTER_READY_KB,
        "core RSS after ready is {rss_kb} kB, budget is {BUDGET_RSS_AFTER_READY_KB} kB"
    );
}

/// Phase 22 budget: the average JSONL echo round-trip over the real binary must stay
/// under echoAvgUs. Measures the full stdio pipeline: write, core dispatch, response parse.
#[test]
fn echo_round_trip_average_under_budget() {
    let (mut proc, mut reader, started) = spawn_core("echo");
    wait_for_line(&mut reader, "core.ready", started);

    let mut stdin = proc.child.stdin.take().expect("stdin piped");
    let t0 = Instant::now();
    for i in 0..ECHO_SAMPLES {
        writeln!(
            stdin,
            "{{\"v\":1,\"id\":\"perf{i}\",\"method\":\"core.ping\"}}"
        )
        .expect("write ping");
    }
    stdin.flush().expect("flush pings");

    let mut seen = 0;
    while seen < ECHO_SAMPLES {
        assert!(
            started.elapsed() < Duration::from_secs(SPAWN_TIMEOUT_SECS),
            "timed out waiting for pong {seen}"
        );
        let mut line = String::new();
        let n = reader.read_line(&mut line).expect("stdout readable");
        assert!(n > 0, "core stdout closed at pong {seen}");
        if line.contains("\"pong\"") {
            seen += 1;
        }
    }
    let total_us = t0.elapsed().as_micros();
    let avg_us = total_us / ECHO_SAMPLES as u128;
    assert!(
        avg_us <= BUDGET_ECHO_AVG_US,
        "average echo round-trip is {avg_us} µs over {ECHO_SAMPLES} samples, budget is {BUDGET_ECHO_AVG_US} µs"
    );
}
