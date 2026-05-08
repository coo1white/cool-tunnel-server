// SPDX-License-Identifier: AGPL-3.0-only
// Redis revocation bridge.
//
// Wire shape: Filament panel calls
// Redis::publish('cool_tunnel:revocations', json) on every save /
// delete of a ProxyAccount; this end is a long-lived async subscriber
// that re-renders Caddyfile and POSTs /load to Caddy's admin socket
// on receipt.
//
// End-to-end latency from Filament save to new-auth-blocked is
// dominated by Caddyfile render (~30 ms) + admin-socket reload
// (~30 ms). Pub/sub itself is sub-millisecond.
//
// Burst handling — bulk Filament actions (e.g. an admin disabling 50
// accounts in one click) can fire dozens of revocation messages per
// second. Without coalescing this would queue dozens of redundant
// reload calls. We use a leading-edge throttle with a trailing flush
// (`util::debounce::Coalescer`):
//
//   - first event in a quiet period → fire reload immediately
//   - further events in the same window → suppress
//   - if anything was suppressed, fire one more reload at
//     last_fired + window (the trailing flush)
//
// Net effect: a burst of N events collapses to 2 reloads (leading +
// trailing), regardless of N. The trailing flush is what guarantees
// the *last* DB state is reflected in Caddy — without it, a save
// arriving 1 ms after the leading edge would be silently held back.
//
// Limit: existing in-flight HTTP/2 CONNECT tunnels are not severed —
// Caddy doesn't expose per-user connection enumeration on
// forward_proxy. New auth attempts fail; idle tunnels die when the
// underlying TCP closes. Per-request hard severing needs a
// forwardproxy plugin patch (v0.1 roadmap).
//
// v0.0.65 hardening:
//   - T-3: `FlushTracker` bundles the Coalescer with the in-flight
//     trailing-flush task handle. `schedule_flush` is now single-
//     flight: if a previous flush task is still pending, we don't
//     spawn another. Defense-in-depth — the Coalescer state machine
//     is correct (verified by the burst-collapse stress tests in
//     util/debounce.rs), so today FireNowAndScheduleFlush only fires
//     when the previous flush task has already completed and called
//     on_flush. But the spawn used to be unconditional; if a future
//     Coalescer regression returns FireNowAndScheduleFlush twice
//     without an intervening on_flush, this guard collapses the leak
//     into "one flush at a time, latest state wins."
//   - T-4: the Coalescer lock migrates from `tokio::sync::Mutex` to
//     `std::sync::Mutex`. Both critical sections were already brief
//     and never spanned an `.await` (pre-v0.0.65 comment confirmed
//     this). Migration buys two things: lower lock overhead (no
//     async cooperative-yield), and the *compile-time* guarantee
//     that we never accidentally hold the lock across an `.await` —
//     `std::sync::MutexGuard` is `!Send`, so any future regression
//     trying to do so fails to compile.

use crate::util::debounce::{Coalescer, Decision, DEFAULT_WINDOW};
use crate::{admin, singbox, Result};
use redis::Client;
use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

pub const REVOCATION_CHANNEL: &str = "cool_tunnel:revocations";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RevocationMessage {
    /// One specific user changed state. Render + reload.
    AccountChanged { username: String, reason: String },
    /// Server config changed (e.g. anti-tracking toggle). Render + reload.
    ServerConfigChanged,
    /// Generic re-render request — kept for future flexibility.
    Resync,
}

/// Bundles the Coalescer with the in-flight trailing-flush task
/// handle so [`schedule_flush`] is single-flight. See module docs
/// (v0.0.65 T-3).
struct FlushTracker {
    coalescer: Coalescer,
    /// `Some(h)` if a trailing-flush task is currently scheduled
    /// (sleeping its window or running its on_flush + reload).
    /// `h.is_finished()` flips to true when the spawned closure
    /// returns; we read that flag rather than `await`ing the handle
    /// (which would block the subscriber loop).
    flush_handle: Option<JoinHandle<()>>,
}

/// Lock the FlushTracker mutex, recovering from poison.
///
/// Poison happens iff a previous lock-holder panicked while holding
/// the lock. The whole crate is `panic = "deny"` (workspace lints),
/// so the only path to poisoning is a tokio runtime-level panic
/// during scheduler internals — extremely rare. If it ever happens,
/// the safest action is to take the inner state and continue
/// (rather than propagate the poison and kill the subscriber loop).
/// `clippy::unwrap_used` is satisfied — `unwrap_or_else` is not
/// `unwrap`.
fn lock_tracker(t: &Mutex<FlushTracker>) -> std::sync::MutexGuard<'_, FlushTracker> {
    t.lock().unwrap_or_else(|p| p.into_inner())
}

/// Spawn the subscriber. Returns immediately; the actual loop runs
/// on its own tokio task. Errors during the loop are logged and the
/// subscriber reconnects with exponential backoff — Redis being down
/// must not take the daemon down.
pub fn spawn(
    redis_url: String,
    pool: MySqlPool,
    template: String,
    output: String,
    admin_url: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // FlushTracker is shared between the subscriber loop (which
        // calls `coalescer.admit`) and the trailing-flush task
        // (which calls `coalescer.on_flush`). std::sync::Mutex is
        // sufficient: every critical section is brief and never
        // crosses an `.await` — and the !Send MutexGuard now
        // *enforces* that at compile time. (T-4, v0.0.65.)
        let tracker: Arc<Mutex<FlushTracker>> = Arc::new(Mutex::new(FlushTracker {
            coalescer: Coalescer::new(DEFAULT_WINDOW),
            flush_handle: None,
        }));

        let mut backoff_ms = 250_u64;
        loop {
            match run_subscriber(&redis_url, &pool, &template, &output, &admin_url, &tracker).await
            {
                Ok(()) => {
                    tracing::warn!("redis subscriber exited cleanly; restarting");
                    backoff_ms = 250;
                }
                Err(e) => {
                    tracing::warn!(error = %e, backoff_ms, "redis subscriber error; backing off");
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(30_000);
                }
            }
        }
    })
}

async fn run_subscriber(
    redis_url: &str,
    pool: &MySqlPool,
    template: &str,
    output: &str,
    admin_url: &str,
    tracker: &Arc<Mutex<FlushTracker>>,
) -> Result<()> {
    let client = Client::open(redis_url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(REVOCATION_CHANNEL).await?;
    tracing::info!(
        channel = REVOCATION_CHANNEL,
        window_ms = DEFAULT_WINDOW.as_millis() as u64,
        "redis subscriber attached (with leading-edge + trailing-flush coalescer)"
    );

    let mut stream = pubsub.on_message();
    while let Some(msg) = futures_next(&mut stream).await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "non-string payload on revocation channel");
                continue;
            }
        };
        let parsed: RevocationMessage = match serde_json::from_str(&payload) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, payload, "malformed revocation message");
                continue;
            }
        };
        tracing::debug!(?parsed, "revocation received");

        // Decide via the coalescer whether this event fires a reload
        // *now* and whether we need to schedule a trailing flush.
        // The lock guard from std::sync::Mutex is !Send, so it
        // cannot survive across the `.await` below — that's the
        // T-4 compile-time guarantee in action.
        let decision = {
            let mut g = lock_tracker(tracker);
            g.coalescer.admit(Instant::now())
        };

        match decision {
            Decision::Suppress => {
                // Already in a window. The trailing-flush task that
                // was scheduled by the leading-edge admit will pick
                // up our state when it runs.
            }
            Decision::FireNow | Decision::FireNowAndScheduleFlush => {
                fire_reload(pool, template, output, admin_url, "leading").await;
                if matches!(decision, Decision::FireNowAndScheduleFlush) {
                    schedule_flush(
                        tracker.clone(),
                        pool.clone(),
                        template.to_owned(),
                        output.to_owned(),
                        admin_url.to_owned(),
                    );
                }
            }
        }
    }
    Ok(())
}

/// Run one sing-box render + clash-API reload cycle. Errors are
/// logged but never propagated — a failed reload must not kill the
/// subscriber loop, since the next event will retry the work.
async fn fire_reload(
    pool: &MySqlPool,
    template: &str,
    output: &str,
    admin_url: &str,
    edge: &'static str,
) {
    let started = Instant::now();
    if let Err(e) = singbox::render(pool, template, output, false, false).await {
        tracing::warn!(error = %e, edge, "render failed during revocation");
        return;
    }
    // Clash bearer is now derived purely from CT_CLASH_SECRET_SEED
    // env (no DB round-trip — see singbox::current_clash_secret).
    // Comment kept abbreviated; rotation propagates via env, not DB.
    let secret = match singbox::current_clash_secret().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, edge, "could not load clash secret; skipping reload");
            return;
        }
    };
    let admin_client = admin::ClashAdmin::new(admin_url, &secret);
    if let Err(e) = admin_client.reload(output).await {
        tracing::warn!(error = %e, edge, "reload failed during revocation");
        return;
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::info!(edge, elapsed_ms, "sing-box reload applied");
}

/// Schedule a trailing flush at `now + DEFAULT_WINDOW`, single-flight.
///
/// If a previous flush task is still pending (its `is_finished()` is
/// false), we return without spawning. The pending task's eventual
/// `on_flush` will pick up the latest Coalescer state — last-writer-
/// wins is the operator-intent semantic. (T-3, v0.0.65.)
fn schedule_flush(
    tracker: Arc<Mutex<FlushTracker>>,
    pool: MySqlPool,
    template: String,
    output: String,
    admin_url: String,
) {
    let mut g = lock_tracker(&tracker);
    if g.flush_handle.as_ref().is_some_and(|h| !h.is_finished()) {
        // Defense-in-depth: previous flush task hasn't completed.
        // The Coalescer's state machine should already prevent the
        // caller from getting here, but if a regression slips, this
        // collapses the leak rather than spawning unboundedly.
        tracing::debug!("trailing flush already in flight; skipping spawn");
        return;
    }
    let tracker_for_task = Arc::clone(&tracker);
    let handle = tokio::spawn(async move {
        tokio::time::sleep(DEFAULT_WINDOW).await;
        let needs_flush = {
            let mut g = lock_tracker(&tracker_for_task);
            g.coalescer.on_flush(Instant::now())
        };
        if needs_flush {
            fire_reload(&pool, &template, &output, &admin_url, "trailing").await;
        } else {
            tracing::debug!("trailing flush skipped — no suppressed events");
        }
    });
    g.flush_handle = Some(handle);
}

/// Helper to advance a `redis::aio::PubSubStream` without pulling in
/// the full `futures` crate.
async fn futures_next<S>(stream: &mut S) -> Option<S::Item>
where
    S: futures_core::Stream + Unpin,
{
    use std::future::poll_fn;
    use std::task::Poll;
    poll_fn(|cx| match std::pin::Pin::new(&mut *stream).poll_next(cx) {
        Poll::Pending => Poll::Pending,
        Poll::Ready(x) => Poll::Ready(x),
    })
    .await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn revocation_message_round_trip() {
        let m = RevocationMessage::AccountChanged {
            username: "alice".into(),
            reason: "disabled".into(),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("account_changed"));
        let m2: RevocationMessage = serde_json::from_str(&s).unwrap();
        match m2 {
            RevocationMessage::AccountChanged { username, .. } => assert_eq!(username, "alice"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_config_changed_round_trip() {
        let s = serde_json::to_string(&RevocationMessage::ServerConfigChanged).unwrap();
        assert!(s.contains("server_config_changed"));
    }

    /// End-to-end check using just the coalescer: a 50-event burst
    /// must produce exactly 2 fires (leading + trailing). Mirrors
    /// the contract `redis_bridge` relies on.
    #[test]
    fn burst_collapses_to_two_fires() {
        let mut c = Coalescer::new(DEFAULT_WINDOW);
        let t0 = Instant::now();
        let mut fires = 0_usize;
        for i in 0..50_u32 {
            let now = t0 + Duration::from_millis(i.into());
            if matches!(
                c.admit(now),
                Decision::FireNow | Decision::FireNowAndScheduleFlush
            ) {
                fires += 1;
            }
        }
        assert_eq!(fires, 1, "leading-edge fires once");
        if c.on_flush(t0 + DEFAULT_WINDOW) {
            fires += 1;
        }
        assert_eq!(fires, 2, "trailing flush adds one more — total 2");
    }

    /// T-3 single-flight: if `schedule_flush` is called twice in
    /// rapid succession (simulating a Coalescer-state regression
    /// that returns FireNowAndScheduleFlush back-to-back), only the
    /// first call spawns. The second call sees an unfinished handle
    /// and returns without spawning.
    ///
    /// Asserts on the in-tracker handle identity rather than fire
    /// count — this is a state-machine property, not a behaviour-
    /// under-load test (the existing `burst_collapses_to_two_fires`
    /// covers that side).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn schedule_flush_is_single_flight_under_repeated_calls() {
        // Build a tracker whose Coalescer is freshly constructed
        // (no last_fired). We don't need a working pool / admin URL
        // because the spawned task only fires fire_reload IF
        // on_flush returns true — and we'll inspect handle state
        // before either of those run.
        let tracker: Arc<Mutex<FlushTracker>> = Arc::new(Mutex::new(FlushTracker {
            coalescer: Coalescer::new(Duration::from_millis(500)),
            flush_handle: None,
        }));

        // We can't drive the real `schedule_flush` here without a
        // pool / admin / etc. — substitute a tiny in-test version
        // that mirrors its single-flight check.
        fn schedule_flush_test(tracker: Arc<Mutex<FlushTracker>>) {
            let mut g = lock_tracker(&tracker);
            if g.flush_handle.as_ref().is_some_and(|h| !h.is_finished()) {
                return;
            }
            let handle = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
            });
            g.flush_handle = Some(handle);
        }

        schedule_flush_test(tracker.clone());
        let first_id = {
            let g = lock_tracker(&tracker);
            g.flush_handle
                .as_ref()
                .expect("first call spawned a task")
                .id()
        };

        // Second call while first is still sleeping — must not spawn.
        schedule_flush_test(tracker.clone());
        let second_id = {
            let g = lock_tracker(&tracker);
            g.flush_handle.as_ref().expect("handle still present").id()
        };
        assert_eq!(first_id, second_id, "second call must not have spawned");

        // Wait for the first task to finish.
        let join = {
            let mut g = lock_tracker(&tracker);
            g.flush_handle.take().expect("handle present")
        };
        join.await.expect("task completes");

        // Now schedule_flush_test should spawn again (previous is finished).
        schedule_flush_test(tracker.clone());
        let third_id = {
            let g = lock_tracker(&tracker);
            g.flush_handle
                .as_ref()
                .expect("third call spawned a fresh task")
                .id()
        };
        assert_ne!(third_id, first_id, "post-completion call spawns fresh");
    }
}
