// Prometheus-text metrics scraper + traffic_logs writer.
//
// HONEST STATE (post-v0.0.2 sing-box switch): the metric names this
// parser looks for — `caddy_forwardproxy_bytes_total{user="...",
// direction="..."}` — are emitted by the unmaintained
// klzgrad/forwardproxy plugin. Sing-box does NOT emit them on its
// clash-API endpoint; sing-box's per-connection traffic stats live
// at the streaming `/traffic` and `/connections` endpoints, which
// don't fit a one-shot Prometheus scrape model.
//
// Net effect: `traffic:rollup` runs every minute (per
// console.php's scheduler), the scrape returns zero matching
// metrics, and `traffic_logs` doesn't move. The Filament traffic
// stats widget shows "0 bytes" until we either:
//
//   1. Switch to a clash-API streaming consumer that aggregates
//      per-username byte counters in the daemon's RAM and flushes
//      to traffic_logs every N seconds, OR
//   2. Wait for sing-box upstream to add a Prometheus-shaped
//      per-user `naive_bytes_total` (there's an open issue), OR
//   3. Patch sing-box ourselves to emit a Prometheus endpoint that
//      matches what we parse here.
//
// Until then the legacy parser is preserved (it's exercised by
// unit tests and may be useful again if/when sing-box's metric
// surface lands in Prometheus shape) but `collect()` early-returns
// with a one-line tracing::info on every call so the operator
// knows traffic numbers in the panel are not authoritative yet.
//
// Counter semantics (kept here as historical reference): bytes_total
// is monotonically increasing within the lifetime of the proxy
// process; we clamp deltas to >= 0 so a process restart doesn't
// underflow.

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
        let prev: Option<(i64, i64)> = sqlx::query_as(
            r"SELECT uplink_bytes, downlink_bytes FROM traffic_logs
              WHERE proxy_account_id = ? AND day = ?",
        )
        .bind(id)
        .bind(day)
        .fetch_optional(pool)
        .await?;

        let (prev_up, prev_down) = prev.unwrap_or((0, 0));
        // saturating_sub: a sing-box restart resets the counter, so
        // the new "current" can be lower than the stored "previous".
        // Plain `s.uplink - prev_up` panics in debug and silently
        // wraps in release if either side approaches i64::MIN/MAX
        // (e.g. a 64-bit total returned near the extremes by a
        // future upstream that switches counter encoding). The
        // saturating form returns 0 in that corner instead of
        // wrapping to a huge positive delta.
        let delta_up = s.uplink.saturating_sub(prev_up).max(0);
        let delta_down = s.downlink.saturating_sub(prev_down).max(0);

        db::upsert_traffic(pool, id, day, s.uplink, s.downlink, s.connections).await?;
        if delta_up + delta_down > 0 {
            db::add_used_bytes(pool, id, delta_up + delta_down).await?;
            total += delta_up + delta_down;
        }
    }

    println!(
        r#"{{"rows": {}, "total_bytes_delta": {}}}"#,
        samples.len(),
        total,
    );
    Ok(())
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
}
