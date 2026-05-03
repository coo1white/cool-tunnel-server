// Redis revocation bridge.
//
// One end of the wire: the Filament panel calls
// Redis::publish('cool_tunnel:revocations', json) on every save /
// delete of a ProxyAccount, and writes account:status:<username>
// keys for the steady-state view.
//
// This end: a long-lived async subscriber. On any message, re-render
// Caddyfile and POST /load to Caddy's admin socket. End-to-end latency
// from Filament save to new-auth-blocked is dominated by the Caddyfile
// render (~30 ms) + reload (~30 ms). Pub/sub itself is sub-millisecond.
//
// Limit: existing in-flight HTTP/2 CONNECT tunnels are not severed —
// Caddy doesn't expose per-user connection enumeration on forward_proxy.
// New auth attempts fail; idle tunnels die when the underlying TCP
// connection closes; active tunnels die on the next failed re-auth.
// Per-request hard severing needs a forwardproxy plugin patch
// (v0.1 roadmap).

use crate::{admin, caddyfile, Error, Result};
use redis::{aio::ConnectionManager, AsyncCommands, Client};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

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
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut backoff_ms = 250_u64;
        loop {
            match run_subscriber(
                &redis_url,
                &database_url,
                &template,
                &output,
                &admin_socket,
            )
            .await
            {
                Ok(()) => {
                    tracing::warn!("redis subscriber exited cleanly; restarting");
                    backoff_ms = 250;
                }
                Err(e) => {
                    tracing::warn!(error = %e, backoff_ms, "redis subscriber error; backing off");
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
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
) -> Result<()> {
    let client = Client::open(redis_url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(REVOCATION_CHANNEL).await?;
    tracing::info!(channel = REVOCATION_CHANNEL, "redis subscriber attached");

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

        if let Err(e) = handle(parsed, database_url, template, output, admin_socket).await {
            tracing::warn!(error = %e, "revocation handler errored; continuing subscriber");
        }
    }

    Ok(())
}

async fn handle(
    msg: RevocationMessage,
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
) -> Result<()> {
    let started = Instant::now();
    tracing::info!(?msg, "revocation received");

    // For all three variants the action is identical: re-render
    // Caddyfile from the current DB state and reload Caddy. The
    // CaddyfileGenerator already deduplicates by SHA-256, so a no-op
    // change costs essentially nothing.
    caddyfile::render(database_url, template, output, false, false).await?;
    admin::reload_caddyfile_text(admin_socket, output).await?;

    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::info!(elapsed_ms, "revocation applied");
    Ok(())
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
mod tests {
    use super::*;

    #[test]
    fn revocation_message_round_trip() {
        let m = RevocationMessage::AccountChanged {
            username: "alice".into(),
            reason: "disabled".into(),
        };
        let s = serde_json::to_string(&m).unwrap_or_default();
        assert!(s.contains("account_changed"));
        let m2: RevocationMessage = serde_json::from_str(&s).map_err(|_| ()).unwrap_or(m.clone());
        match m2 {
            RevocationMessage::AccountChanged { username, .. } => assert_eq!(username, "alice"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_config_changed_round_trip() {
        let s = serde_json::to_string(&RevocationMessage::ServerConfigChanged).unwrap_or_default();
        assert!(s.contains("server_config_changed"));
    }
}
