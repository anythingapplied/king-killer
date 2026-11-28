//! Per-client rate limits for the endpoints anyone can call without a seat:
//! creating a room and joining one (Standards 4.10). Without them a script
//! could create rooms (each one a database row and in-memory state) or claim
//! seats as fast as it liked.
//!
//! A fixed window per client address: up to `max` requests per `window`, then
//! 429 with `Retry-After` until the window ends. In memory, which is right for
//! the single machine this runs on; the map is pruned of finished windows and
//! capped, so a flood of addresses can't grow it without bound (Standards 1.8).
//!
//! # Changes
//!
//! * 2026-11-27: Created.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Most distinct clients tracked at once. Past it, finished windows are
/// dropped first; if every tracked client is still inside its window, new
/// clients are refused until one ends - fail closed rather than grow.
const MAX_TRACKED_CLIENTS: usize = 10_000;

pub struct RateLimiter {
    max: u32,
    window: Duration,
    hits: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        RateLimiter { max, window, hits: Mutex::new(HashMap::new()) }
    }

    /// Counts a request from `client` at `now`. `Err` carries how long until
    /// the client may try again.
    pub fn check(&self, client: &str, now: Instant) -> Result<(), Duration> {
        let mut hits = self.hits.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        if !hits.contains_key(client) && hits.len() >= MAX_TRACKED_CLIENTS {
            hits.retain(|_, (started, _)| now.duration_since(*started) < self.window);
            if hits.len() >= MAX_TRACKED_CLIENTS {
                return Err(self.window);
            }
        }

        let entry = hits.entry(client.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.max {
            return Err(self.window.saturating_sub(now.duration_since(entry.0)));
        }
        entry.1 += 1;
        Ok(())
    }
}

/// The limits the server enforces, one limiter per endpoint.
pub struct Limits {
    pub create_room: RateLimiter,
    pub join_room: RateLimiter,
}

impl Default for Limits {
    /// Far above what a table of friends needs - a handful of new rooms and
    /// joins a minute - and far below what a script could do.
    fn default() -> Self {
        Limits {
            create_room: RateLimiter::new(10, Duration::from_secs(60)),
            join_room: RateLimiter::new(30, Duration::from_secs(60)),
        }
    }
}

/// Whole seconds for `Retry-After`, rounded up so a client never retries early.
pub fn retry_after_seconds(wait: Duration) -> u64 {
    wait.as_secs() + u64::from(wait.subsec_nanos() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_the_limit_then_refuses_until_the_window_ends() {
        let limiter = RateLimiter::new(3, Duration::from_secs(60));
        let start = Instant::now();
        for _ in 0..3 {
            assert!(limiter.check("1.2.3.4", start).is_ok());
        }
        let wait = limiter.check("1.2.3.4", start + Duration::from_secs(20)).unwrap_err();
        assert_eq!(wait, Duration::from_secs(40), "the rest of the window");
        assert!(limiter.check("1.2.3.4", start + Duration::from_secs(60)).is_ok(), "a new window");
    }

    #[test]
    fn clients_are_counted_separately() {
        let limiter = RateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        assert!(limiter.check("a", now).is_ok());
        assert!(limiter.check("a", now).is_err());
        assert!(limiter.check("b", now).is_ok());
    }

    #[test]
    fn a_refused_request_does_not_extend_the_wait() {
        let limiter = RateLimiter::new(1, Duration::from_secs(10));
        let start = Instant::now();
        limiter.check("a", start).unwrap();
        for second in 1..10 {
            assert!(limiter.check("a", start + Duration::from_secs(second)).is_err());
        }
        assert!(limiter.check("a", start + Duration::from_secs(10)).is_ok());
    }

    #[test]
    fn the_map_stays_bounded() {
        let limiter = RateLimiter::new(1, Duration::from_secs(60));
        let start = Instant::now();
        for i in 0..MAX_TRACKED_CLIENTS {
            limiter.check(&format!("c{i}"), start).unwrap();
        }
        assert!(limiter.check("one-too-many", start).is_err(), "full and nobody's window has ended");
        let later = start + Duration::from_secs(61);
        assert!(limiter.check("one-too-many", later).is_ok(), "finished windows are pruned to make room");
        assert!(limiter.hits.lock().unwrap().len() <= MAX_TRACKED_CLIENTS);
    }

    #[test]
    fn retry_after_rounds_up() {
        assert_eq!(retry_after_seconds(Duration::from_millis(1500)), 2);
        assert_eq!(retry_after_seconds(Duration::from_secs(40)), 40);
        assert_eq!(retry_after_seconds(Duration::ZERO), 0);
    }
}
