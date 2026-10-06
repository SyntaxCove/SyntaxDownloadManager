//! ULID identifiers (Crockford base32) — behaviorally identical to
//! packages/contracts/src/ids.ts, including in-process monotonicity.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use thiserror::Error;

pub const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const ENCODING_LEN: u32 = 32;
pub const TIME_LEN: usize = 10;
pub const RANDOM_LEN: usize = 16;
pub const ULID_LEN: usize = TIME_LEN + RANDOM_LEN;

#[derive(Debug, Clone, Error)]
pub enum UlidError {
    #[error("invalid length: {0}")]
    BadLength(usize),
    #[error("invalid Crockford base32 character: {0}")]
    BadChar(char),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ulid(pub String);

impl Ulid {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn validate(s: &str) -> Result<(), UlidError> {
        let bytes = s.as_bytes();
        if bytes.len() != ULID_LEN {
            return Err(UlidError::BadLength(bytes.len()));
        }
        for &b in bytes {
            if CROCKFORD.contains(&b.to_ascii_uppercase()) {
                continue;
            }
            return Err(UlidError::BadChar(b as char));
        }
        Ok(())
    }

    pub fn time(&self) -> Option<u64> {
        ulid_time(&self.0)
    }
}

impl std::fmt::Display for Ulid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for Ulid {
    type Err = UlidError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ulid::validate(s)?;
        Ok(Ulid(s.to_string()))
    }
}

fn encode_time(mut now: u64) -> String {
    let mut out = [0u8; TIME_LEN];
    for i in (0..TIME_LEN).rev() {
        out[i] = CROCKFORD[(now % ENCODING_LEN as u64) as usize];
        now /= ENCODING_LEN as u64;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode_random(rand: &[u32]) -> String {
    let mut out = Vec::with_capacity(RANDOM_LEN);
    for d in rand {
        out.push(CROCKFORD[(*d % ENCODING_LEN) as usize]);
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_digits() -> Vec<u32> {
    // getrandom via std: fastrand-free approach using /dev/urandom on unix, GCM on windows is
    // handled by getrandom through rand? Keep dependency-free: use SystemTime nanos mixed with
    // an atomic counter — monotonic ULIDs do not require cryptographic randomness.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_millis() as u64)
        .unwrap_or(0);
    let mut state = nanos
        ^ COUNTER
            .fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
            .wrapping_mul(0xA076_1D64_78BD_642F);
    (0..RANDOM_LEN)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % ENCODING_LEN as u64) as u32
        })
        .collect()
}

fn increment_digits(digits: &mut Vec<u32>) {
    for d in digits.iter_mut().rev() {
        if *d + 1 < ENCODING_LEN {
            *d += 1;
            return;
        }
        *d = 0;
    }
    *digits = random_digits();
}

struct MonotonicState {
    last_time: i64,
    last_random: Vec<u32>,
}

static STATE: Mutex<Option<MonotonicState>> = Mutex::new(None);

/// Generate a ULID; strictly increasing within one process even in the same millisecond.
pub fn new_ulid() -> Ulid {
    let time_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut guard = STATE.lock().expect("ulid state poisoned");
    let state = guard.get_or_insert(MonotonicState {
        last_time: -1,
        last_random: Vec::new(),
    });

    if time_ms == state.last_time {
        increment_digits(&mut state.last_random);
    } else {
        state.last_random = random_digits();
        state.last_time = time_ms;
    }
    Ulid(format!(
        "{}{}",
        encode_time(time_ms as u64),
        encode_random(&state.last_random)
    ))
}

/// Decode the timestamp part of a ULID to epoch milliseconds.
pub fn ulid_time(id: &str) -> Option<u64> {
    if Ulid::validate(id).is_err() {
        return None;
    }
    let mut time: u64 = 0;
    for b in id.as_bytes().iter().take(TIME_LEN) {
        let idx = CROCKFORD
            .iter()
            .position(|&c| c == b.to_ascii_uppercase())?;
        time = time * ENCODING_LEN as u64 + idx as u64;
    }
    Some(time)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_valid_monotonic_ulids() {
        let mut prev = String::new();
        for _ in 0..10_000 {
            let id = new_ulid();
            Ulid::validate(id.as_str()).expect("valid ulid");
            assert!(id.as_str() > prev.as_str(), "strictly increasing");
            prev = id.0;
        }
    }

    #[test]
    fn decodes_timestamp() {
        let id = new_ulid();
        let t = id.time().expect("time decodable");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(now.abs_diff(t) < 5_000);
    }

    #[test]
    fn rejects_invalid() {
        assert!(Ulid::validate("short").is_err());
        assert!(Ulid::validate("01JD8W3G5XQ9V4M2K7PZ6N8S0U").is_err()); // 'U' not in Crockford
        assert!(Ulid::validate("01JD8W3G5XQ9V4M2K7PZ6N8S0TZ").is_err()); // 27 chars
    }
}
