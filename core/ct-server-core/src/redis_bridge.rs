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

use crate::util::debounce::{Coalescer, Decision, DEFAULT_WINDOW};
use crate::{admin, singbox, Result};
use redis::{aio::ConnectionManager, AsyncCommands, Client};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
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

/// Spawn the subscriber. Returns immediately; the actual loop runs
/// on its own tokio task. Errors during the loop are logged and the
/// subscriber reconnects with exponential backoff — Redis being down
/// must not take the daemon down.
pub fn spawn(
    redis_url: String,
    database_url: Option<String>,
    template: String,
    output: String,
    admin_socket: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // The coalescer is shared between the subscriber loop (which
        // calls `admit`) and the trailing-flush task (which calls
        // `on_flush`). A `tokio::sync::Mutex` is fine — both touch it
        // briefly and never across an `.await` that depends on the
        // other side.
        let coalescer: Arc<Mutex<Coalescer>> =
            Arc::new(Mutex::new(Coalescer::new(DEFAULT_WINDOW)));

        let mut backoff_ms = 250_u64;
        loop {
            match run_subscriber(
                &redis_url,
                &database_url,
                &template,
                &output,
                &admin_socket,
                &coalescer,
            )
            .await
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
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
    coalescer: &Arc<Mutex<Coalescer>>,
) -> Result<()> {
    let client = Client::open(redis_url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(REVOCATION_CHANNEL).await?;
    tracing::info!(channel = REVOCATION_CHANNEL, window_ms = DEFAULT_WINDOW.as_millis() as u64,
        "redis subscriber attached (with leading-edge + trailing-flush coalescer)");

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
        let decision = coalescer.lock().await.admit(Instant::now());

        match decision {
            Decision::Suppress => {
                // Already in a window. The trailing-flush task that
                // was scheduled by the leading-edge admit will pick
                // up our state when it runs.
            }
            Decision::FireNow | Decision::FireNowAndScheduleFlush => {
                fire_reload(database_url, template, output, admin_socket, "leading").await;
                if matches!(decision, Decision::FireNowAndScheduleFlush) {
                    schedule_flush(
                        coalescer.clone(),
                        database_url.clone(),
                        template.to_owned(),
                        output.to_owned(),
                        admin_socket.to_owned(),
                    );
                }
            }
        }
    }
    Ok(())
}

/// Run one Caddyfile-render + admin-API-reload cycle. Errors are
/// logged but never propagated — a failed reload must not kill the
/// subscriber loop, since the next event will retry the work.
async fn fire_reload(
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
    edge: &'static str,
) {
    let started = Instant::now();
    if let Err(e) = singbox::render(database_url, template, output, false, false).await {
        tracing::warn!(error = %e, edge, "render failed during revocation");
        return;
    }
    if let Err(e) = admin::reload_caddyfile_text(admin_socket, output).await {
        tracing::warn!(error = %e, edge, "reload failed during revocation");
        return;
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::info!(edge, elapsed_ms, "caddy reload applied");
}

/// Wait one window, then run the trailing flush. The flush itself
/// only runs the reload if something was suppressed during the
/// window — `Coalescer::on_flush` returns false when the burst
/// happened to end exactly at the leading edge.
fn schedule_flush(
    coalescer: Arc<Mutex<Coalescer>>,
    database_url: Option<String>,
    template: String,
    output: String,
    admin_socket: String,
) {
    tokio::spawn(async move {
        tokio::time::sleep(DEFAULT_WINDOW).await;
        let needs_flush = {
            let mut g = coalescer.lock().await;
            g.on_flush(Instant::now())
        };
        if needs_flush {
            fire_reload(&database_url, &template, &output, &admin_socket, "trailing").await;
        } else {
            tracing::debug!("trailing flush skipped — no suppressed events");
        }
    });
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

/// Steady-state account status reader. The panel writes
/// `account:status:<username>` to "active" / "expired" / "revoked"
/// on every save; the daemon can consult it as a side channel
/// (currently informational only — Caddyfile is still the auth
/// authority).
#[allow(dead_code)]
pub async fn read_account_status(
    conn: &Arc<Mutex<ConnectionManager>>,
    username: &str,
) -> Result<Option<String>> {
    let mut guard = conn.lock().await;
    let key = format!("account:status:{username}");
    let val: Option<String> = guard.get(&key).await?;
    Ok(val)
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
}
