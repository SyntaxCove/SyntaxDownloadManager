//! Token-bucket bandwidth limiting (Phase 8).
//!
//! Two independent buckets gate every segment write: a **global** bucket shared by all
//! jobs (the `speedLimitKBps` setting) and a **per-job** bucket (`download.setSpeedLimit`).
//! A chunk is written only after both buckets granted its byte count, so the effective
//! steady-state rate is `min(global, per-job)` while `0` on either side means unlimited.
//!
//! Accuracy note: HTTP chunks arrive in ~8–64 KiB pieces, so short bursts above the
//! configured limit are unavoidable; the bucket capacity is capped at one second of
//! bandwidth, which bounds the burst, and the steady rate converges to the limit within
//! a few seconds. Pacing only delays writes — it never drops or reorders bytes, so all
//! integrity guarantees (journal after write, checksums) are unaffected.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

/// Smallest sleep slice while waiting for tokens — keeps tiny limits responsive.
const MIN_SLEEP: Duration = Duration::from_millis(10);
/// Longest single sleep between refills — bounds stop/cancel reaction latency.
const MAX_SLEEP: Duration = Duration::from_millis(250);

struct Inner {
    /// Available tokens (bytes). Refilled continuously, capped at `capacity`.
    tokens: f64,
    /// Last refill timestamp.
    last: Instant,
}

/// A shared token bucket. `limit_bps == 0` is pass-through (unlimited).
pub struct Bucket {
    limit_bps: AtomicU64,
    capacity: AtomicU64,
    inner: tokio::sync::Mutex<Inner>,
}

impl Bucket {
    pub fn new(limit_bps: u64) -> Arc<Self> {
        Arc::new(Self {
            limit_bps: AtomicU64::new(limit_bps),
            capacity: AtomicU64::new(limit_bps.max(1)),
            inner: tokio::sync::Mutex::new(Inner {
                tokens: limit_bps as f64,
                last: Instant::now(),
            }),
        })
    }

    /// Change the limit live. The token pool is capped at the new capacity immediately;
    /// surplus tokens are discarded so a lowered limit takes effect at once.
    pub fn set_limit(&self, limit_bps: u64) {
        self.limit_bps.store(limit_bps, Ordering::SeqCst);
        self.capacity.store(limit_bps.max(1), Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.try_lock() {
            inner.tokens = inner.tokens.min(limit_bps as f64);
        }
    }

    pub fn limit_bps(&self) -> u64 {
        self.limit_bps.load(Ordering::SeqCst)
    }

    /// Grant `n` bytes, sleeping until the refill covers them. Cancellation-aware:
    /// returns `false` when `stop` fires first (the caller must unwind the run).
    ///
    /// Grants are incremental: tokens are consumed as they accumulate, so a request
    /// larger than the bucket capacity (possible for big chunks under a small limit)
    /// is delivered across several refills instead of deadlocking.
    pub async fn acquire(&self, n: u64, stop: &CancellationToken) -> bool {
        if n == 0 {
            return true;
        }
        let limit = self.limit_bps.load(Ordering::SeqCst);
        if limit == 0 {
            return true; // unlimited — pass-through
        }

        let mut remaining = n;
        loop {
            let wait = {
                let mut inner = self.inner.lock().await;
                let now = Instant::now();
                let elapsed = now.saturating_duration_since(inner.last).as_secs_f64();
                let capacity = self.capacity.load(Ordering::SeqCst) as f64;
                inner.tokens = (inner.tokens + elapsed * limit as f64).min(capacity);
                inner.last = now;

                if inner.tokens >= remaining as f64 {
                    inner.tokens -= remaining as f64;
                    return true;
                }
                // Partial grant: consume whole bytes as they accumulate.
                let take = inner.tokens.floor();
                if take >= 1.0 {
                    inner.tokens -= take;
                    remaining -= take as u64;
                }
                let secs = (remaining as f64 / limit as f64)
                    .clamp(MIN_SLEEP.as_secs_f64(), MAX_SLEEP.as_secs_f64());
                Duration::from_secs_f64(secs)
            }; // mutex released before sleeping

            tokio::select! {
                _ = stop.cancelled() => return false,
                _ = tokio::time::sleep(wait) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stopped_token() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn zero_limit_is_pass_through() {
        let bucket = Bucket::new(0);
        let stop = stopped_token();
        let start = Instant::now();
        assert!(bucket.acquire(10 * 1024 * 1024, &stop).await);
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "must not sleep"
        );
    }

    #[tokio::test]
    async fn grants_within_capacity_immediately() {
        let bucket = Bucket::new(1024 * 1024); // 1 MiB/s → capacity 1 MiB
        let stop = stopped_token();
        let start = Instant::now();
        assert!(bucket.acquire(512 * 1024, &stop).await);
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "burst within capacity"
        );
    }

    #[tokio::test]
    async fn steady_state_respects_limit() {
        // 256 KiB/s; consume 3 * 256 KiB — must take at least ~2 s of refills
        // (the first bucket-worth is preloaded, the remaining 2x must wait).
        let bucket = Bucket::new(256 * 1024);
        let stop = stopped_token();
        let start = Instant::now();
        for _ in 0..3 {
            assert!(bucket.acquire(256 * 1024, &stop).await);
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(1900),
            "expected >= ~2 s of pacing, got {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(6),
            "pacing must not stall: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn lowered_limit_discards_surplus_tokens() {
        let bucket = Bucket::new(1024 * 1024);
        let stop = stopped_token();
        bucket.set_limit(64 * 1024);
        let start = Instant::now();
        // 1 MiB at 64 KiB/s must take ≈ 15 s without the initial surplus,
        // but at least the first second — proving the discard happened.
        assert!(bucket.acquire(256 * 1024, &stop).await);
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(990),
            "surplus was discarded: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn request_larger_than_capacity_is_granted_across_refills() {
        // Regression: an 8x-capacity grant under a small limit must complete (never
        // deadlock). 512 KiB at 64 KiB/s: 64 KiB from the preloaded bucket, 448 KiB
        // refilled → ≈ 7 s.
        let bucket = Bucket::new(64 * 1024);
        let stop = stopped_token();
        let start = Instant::now();
        assert!(bucket.acquire(8 * 64 * 1024, &stop).await);
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(6500),
            "paced, got {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(20),
            "must not stall: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn acquire_is_cancellation_aware() {
        let bucket = Bucket::new(1024); // 1 KiB/s — a 1 MiB grant would wait ~17 min
        let stop = stopped_token();
        stop.cancel();
        let start = Instant::now();
        assert!(
            !bucket.acquire(1024 * 1024, &stop).await,
            "stopped acquire returns false"
        );
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn zero_byte_grant_never_sleeps() {
        let bucket = Bucket::new(1);
        let stop = stopped_token();
        let start = Instant::now();
        assert!(bucket.acquire(0, &stop).await);
        assert!(start.elapsed() < Duration::from_millis(50));
    }
}
