//! Per-key fixed-window debouncer + leading-edge throttle with
//! trailing flush. Used by [`crate::redis_bridge`] to collapse a
//! burst of revocation messages — bulk Filament saves can fire
//! dozens per second — down to one Caddyfile re-render + reload per
//! window.
//!
//! Two primitives, both single-threaded by design (wrap in
//! `tokio::sync::Mutex` to share across tasks):
//!
//! 1. [`Debouncer`] — admit at most one event per key per window.
//!    Bursts inside the window are dropped. The first event after
//!    the window wins. Mirrors the macOS client's
//!    `cool_tunnel_core::util::debounce::Debouncer` (with the same
//!    `2 × window` lazy-prune contract) so the design intuition
//!    transfers.
//!
//! 2. [`Coalescer`] — leading-edge fire with a trailing flush. When
//!    a burst arrives, fire **once now**, suppress the rest, then
//!    fire **once more** at `window` if anything was suppressed.
//!    This is the right shape for "reload Caddy" — the operator
//!    sees an immediate reload AND the final reload reflects the
//!    last save in the burst. Without the trailing flush, the last
//!    Filament save could be silently held back for `window` ms; with
//!    only the trailing flush, every burst pays one window of
//!    latency before the user sees anything.
//!
//! ## Window choice
//!
//! `100ms` is the default — same as the client's anomaly debouncer.
//! The Caddy admin-socket reload itself takes ~30 ms, so anything
//! shorter than ~50ms means consecutive reload calls overlap; anything
//! longer than ~250ms makes bulk Filament saves feel laggy in the UI.
//! 100 ms hits the right middle.

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

/// Map size at which [`Debouncer::admit`] starts running its
/// opportunistic prune. Below this we trust the caller's key set is
/// small; above it we do an O(n) `retain` walk on every admit, which
/// is cheap up to a few hundred keys and bounds memory growth.
pub const PRUNE_THRESHOLD: usize = 64;

/// Default suppression window. Matches the macOS client's
/// `ANOMALY_DEBOUNCE` constant; chosen so consecutive Caddy reloads
/// don't overlap (~30 ms each) and bulk-save UX stays responsive.
pub const DEFAULT_WINDOW: Duration = Duration::from_millis(100);

/// Per-key fixed-window debouncer. See module docs.
///
/// `K` is whatever uniquely identifies a burst — production uses
/// the [`Coalescer`] below; this Debouncer is exposed for future
/// per-account / per-event-type work and is exercised by the
/// stress tests.
#[derive(Debug)]
#[allow(dead_code)] // Debouncer is library-style; in v0.0.3 only the Coalescer is wired into redis_bridge
pub struct Debouncer<K> {
    window: Duration,
    last_admitted: HashMap<K, Instant>,
}

#[allow(dead_code)] // see struct comment
impl<K> Debouncer<K>
where
    K: Eq + Hash,
{
    /// Creates an empty debouncer with the given suppression window.
    /// A window of zero degenerates into "always admit" — useful
    /// for tests but never for production code paths.
    #[must_use]
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_admitted: HashMap::new(),
        }
    }

    /// Returns `true` when the event should fire; `false` when it falls
    /// inside the suppression window of a previous admission for the
    /// same key.
    ///
    /// On a `true` return the per-key timestamp updates to `now`. A
    /// burst of suppressed events does **not** extend the window —
    /// the next admission still happens exactly `window` after the
    /// most recent *admitted* event, not after the last *seen* event.
    /// This is the contract the burst-collapse stress test enforces.
    pub fn admit(&mut self, key: K, now: Instant) -> bool {
        if self.last_admitted.len() >= PRUNE_THRESHOLD {
            self.prune_stale(now);
        }
        match self.last_admitted.get(&key) {
            Some(prev) if now.duration_since(*prev) < self.window => false,
            _ => {
                self.last_admitted.insert(key, now);
                true
            }
        }
    }

    /// Drops every key whose last admission is older than
    /// `2 × window`. Callers can invoke this proactively (slow timer)
    /// to bound the map without waiting for the lazy prune in
    /// [`admit`](Self::admit).
    ///
    /// The `2 × window` cutoff is conservative — we keep entries one
    /// full window past their effective expiry so a probe arriving
    /// slightly out of order cannot re-admit a recently-suppressed
    /// key.
    #[allow(dead_code)] // exposed for callers that prune on a slow timer
    pub fn prune_stale(&mut self, now: Instant) {
        let cutoff = self.window.saturating_mul(2);
        self.last_admitted
            .retain(|_, prev| now.duration_since(*prev) < cutoff);
    }

    #[allow(dead_code)] // exposed for restart-state-clearing callers
    pub fn reset(&mut self) {
        self.last_admitted.clear();
    }

    #[must_use]
    #[allow(dead_code)] // exposed for introspection / tests
    pub fn window(&self) -> Duration {
        self.window
    }

    #[must_use]
    #[allow(dead_code)] // exposed for introspection / tests
    pub fn tracked_keys(&self) -> usize {
        self.last_admitted.len()
    }
}

impl<K: Eq + Hash> Default for Debouncer<K> {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW)
    }
}

// =====================================================================

/// Decision returned by [`Coalescer::admit`]. Tells the caller what to
/// do *now*; the caller is responsible for honouring [`FireNowSchedule`]
/// (run an action immediately, optionally schedule the trailing flush).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Fire the action now. No trailing flush is needed — this is the
    /// first event after a quiet period and nothing is queued.
    /// Currently unused by `redis_bridge` (it always returns
    /// `FireNowAndScheduleFlush` for leading edges); reserved for
    /// future callers that want a one-shot leading-only fire.
    #[allow(dead_code)]
    FireNow,
    /// Suppress the event. A trailing flush is already scheduled for
    /// some earlier admission. The caller does nothing.
    Suppress,
    /// Fire the action now, AND schedule a trailing flush at
    /// `now + window`. Returned by [`Coalescer::admit`] for the first
    /// event of a burst.
    FireNowAndScheduleFlush,
}

/// Leading-edge throttle with trailing flush. See module docs.
///
/// Single-threaded; wrap in `tokio::sync::Mutex` to share across tasks.
#[derive(Debug)]
pub struct Coalescer {
    window: Duration,
    /// Time of the last `FireNow*` admission. None at startup.
    last_fired: Option<Instant>,
    /// True iff at least one event arrived inside the current window
    /// after `last_fired` and was suppressed. The trailing flush is
    /// the responsibility of the *consumer* — when it runs the
    /// scheduled flush at `last_fired + window` it must call
    /// [`Coalescer::on_flush`] to clear this flag.
    pending_flush: bool,
}

impl Coalescer {
    #[must_use]
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_fired: None,
            pending_flush: false,
        }
    }

    /// Decide what to do with an incoming event.
    pub fn admit(&mut self, now: Instant) -> Decision {
        match self.last_fired {
            None => {
                self.last_fired = Some(now);
                self.pending_flush = false;
                Decision::FireNowAndScheduleFlush
            }
            Some(prev) if now.duration_since(prev) >= self.window => {
                self.last_fired = Some(now);
                self.pending_flush = false;
                Decision::FireNowAndScheduleFlush
            }
            Some(_) => {
                // Inside the window — suppress, but remember we
                // suppressed something so the trailing flush fires.
                self.pending_flush = true;
                Decision::Suppress
            }
        }
    }

    /// Called by the consumer after it executes a trailing-flush
    /// action at `last_fired + window`. Returns `true` if the flush
    /// actually had something to flush; `false` if the burst happened
    /// to end exactly at the leading edge and no extra flush was
    /// needed (in which case the consumer can skip the work entirely
    /// — but checking here is cheaper than an empty render+reload).
    pub fn on_flush(&mut self, now: Instant) -> bool {
        let had_pending = self.pending_flush;
        self.pending_flush = false;
        if had_pending {
            self.last_fired = Some(now);
        }
        had_pending
    }

    /// Suppression window this Coalescer was constructed with.
    /// Read-only — changing it mid-stream would invalidate the
    /// contract callers rely on.
    #[must_use]
    #[allow(dead_code)]
    pub fn window(&self) -> Duration {
        self.window
    }

    /// True iff at least one event was suppressed since the last
    /// admit/flush — i.e. a trailing flush will do real work.
    #[must_use]
    #[allow(dead_code)]
    pub fn pending(&self) -> bool {
        self.pending_flush
    }

    /// When the most recent leading-edge admit fired. None at
    /// startup. Useful for tests and debug logging.
    #[must_use]
    #[allow(dead_code)]
    pub fn last_fired(&self) -> Option<Instant> {
        self.last_fired
    }
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    // ---------- Debouncer ----------

    #[test]
    fn debouncer_admits_first_drops_within_window_admits_after() {
        let mut d = Debouncer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(d.admit("k", t0));
        assert!(!d.admit("k", t0 + Duration::from_millis(50)));
        assert!(!d.admit("k", t0 + Duration::from_millis(99)));
        assert!(d.admit("k", t0 + Duration::from_millis(100)));
    }

    #[test]
    fn debouncer_distinct_keys_are_independent() {
        let mut d = Debouncer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(d.admit("A", t0));
        assert!(d.admit("B", t0));
        assert!(d.admit("C", t0));
        assert_eq!(d.tracked_keys(), 3);
    }

    /// Stress: hammer the debouncer with 1,000,000 duplicates inside
    /// a single window. Exactly one admission must survive.
    #[test]
    fn debouncer_stress_collapses_burst_to_one_per_window() {
        let window = Duration::from_millis(100);
        let mut d = Debouncer::new(window);
        let t0 = Instant::now();
        let mut admitted = 0_usize;
        for i in 0..1_000_000_u32 {
            // Spread 1M virtual events across 50 ms — well inside the
            // 100 ms window. Only the first should win.
            let now = t0 + Duration::from_nanos(u64::from(i) * 50_000_000 / 1_000_000);
            if d.admit("flapping", now) {
                admitted += 1;
            }
        }
        assert_eq!(admitted, 1, "expected exactly 1 admission per 100ms window");
        assert!(d.admit("flapping", t0 + Duration::from_millis(120)));
        assert!(d.admit("flapping", t0 + Duration::from_millis(240)));
    }

    /// Stress: 10,000 distinct keys, each hit twice. All 10,000 first
    /// hits should admit; all 10,000 duplicates must drop. The lazy
    /// prune is exercised heavily here (10,000 ≫ PRUNE_THRESHOLD).
    #[test]
    fn debouncer_stress_many_distinct_keys() {
        let mut d = Debouncer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        let mut first_hits = 0_usize;
        for k in 0..10_000_u32 {
            if d.admit(k, t0) {
                first_hits += 1;
            }
        }
        assert_eq!(first_hits, 10_000);

        let mut duplicates_dropped = 0_usize;
        for k in 0..10_000_u32 {
            if !d.admit(k, t0 + Duration::from_millis(50)) {
                duplicates_dropped += 1;
            }
        }
        assert_eq!(duplicates_dropped, 10_000);
    }

    /// Auto-prune fires once the map exceeds `PRUNE_THRESHOLD`.
    #[test]
    fn debouncer_admit_lazy_prunes_when_over_threshold() {
        let mut d = Debouncer::new(Duration::from_millis(100));
        let base = Instant::now();
        let stale = base;
        let now = base + Duration::from_secs(60);

        for k in 0..PRUNE_THRESHOLD {
            d.admit(k, stale);
        }
        assert_eq!(d.tracked_keys(), PRUNE_THRESHOLD);
        assert!(d.admit(usize::MAX, now));
        assert_eq!(d.tracked_keys(), 1, "lazy prune should drop stale entries");
    }

    #[test]
    fn debouncer_reset_clears_state() {
        let mut d = Debouncer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(d.admit("k", t0));
        d.reset();
        assert!(d.admit("k", t0 + Duration::from_millis(1)));
        assert_eq!(d.tracked_keys(), 1);
    }

    #[test]
    fn debouncer_default_is_100ms() {
        let d: Debouncer<&str> = Debouncer::default();
        assert_eq!(d.window(), DEFAULT_WINDOW);
        assert_eq!(d.tracked_keys(), 0);
    }

    // ---------- Coalescer ----------

    #[test]
    fn coalescer_first_event_fires_now_and_schedules_flush() {
        let mut c = Coalescer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert_eq!(c.admit(t0), Decision::FireNowAndScheduleFlush);
        assert!(c.last_fired().is_some());
        assert!(!c.pending(), "no suppressed events yet");
    }

    #[test]
    fn coalescer_burst_fires_once_then_flushes_once() {
        let mut c = Coalescer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        // First event — fire + schedule flush.
        assert_eq!(c.admit(t0), Decision::FireNowAndScheduleFlush);
        // 50 more events inside the window — all suppressed.
        for i in 1..=50 {
            assert_eq!(
                c.admit(t0 + Duration::from_millis(i)),
                Decision::Suppress,
                "iteration {i} should suppress"
            );
        }
        assert!(c.pending(), "trailing flush must be pending after burst");

        // The scheduled flush fires at t0 + window = t0 + 100ms.
        // Verify it returns "had something to flush".
        let flush_t = t0 + Duration::from_millis(100);
        assert!(c.on_flush(flush_t));
        assert!(!c.pending());
        assert_eq!(c.last_fired(), Some(flush_t));
    }

    #[test]
    fn coalescer_idle_then_event_after_window_fires_immediately() {
        let mut c = Coalescer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert_eq!(c.admit(t0), Decision::FireNowAndScheduleFlush);
        // No more events. Flush at t0+100ms — nothing pending.
        assert!(!c.on_flush(t0 + Duration::from_millis(100)));

        // Long idle, then a single new event well past the window.
        let t1 = t0 + Duration::from_millis(500);
        assert_eq!(c.admit(t1), Decision::FireNowAndScheduleFlush);
        assert!(!c.pending());
    }

    /// Stress: 100,000 events inside a 100ms window. Exactly one
    /// FireNow* and at most one trailing flush — total 2 reloads.
    /// 10× the previous version of this test.
    #[test]
    fn coalescer_stress_burst_collapses_to_at_most_two_fires() {
        let mut c = Coalescer::new(Duration::from_millis(100));
        let t0 = Instant::now();
        let mut fires = 0_usize;

        for i in 0..100_000_u32 {
            let now = t0 + Duration::from_nanos(u64::from(i) * 50_000_000 / 100_000);
            match c.admit(now) {
                Decision::FireNow | Decision::FireNowAndScheduleFlush => fires += 1,
                Decision::Suppress => {}
            }
        }
        assert_eq!(fires, 1, "leading-edge fire should win exactly once");

        // Flush after the burst — counts as the trailing fire.
        if c.on_flush(t0 + Duration::from_millis(100)) {
            fires += 1;
        }
        assert_eq!(fires, 2, "100k events collapse to ≤ 2 reloads");
    }

    /// Concurrent stress: the way `redis_bridge` actually uses the
    /// Coalescer is `Arc<tokio::sync::Mutex<Coalescer>>` shared
    /// between many tasks (each pubsub message). This test simulates
    /// 64 tokio tasks racing to admit 1,000 events each into the same
    /// coalescer and verifies the FireNow* count is ≤ 2 per window
    /// regardless of contention.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn coalescer_concurrent_admits_collapse_correctly() {
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let coalescer = Arc::new(Mutex::new(Coalescer::new(Duration::from_millis(100))));
        let fires = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let t0 = Instant::now();

        let mut handles = Vec::new();
        for task in 0..64_u32 {
            let coalescer = coalescer.clone();
            let fires = fires.clone();
            handles.push(tokio::spawn(async move {
                for i in 0..1_000_u32 {
                    // Spread virtual events across 50 ms.
                    let now = t0
                        + Duration::from_nanos(
                            (u64::from(task) * 1_000 + u64::from(i)) * 50_000_000 / (64 * 1_000),
                        );
                    let decision = coalescer.lock().await.admit(now);
                    if matches!(
                        decision,
                        Decision::FireNow | Decision::FireNowAndScheduleFlush
                    ) {
                        fires.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        // Trailing flush.
        let trailing = coalescer
            .lock()
            .await
            .on_flush(t0 + Duration::from_millis(100));
        let total = fires.load(std::sync::atomic::Ordering::SeqCst) + usize::from(trailing);

        // 64 × 1000 = 64,000 events into one window. Under any
        // interleaving, at most one `FireNowAndScheduleFlush` plus
        // at most one trailing flush should land — total ≤ 2.
        assert!(
            total <= 2,
            "64-task burst over one 100ms window must collapse to ≤ 2 fires; got {total}"
        );
        assert!(
            total >= 1,
            "at least the leading edge must fire; got {total}"
        );
    }

    /// Stress: many bursts back-to-back. Each burst should emit
    /// at most 2 fires (leading + trailing). 5 bursts → ≤ 10 fires.
    #[test]
    fn coalescer_repeated_bursts_each_collapse_independently() {
        let window = Duration::from_millis(100);
        let mut c = Coalescer::new(window);
        let mut t = Instant::now();
        let mut fires = 0_usize;
        for _ in 0..5 {
            // Burst of 100 events spread over 50 ms.
            for i in 0..100_u32 {
                let now = t + Duration::from_micros(u64::from(i) * 50_000 / 100);
                if matches!(
                    c.admit(now),
                    Decision::FireNow | Decision::FireNowAndScheduleFlush
                ) {
                    fires += 1;
                }
            }
            // Flush fires at t + window.
            if c.on_flush(t + window) {
                fires += 1;
            }
            // Idle gap larger than window so the next burst's first
            // event re-arms the leading edge.
            t += window + Duration::from_millis(50);
        }
        assert!(
            fires <= 10,
            "5 bursts × 100 events should collapse to ≤ 10 fires; got {fires}"
        );
        assert!(
            fires >= 5,
            "each burst must emit at least the leading fire; got {fires}"
        );
    }
}
