// Self-probe canary — early-warning surface for "this VPS is
// becoming unreachable from its own network position."
//
// Runs every 5 minutes via Laravel's scheduler. Each invocation:
//   1. Reads ServerConfig.{domain, doh_resolver}.
//   2. DoH-resolves `domain` IN A through the operator's chosen
//      resolver (shared `util::doh` helper). Asserts ≥1 answer.
//   3. TCP-connects to docker-internal `haproxy:443` (the SNI
//      router's listening port).
//   4. Atomically appends the result to
//      `server_configs.self_probe_history` (JSON column, trimmed
//      to the last MAX_HISTORY entries via `JSON_ARRAY_APPEND`).
//
// The panel reads the tail to drive a "last N self-probes failed"
// banner so blocking / DoH / haproxy issues surface ~15 min ahead
// of user complaints.
//
// What this catches:
//   - Operator's chosen DoH resolver became unreachable.
//   - DoH returns 0 answers (captive portal / DNS poisoner).
//   - haproxy crashed / failed to start.
//
// What this does NOT catch:
//   - External IP poisoning (the apex resolves correctly via the
//     VPS's egress DoH but maps to a different IP from inside
//     China). External probe infrastructure required.
//   - Sing-box crashed but haproxy still accepts connections
//     (we don't TLS-handshake into sing-box).

use crate::util::doh;
use crate::{db, Result};
use chrono::Utc;
use sqlx::MySqlPool;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Bounded history length. The panel banner reads the tail (last 3
/// entries) to count consecutive failures, so anything beyond that
/// is dead state. 10 keeps a few extra ticks of context for
/// `canary status` operator inspection without growing the column.
const MAX_HISTORY: usize = 10;

/// TCP-connect timeout for the docker-internal haproxy probe.
/// haproxy is on the same docker network as the daemon; sub-ms
/// connect time is normal. 5 s is generous enough to absorb
/// transient hiccups but short enough that a stalled probe doesn't
/// straddle the next 5-min cron tick.
const TCP_TIMEOUT: Duration = Duration::from_secs(5);

/// Run one canary probe and append the result to ServerConfig.
///
/// # Errors
///
/// Returns `Err` only on database failures — DoH / TCP failures
/// are recorded as `"fail"` history entries, not propagated. The
/// scheduler reads the recorded entries to decide what to surface;
/// returning an error here would also produce a `schedule.failed`
/// log line that says nothing useful (the entry already explains
/// the failure).
pub async fn probe(pool: &MySqlPool) -> Result<()> {
    let cfg = db::server_config(pool).await?;
    let entry = match run_probe(&cfg.domain, &cfg.doh_resolver).await {
        Ok(()) => CanaryEntry::ok(),
        Err(reason) => {
            tracing::warn!(reason = %reason, "self-probe failed");
            CanaryEntry::fail(reason)
        }
    };
    append_history(pool, &entry).await?;
    println!("{}", serde_json::to_string(&entry)?);
    Ok(())
}

/// Print the most recent probe entries as JSON-per-line — operator
/// surface for "what's the canary saying right now" without going
/// through the panel.
///
/// # Errors
///
/// Returns `Err` only on database failures. A corrupted JSON column
/// is reported inline (with a non-empty status string) rather than
/// propagated, so the operator sees the corruption instead of a
/// stack trace.
pub async fn status(pool: &MySqlPool) -> Result<()> {
    let json: Option<String> =
        sqlx::query_scalar("SELECT self_probe_history FROM server_configs WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .flatten();
    let Some(json) = json else {
        println!(r#"{{"history": [], "note": "no self-probe runs recorded yet"}}"#);
        return Ok(());
    };
    match serde_json::from_str::<Vec<CanaryEntry>>(&json) {
        Ok(history) if history.is_empty() => {
            println!(r#"{{"history": [], "note": "no self-probe runs recorded yet"}}"#);
        }
        Ok(history) => {
            for e in &history {
                println!("{}", serde_json::to_string(e)?);
            }
        }
        Err(e) => {
            // Don't return Err — the operator running `canary
            // status` to debug a probe issue must SEE the
            // corruption, not get a generic "command failed".
            // The next `canary probe` invocation will overwrite
            // with a single-entry array, which is the simplest
            // recovery path; we surface the bytes that triggered
            // the parse failure so the operator can decide
            // whether to capture them first.
            println!(
                r#"{{"history": "<corrupted>", "parse_error": {:?}, "raw_bytes": {:?}}}"#,
                e.to_string(),
                json,
            );
        }
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct CanaryEntry {
    /// ISO-8601 UTC timestamp of when the probe ran.
    ts: String,
    /// "ok" or "fail" — the panel reads this to count consecutive
    /// failures. Stringly-typed across the wire because the panel
    /// is PHP and a Rust enum variant tag would force the panel
    /// to special-case the serde-tagged shape.
    status: String,
    /// Human-readable failure reason. Surfaced in the panel banner
    /// so the operator can act without grepping docker logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl CanaryEntry {
    fn ok() -> Self {
        Self {
            ts: Utc::now().to_rfc3339(),
            status: "ok".to_owned(),
            reason: None,
        }
    }

    fn fail(reason: String) -> Self {
        Self {
            ts: Utc::now().to_rfc3339(),
            status: "fail".to_owned(),
            reason: Some(reason),
        }
    }
}

async fn run_probe(domain: &str, doh_url: &str) -> std::result::Result<(), String> {
    if domain.trim().is_empty() {
        return Err("ServerConfig.domain is empty".to_owned());
    }
    if doh_url.trim().is_empty() {
        return Err("ServerConfig.doh_resolver is empty".to_owned());
    }

    // Step 1: DoH-resolve the apex. The shared util has its own
    // 5-second per-request timeout via reqwest; no outer
    // tokio::time::timeout wrapper is needed.
    doh::resolve_a(domain, doh_url)
        .await
        .map_err(|e| format!("DoH lookup failed: {e}"))?;

    // Step 2: TCP-connect to docker-internal haproxy:443. Docker's
    // network DNS resolves "haproxy" to the haproxy service's IP;
    // 443 is the SNI router's listening port. Timeout matters here
    // because tokio's connect has no built-in cap.
    timeout(TCP_TIMEOUT, TcpStream::connect("haproxy:443"))
        .await
        .map_err(|_| format!("TCP connect to haproxy:443 timed out after {TCP_TIMEOUT:?}"))?
        .map_err(|e| format!("TCP connect to haproxy:443 failed: {e}"))?;

    Ok(())
}

/// Atomically append `entry` to the singleton ServerConfig row's
/// `self_probe_history` column, then trim to the last MAX_HISTORY
/// entries.
///
/// MariaDB's `JSON_ARRAY_APPEND(<col-or-null>, '$', <new>)` returns
/// NULL when the existing column is NULL, so we COALESCE to an
/// empty array first; the trim step uses `JSON_REMOVE` against the
/// computed positional path. Single statement = single round trip
/// = no SELECT/UPDATE race window when an operator runs `ct-server-
/// core canary probe` manually while the cron is mid-tick.
async fn append_history(pool: &MySqlPool, entry: &CanaryEntry) -> Result<()> {
    let json = serde_json::to_string(entry)?;
    // Use a CTE-shaped expression: `JSON_ARRAY_APPEND` adds the new
    // entry; the outer expression then trims the leading entries
    // when the array exceeds MAX_HISTORY. JSON path indexing is
    // 0-based; `$[0]` removes the oldest. We trim one entry per
    // tick because the array grows by exactly one per call — no
    // need to handle multi-entry overshoots.
    sqlx::query(
        "UPDATE server_configs
         SET self_probe_history = IF(
             JSON_LENGTH(COALESCE(self_probe_history, JSON_ARRAY())) >= ?,
             JSON_REMOVE(
                 JSON_ARRAY_APPEND(COALESCE(self_probe_history, JSON_ARRAY()), '$', JSON_EXTRACT(?, '$')),
                 '$[0]'
             ),
             JSON_ARRAY_APPEND(COALESCE(self_probe_history, JSON_ARRAY()), '$', JSON_EXTRACT(?, '$'))
         )
         WHERE id = 1",
    )
    .bind(i32::try_from(MAX_HISTORY).unwrap_or(i32::MAX))
    .bind(&json)
    .bind(&json)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn canary_entry_ok_serialises_without_reason_field() {
        let e = CanaryEntry::ok();
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""status":"ok""#));
        assert!(!s.contains("reason"));
    }

    #[test]
    fn canary_entry_fail_carries_reason() {
        let e = CanaryEntry::fail("DoH lookup failed: timeout".into());
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""status":"fail""#));
        assert!(s.contains("DoH lookup failed: timeout"));
    }

    #[test]
    fn canary_entry_round_trips_through_serde() {
        let e = CanaryEntry::fail("test reason".into());
        let s = serde_json::to_string(&e).unwrap();
        let back: CanaryEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back.status, "fail");
        assert_eq!(back.reason.as_deref(), Some("test reason"));
    }
}
