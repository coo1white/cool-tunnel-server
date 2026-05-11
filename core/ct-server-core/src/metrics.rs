// SPDX-License-Identifier: AGPL-3.0-only
//! Prometheus-text metrics scraper + traffic_logs writer.
//!
//! HONEST STATE (post-v0.0.2 sing-box switch): the metric names this
//! parser looks for — `caddy_forwardproxy_bytes_total{user="...",
//! direction="..."}` — are emitted by the unmaintained
//! klzgrad/forwardproxy plugin. Sing-box does NOT emit them on its
//! clash-API endpoint; sing-box's per-connection traffic stats live
//! at the streaming `/traffic` and `/connections` endpoints, which
//! don't fit a one-shot Prometheus scrape model.
//!
//! Net effect: `traffic:rollup` runs every minute (per
//! console.php's scheduler), the scrape returns zero matching
//! metrics, and `traffic_logs` doesn't move. The Filament traffic
//! stats widget shows "0 bytes" until we either:
//!
//!   1. Switch to a clash-API streaming consumer that aggregates
//!      per-username byte counters in the daemon's RAM and flushes
//!      to traffic_logs every N seconds, OR
//!   2. Wait for sing-box upstream to add a Prometheus-shaped
//!      per-user `naive_bytes_total` (there's an open issue), OR
//!   3. Patch sing-box ourselves to emit a Prometheus endpoint that
//!      matches what we parse here.
//!
//! Until then the legacy parser is preserved (it's exercised by
//! unit tests and may be useful again if/when sing-box's metric
//! surface lands in Prometheus shape) but `collect()` early-returns
//! with a one-line tracing::info on every call so the operator
//! knows traffic numbers in the panel are not authoritative yet.
//!
//! Counter semantics (kept here as historical reference): bytes_total
//! is monotonically increasing within the lifetime of the proxy
//! process; we clamp deltas to >= 0 so a process restart doesn't
//! underflow.

use crate::{admin::ClashAdmin, db, Result};
use chrono::Utc;
use sqlx::MySqlPool;
use std::collections::HashMap;

pub async fn collect(pool: &MySqlPool, admin: &ClashAdmin) -> Result<()> {
    // See module-level docstring for the honest state. Until sing-box
    // exposes per-user proxy bytes in a Prometheus-text-compatible
    // shape, this is a no-op rather than a silent failure: previous
    // code returned zero parsed metrics from sing-box's `/metrics`
    // and the Filament traffic widget showed flat zeros. Logging at
    // INFO once per scrape so an operator inspecting the panel logs
    // sees that the gap is acknowledged, not unnoticed.
    tracing::info!(
        "traffic:rollup is a no-op under sing-box (per-user Prometheus \
         metrics are a v0.1 roadmap item — see metrics.rs module docstring)"
    );

    // The legacy scrape path is preserved below for the day sing-box
    // emits Prometheus-shaped naive metrics. It returns immediately
    // when no matching metrics are present, which is always (today).
    // We connect to the DB only after both early-returns clear, so
    // the every-minute tick costs zero DB round-trips on the no-op
    // path; a misconfigured DATABASE_URL still surfaces — just the
    // first time the legacy path actually has metrics to write.
    let raw = match admin.fetch_metrics_text().await {
        Ok(t) => t,
        Err(e) => {
            tracing::debug!(error = %e, "metrics endpoint unreachable (expected)");
            return Ok(());
        }
    };

    let samples = parse_prometheus(&raw);
    if samples.is_empty() {
        tracing::debug!("no forward_proxy-shaped metrics in response (expected post-sing-box)");
        return Ok(());
    }

    let day = Utc::now().date_naive();
    let mut total = 0i64;

    // Resolve username → id once.
    let username_to_id: HashMap<String, i64> =
        sqlx::query_as::<_, (i64, String)>(r"SELECT id, username FROM proxy_accounts")
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(id, u)| (u, id))
            .collect();

    for (user, s) in &samples {
        let Some(&id) = username_to_id.get(user) else {
            continue;
        };

        // Read previous total for the day so we can compute the delta
        // to add to proxy_accounts.used_bytes.
        //
        // v0.0.82 robustness-review fix (item 5): SELECT into u64,
        // not i64. The schema columns are `unsignedBigInteger` (per
        // panel/database/migrations/2026_05_03_000004_create_traffic_logs_table.php
        // :25-26). sqlx 0.8's `query_as<_, (i64, i64)>` returns a
        // decode error the moment a value exceeds `i64::MAX`. The
        // cron tick then fails, `traffic_logs` stops moving, and
        // downstream `quota::enforce` stops disabling expired-by-
        // bytes accounts. The realistic trigger is restoring from
        // a backup written by a tool that wrote larger values; the
        // theoretical trigger is a long-lived high-traffic VPS
        // crossing 8 EB on a single account.
        let prev: Option<(u64, u64)> = sqlx::query_as(
            r"SELECT uplink_bytes, downlink_bytes FROM traffic_logs
              WHERE proxy_account_id = ? AND day = ?",
        )
        .bind(id)
        .bind(day)
        .fetch_optional(pool)
        .await?;

        let (prev_up, prev_down) = prev.unwrap_or((0u64, 0u64));

        // Sample values come from Prometheus parsing as i64 (sing-box
        // wire format is bounded). Convert to u64 for delta
        // arithmetic; clamp i64-negative readings to 0 (a malformed
        // counter line; unlikely but defensive). u64::saturating_sub
        // returns 0 when the result would be negative — which is
        // exactly the right behaviour for the "sing-box restart
        // reset the counter, current < previous" case.
        let cur_up = s.uplink.max(0) as u64;
        let cur_down = s.downlink.max(0) as u64;
        let delta_up = cur_up.saturating_sub(prev_up);
        let delta_down = cur_down.saturating_sub(prev_down);

        db::upsert_traffic(pool, id, day, s.uplink, s.downlink, s.connections).await?;
        let delta_sum: u64 = delta_up.saturating_add(delta_down);
        if delta_sum > 0 {
            // add_used_bytes signature still takes i64 (and rejects
            // > 1 PiB). Clamp at i64::MAX for the boundary cross;
            // any real value will be far below 1 PiB anyway, so
            // this only matters under pathological u64 inputs.
            let delta_i64: i64 = i64::try_from(delta_sum).unwrap_or(i64::MAX);
            db::add_used_bytes(pool, id, delta_i64).await?;
            total = total.saturating_add(delta_i64);
        }
    }

    println!("{}", outcome_json(samples.len(), total));
    Ok(())
}

/// Serialise the collect-outcome to the JSON shape the PHP panel
/// reads (`panel/app/Services/TrafficCollector.php:32` reads
/// `$out['rows']`). Pulled out as a free function so the field
/// names can be pinned by a unit test without scraping live
/// Prometheus output. Round-17 chassis-cockpit boundary.
fn outcome_json(rows: usize, total_bytes_delta: i64) -> String {
    format!(r#"{{"rows": {rows}, "total_bytes_delta": {total_bytes_delta}}}"#)
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub uplink: i64,
    pub downlink: i64,
    pub connections: i64,
}

pub fn parse_prometheus(text: &str) -> HashMap<String, Sample> {
    let mut out: HashMap<String, Sample> = HashMap::new();

    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((metric_with_labels, value)) = line.rsplit_once(' ') else {
            continue;
        };
        let Ok(value) = value.parse::<f64>() else {
            continue;
        };
        let value = value as i64;

        let (metric, labels) = match metric_with_labels.split_once('{') {
            Some((m, l)) => (m, l.trim_end_matches('}')),
            None => (metric_with_labels, ""),
        };
        if !metric.starts_with("caddy_forwardproxy_") {
            continue;
        }
        let labels = parse_labels(labels);
        let Some(user) = labels.get("user") else {
            continue;
        };
        let entry = out.entry((*user).to_string()).or_default();

        match metric {
            "caddy_forwardproxy_bytes_total" => {
                match labels.get("direction").copied().unwrap_or("") {
                    "uplink" => entry.uplink = value,
                    "downlink" => entry.downlink = value,
                    _ => {}
                }
            }
            "caddy_forwardproxy_connections_total" => entry.connections = value,
            _ => {}
        }
    }
    out
}

fn parse_labels(raw: &str) -> HashMap<&str, &str> {
    let mut out = HashMap::new();
    for kv in raw.split(',') {
        let kv = kv.trim();
        let Some((k, v)) = kv.split_once('=') else {
            continue;
        };
        let v = v.trim_matches('"');
        out.insert(k, v);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_uplink_downlink_per_user() {
        let text = r#"
# HELP caddy_forwardproxy_bytes_total bytes proxied
# TYPE caddy_forwardproxy_bytes_total counter
caddy_forwardproxy_bytes_total{user="alice",direction="uplink"} 1024
caddy_forwardproxy_bytes_total{user="alice",direction="downlink"} 4096
caddy_forwardproxy_bytes_total{user="bob",direction="uplink"} 2048
caddy_forwardproxy_connections_total{user="alice"} 12
"#;
        let s = parse_prometheus(text);
        assert_eq!(s.get("alice").copied().unwrap_or_default().uplink, 1024);
        assert_eq!(s.get("alice").copied().unwrap_or_default().downlink, 4096);
        assert_eq!(s.get("alice").copied().unwrap_or_default().connections, 12);
        assert_eq!(s.get("bob").copied().unwrap_or_default().uplink, 2048);
        assert_eq!(s.get("bob").copied().unwrap_or_default().downlink, 0);
    }

    #[test]
    fn ignores_unrelated_metrics() {
        let text = "go_goroutines 42\ncaddy_unrelated_metric{x=\"y\"} 1\n";
        assert!(parse_prometheus(text).is_empty());
    }

    #[test]
    fn outcome_json_pins_php_visible_keys() {
        // Round-17 chassis-cockpit: panel reads `rows` only today,
        // but pin both since `total_bytes_delta` is the natural
        // next field a future panel feature ("show data
        // throughput") would reach for.
        let s = outcome_json(7, 12345);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("rows").is_some(), "panel reads `rows`: {s}");
        assert!(
            v.get("total_bytes_delta").is_some(),
            "future panel feature reads `total_bytes_delta`: {s}"
        );
        assert_eq!(v["rows"], 7);
        assert_eq!(v["total_bytes_delta"], 12345);
    }
}
