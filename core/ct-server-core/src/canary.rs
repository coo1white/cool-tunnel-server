// SPDX-License-Identifier: AGPL-3.0-only
//! Self-probe canary — early-warning surface for "this VPS is
//! becoming unreachable from its own network position."
//!
//! Runs every 5 minutes via Laravel's scheduler. Each invocation:
//!   1. Reads ServerConfig.{domain, doh_resolver}.
//!   2. DoH-resolves `domain` IN A through the operator's chosen
//!      resolver (shared `util::doh` helper). Asserts ≥1 answer.
//!   3. TCP-connects to docker-internal `haproxy:443` (the SNI
//!      router's listening port).
//!   4. Atomically appends the result to
//!      `server_configs.self_probe_history` (JSON column, trimmed
//!      to the last MAX_HISTORY entries via `JSON_ARRAY_APPEND`).
//!   5. Propagates the failure (if any) so the scheduler's
//!      `onFailure` hook fires and a `schedule.failed` log line
//!      surfaces alongside the recorded history entry.
//!
//! Operator surface today: `ct-server-core canary status` reads the
//! recorded history. A panel banner widget that surfaces the same
//! state in the dashboard UI without polling the CLI is a v0.0.58
//! follow-up; this column / wire shape is the contract that widget
//! will read.

use crate::contracts::{
    ContractBoundary, RecoveryScope, SemanticContract, PRINCIPLE_BOUNDED_HOSTILITY,
    PRINCIPLE_LOCAL_RECOVERY,
};
use crate::util::doh;
use crate::{db, Error, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
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
const TCP_TIMEOUT: Duration = Duration::from_secs(5);

/// Semantic contract for the canary probe boundary.
///
/// # Project Decision Logic
///
/// Five minutes is the scheduler cadence, so the TCP leg must fail within one
/// tick and leave enough time for the database history write and scheduler
/// failure hook. The 5 second timeout is intentionally below human-perceived
/// "still trying" time but above normal docker-internal connect latency. This
/// makes self-healing deterministic: every run either records an `ok` entry or
/// records a typed failure before returning `Err` for alerting.
#[doc(alias = "canary-rag-contract")]
#[doc(alias = "self-probe-contract")]
const CANARY_PROBE_CONTRACT: SemanticContract = SemanticContract::new(
    "canary-self-probe-v1",
    "scheduled DoH plus docker-internal haproxy TCP probe",
    "Record the canary result before propagating failure so UI, CLI, and scheduler all converge on the same observed state.",
    RecoveryScope::Request,
    PRINCIPLE_LOCAL_RECOVERY,
);

/// Semantic contract for the persisted canary history shape.
///
/// # Project Decision Logic
///
/// The panel only needs the recent tail to detect consecutive failures, while
/// operators benefit from a few extra samples during incident triage. Ten
/// entries gives that context without turning a singleton config row into an
/// unbounded time-series store.
#[doc(alias = "canary-history-rag-contract")]
#[doc(alias = "bounded-history-contract")]
const CANARY_HISTORY_CONTRACT: SemanticContract = SemanticContract::new(
    "canary-history-json-v1",
    "server_configs.self_probe_history JSON tail",
    "Keep only the recent health tail: enough for panel failure detection and operator context, never unbounded row growth.",
    RecoveryScope::Subsystem,
    PRINCIPLE_BOUNDED_HOSTILITY,
);

/// Contract-first surface for measuring canary reachability.
///
/// Implementations must not write history themselves. Separating measurement
/// from persistence lets AI-generated tests inject deterministic success and
/// failure outcomes without a live DoH resolver or haproxy container.
#[doc(alias = "rag-canary-probe-contract")]
#[doc(alias = "consensus-alignment-contract")]
trait CanaryProbe: ContractBoundary {
    /// Return `Ok` only when both DoH resolution and TCP connectivity pass.
    async fn check(&self, domain: &str, doh_url: &str) -> std::result::Result<(), String>;
}

/// Contract-first surface for persisting canary history.
#[doc(alias = "rag-canary-history-contract")]
trait CanaryHistoryStore: ContractBoundary {
    /// Append one entry while preserving the bounded-history invariant.
    async fn append(&self, entry: &CanaryEntry) -> Result<()>;
}

/// Production canary signal: DoH A lookup plus TCP connect to haproxy.
struct DockerNetworkCanary;

impl ContractBoundary for DockerNetworkCanary {
    fn contract(&self) -> SemanticContract {
        CANARY_PROBE_CONTRACT
    }
}

impl CanaryProbe for DockerNetworkCanary {
    async fn check(&self, domain: &str, doh_url: &str) -> std::result::Result<(), String> {
        run_probe(domain, doh_url).await
    }
}

/// MariaDB-backed canary history store.
struct SqlCanaryHistory<'a> {
    pool: &'a MySqlPool,
}

impl ContractBoundary for SqlCanaryHistory<'_> {
    fn contract(&self) -> SemanticContract {
        CANARY_HISTORY_CONTRACT
    }
}

impl CanaryHistoryStore for SqlCanaryHistory<'_> {
    async fn append(&self, entry: &CanaryEntry) -> Result<()> {
        append_history(self.pool, entry).await
    }
}

/// Run one canary probe, append the result to ServerConfig, and
/// propagate the underlying probe failure (if any) so the scheduler's
/// `onFailure` hook fires. Always writes the history entry first, so
/// the panel banner reads the same state regardless of how the cron
/// reacts.
///
/// # Errors
///
/// Returns `Err` on either a database write failure (unable to
/// record the entry) or a probe failure (DoH / TCP / config). The
/// scheduler's `onFailure` log line distinguishes these via the
/// underlying error message.
pub async fn probe(pool: &MySqlPool) -> Result<()> {
    let cfg = db::server_config(pool).await?;
    let canary = DockerNetworkCanary;
    let history = SqlCanaryHistory { pool };
    tracing::debug!(
        probe_contract = canary.contract().id(),
        history_contract = history.contract().id(),
        "running canary self-probe"
    );
    let probe_result = canary.check(&cfg.domain, &cfg.doh_resolver).await;
    let entry = match &probe_result {
        Ok(()) => CanaryEntry::ok(),
        Err(reason) => {
            tracing::warn!(reason = %reason, "self-probe failed");
            CanaryEntry::fail(reason.clone())
        }
    };
    history.append(&entry).await?;
    println!("{}", serde_json::to_string(&entry)?);
    probe_result.map_err(Error::probe)
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
            // the parse failure so the operator can capture them
            // first. Built via serde_json so control characters in
            // raw_bytes are escaped per JSON rules (Rust's `{:?}`
            // Debug emits `\u{XX}` with braces, which is invalid
            // JSON and breaks downstream `jq` consumers).
            let report = serde_json::json!({
                "history": "<corrupted>",
                "parse_error": e.to_string(),
                "raw_bytes": json,
            });
            println!("{report}");
        }
    }
    Ok(())
}

/// One probe history entry. Serializes as
/// `{"ts": "...", "status": "ok"}` or
/// `{"ts": "...", "status": "fail", "reason": "..."}` — the wire
/// shape PHP reads through `ServerConfig.self_probe_history`'s
/// `'array'` cast.
#[derive(Debug, Serialize, Deserialize)]
struct CanaryEntry {
    /// ISO-8601 UTC timestamp of when the probe ran.
    ts: String,
    /// Externally-tagged: serde flattens the discriminant into the
    /// outer object as the `status` key, putting any failure
    /// `reason` alongside it. Identical wire form to the prior
    /// stringly-typed `status: String + reason: Option<String>`
    /// shape, but compile-time exhaustive at write sites.
    #[serde(flatten)]
    status: CanaryStatus,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
enum CanaryStatus {
    Ok,
    Fail { reason: String },
}

impl CanaryEntry {
    fn ok() -> Self {
        Self {
            ts: Utc::now().to_rfc3339(),
            status: CanaryStatus::Ok,
        }
    }

    fn fail(reason: String) -> Self {
        Self {
            ts: Utc::now().to_rfc3339(),
            status: CanaryStatus::Fail { reason },
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

    doh::resolve_a(domain, doh_url)
        .await
        .map_err(|e| format!("DoH lookup failed: {e}"))?;

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
/// `JSON_ARRAY_APPEND(<col-or-null>, '$', <new>)` returns NULL when
/// the existing column is NULL, so we COALESCE to an empty array
/// first. `JSON_EXTRACT(?, '$')` is the idiom for "treat this string
/// parameter as JSON and embed the parsed value" — without it,
/// MariaDB would append the entire JSON text as a single string-
/// typed array element. Single statement = single round trip = no
/// SELECT/UPDATE race window for an operator-triggered manual
/// `ct-server-core canary probe` running concurrently with the cron.
async fn append_history(pool: &MySqlPool, entry: &CanaryEntry) -> Result<()> {
    let json = serde_json::to_string(entry)?;
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
    fn canary_entry_ok_serialises_with_status_only() {
        let e = CanaryEntry::ok();
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""status":"ok""#));
        assert!(!s.contains("reason"));
    }

    #[test]
    fn canary_entry_fail_carries_reason_alongside_status() {
        let e = CanaryEntry::fail("DoH lookup failed: timeout".into());
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""status":"fail""#));
        assert!(s.contains(r#""reason":"DoH lookup failed: timeout""#));
    }

    #[test]
    fn canary_entry_round_trips_through_serde() {
        let e = CanaryEntry::fail("test reason".into());
        let s = serde_json::to_string(&e).unwrap();
        let back: CanaryEntry = serde_json::from_str(&s).unwrap();
        match back.status {
            CanaryStatus::Fail { reason } => assert_eq!(reason, "test reason"),
            CanaryStatus::Ok => panic!("expected fail variant"),
        }
    }

    #[test]
    fn canary_entry_wire_shape_matches_prior_string_typed_form() {
        // Anchor: PHP-side `ServerConfig.self_probe_history`'s
        // `'array'` cast just `json_decode`s the column. Pre-enum,
        // the keys were {ts, status, reason?}. The serde-tagged
        // enum must produce byte-equal wire form so the panel
        // doesn't need a model migration.
        let ok = CanaryEntry::ok();
        let s = serde_json::to_string(&ok).unwrap();
        assert!(s.starts_with('{') && s.ends_with('}'));
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(parsed.get("ts").is_some(), "ts key required");
        assert_eq!(parsed["status"], "ok");
        assert!(parsed.get("reason").is_none(), "reason absent on Ok");

        let fail = CanaryEntry::fail("x".into());
        let s = serde_json::to_string(&fail).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["status"], "fail");
        assert_eq!(parsed["reason"], "x");
    }

    struct MockCanaryProbe {
        outcome: std::result::Result<(), String>,
    }

    impl ContractBoundary for MockCanaryProbe {
        fn contract(&self) -> SemanticContract {
            CANARY_PROBE_CONTRACT
        }
    }

    impl CanaryProbe for MockCanaryProbe {
        async fn check(&self, _domain: &str, _doh_url: &str) -> std::result::Result<(), String> {
            self.outcome.clone()
        }
    }

    #[tokio::test]
    async fn canary_probe_trait_is_mockable_for_ai_generated_tests() {
        let probe = MockCanaryProbe {
            outcome: Err("DoH lookup failed: timeout".into()),
        };

        let result = probe
            .check("example.com", "https://resolver.example/dns-query")
            .await;

        assert_eq!(probe.contract().id(), "canary-self-probe-v1");
        assert_eq!(result.unwrap_err(), "DoH lookup failed: timeout");
    }

    #[test]
    fn canary_contracts_pin_history_recovery_scope() {
        assert_eq!(
            CANARY_PROBE_CONTRACT.recovery_scope(),
            RecoveryScope::Request
        );
        assert_eq!(
            CANARY_HISTORY_CONTRACT.recovery_scope(),
            RecoveryScope::Subsystem
        );
        assert_eq!(CANARY_HISTORY_CONTRACT.id(), "canary-history-json-v1");
    }
}
