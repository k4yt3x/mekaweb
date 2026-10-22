//! Rate limits: a token bucket per key (a client's network, a device, the account), kept in
//! memory. A key that runs dry waits for its bucket to refill, so guesses slow to a trickle while
//! the account's holder, who rarely mistypes twice, never notices.

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

/// How fast something may happen: `burst` at once, then one more every `every`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rate {
    pub(crate) burst: u32,
    pub(crate) every: Duration,
}

/// Sign-in attempts from one client network.
pub(crate) const SIGN_IN_PER_ADDRESS: Rate = Rate {
    burst: 10,
    every: Duration::from_secs(30),
};

/// Password guesses at the account from every network together: a ceiling that holds a crowd of
/// addresses to a few guesses a minute. Passkeys, which cannot be guessed, do not draw on it, so a
/// crowd that drains it locks out the password alone.
pub(crate) const SIGN_IN_PER_ACCOUNT: Rate = Rate {
    burst: 30,
    every: Duration::from_secs(10),
};

/// Passkey sign-in challenges asked for by one client network.
pub(crate) const CHALLENGES_PER_ADDRESS: Rate = Rate {
    burst: 20,
    every: Duration::from_secs(3),
};

/// Confirmations one signed-in device may attempt.
pub(crate) const CONFIRMS_PER_DEVICE: Rate = Rate {
    burst: 10,
    every: Duration::from_secs(30),
};

/// How often buckets that have filled up again are forgotten.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// The most keys kept. Past it, after a sweep, every bucket is forgotten: a flood from that many
/// networks resets their limits, never anyone else's, and memory stays bounded.
const MAX_KEYS: usize = 100_000;

/// Token buckets by key, all filling at one rate.
#[derive(Debug)]
pub(crate) struct Limiter {
    rate: Rate,
    buckets: Mutex<Buckets>,
}

#[derive(Debug)]
struct Buckets {
    by_key: HashMap<String, Bucket>,
    swept: Instant,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Limiter {
    /// Buckets filling at `rate`.
    pub(crate) fn new(rate: Rate) -> Self {
        Self {
            rate,
            buckets: Mutex::new(Buckets {
                by_key: HashMap::new(),
                swept: Instant::now(),
            }),
        }
    }

    /// Takes a token from `key`'s bucket: `Ok` if there was one, or how long until there is.
    pub(crate) fn take(&self, key: &str) -> Result<(), Duration> {
        self.take_at(key, Instant::now())
    }

    fn take_at(&self, key: &str, now: Instant) -> Result<(), Duration> {
        let rate = self.rate;
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let full = buckets.by_key.len() >= MAX_KEYS;
        if full || now.saturating_duration_since(buckets.swept) >= SWEEP_EVERY {
            buckets
                .by_key
                .retain(|_, bucket| level(*bucket, rate, now) < f64::from(rate.burst));
            buckets.swept = now;
            if buckets.by_key.len() >= MAX_KEYS {
                tracing::warn!("rate limits forgotten: requests came from too many networks");
                buckets.by_key.clear();
            }
        }
        let bucket = buckets.by_key.entry(key.to_owned()).or_insert(Bucket {
            tokens: f64::from(rate.burst),
            at: now,
        });
        let tokens = level(*bucket, rate, now);
        let taken = tokens >= 1.0;
        *bucket = Bucket {
            tokens: if taken { tokens - 1.0 } else { tokens },
            at: now,
        };
        drop(buckets);
        if taken {
            Ok(())
        } else {
            Err(rate.every.mul_f64(1.0 - tokens))
        }
    }
}

/// The tokens `bucket` holds at `now`.
fn level(bucket: Bucket, rate: Rate, now: Instant) -> f64 {
    let elapsed = now.saturating_duration_since(bucket.at).as_secs_f64();
    let refilled = elapsed / rate.every.as_secs_f64();
    (bucket.tokens + refilled).min(f64::from(rate.burst))
}

/// The key a client's address is limited by: an IPv4 address, or an IPv6 address's /64, which is
/// what one subscriber holds and can draw new addresses from at will.
pub(crate) fn network(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None => {
                let [a, b, c, d, ..] = ip.segments();
                format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_runs_dry_and_refills() {
        let limiter = Limiter::new(Rate {
            burst: 2,
            every: Duration::from_secs(10),
        });
        let start = Instant::now();
        assert!(limiter.take_at("a", start).is_ok());
        assert!(limiter.take_at("a", start).is_ok());
        let wait = limiter.take_at("a", start).unwrap_err();
        assert_eq!(wait, Duration::from_secs(10));
        assert!(limiter.take_at("b", start).is_ok(), "keys are apart");
        assert!(
            limiter
                .take_at("a", start + Duration::from_secs(10))
                .is_ok()
        );
    }

    #[test]
    fn a_sweep_keeps_buckets_still_filling() {
        let limiter = Limiter::new(Rate {
            burst: 30,
            every: Duration::from_secs(10),
        });
        let start = Instant::now();
        for _ in 0..30 {
            assert!(limiter.take_at("account", start).is_ok());
        }
        // A minute on, the sweep runs; six tokens have come back, not thirty.
        let later = start + SWEEP_EVERY;
        for _ in 0..6 {
            assert!(limiter.take_at("account", later).is_ok());
        }
        assert!(limiter.take_at("account", later).is_err());
    }

    #[test]
    fn ipv6_addresses_are_limited_by_their_64() {
        let one: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let two: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
        let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(network(one), network(two));
        assert_ne!(network(one), network(other));
        assert_eq!(
            network("::ffff:192.0.2.7".parse().unwrap()),
            network("192.0.2.7".parse().unwrap())
        );
    }
}
