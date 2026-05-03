// Prometheus-text metrics scraper + traffic_logs writer.
//
// We GET /metrics from Caddy's admin API (over unix socket). The
// forward_proxy plugin emits per-user counters; we parse, diff
// against the last persisted value, and upsert into traffic_logs.
//
// Counter semantics: bytes_total is monotonically increasing within
// the lifetime of the Caddy process. After a restart the counter
// resets to 0 — `record_caddyfile_hash` and the rollup logic
// tolerate that by clamping deltas to >= 0.

use crate::{db, Error, Result};
use bytes::Bytes;
use chrono::Utc;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request};
use hyper_util::client::legacy::Client;
use hyperlocal::{UnixClientExt, UnixConnector, Uri as UnixUri};
use std::collections::HashMap;
use std::path::Path;

pub async fn collect(database_url: &Option<String>, socket_path: &str) -> Result<()> {
    let pool = db::connect(database_url).await?;

    let raw = match fetch_metrics_text(socket_path).await {
        Ok(t) => t,
        Err(e) => {
            // Best-effort: a dead Caddy shouldn't crash the rollup
            // job. Log and exit clean.
            tracing::warn!(error = %e, "metrics endpoint unreachable");
            return Ok(());
        }
    };

    let samples = parse_prometheus(&raw);
    if samples.is_empty() {
        tracing::debug!("no forward_proxy metrics in response");
        return Ok(());
    }

    let day = Utc::now().date_naive();
    let mut total = 0i64;

    // Resolve username → id once.
    let username_to_id: HashMap<String, i64> =
        sqlx::query_as::<_, (i64, String)>(r"SELECT id, username FROM proxy_accounts")
            .fetch_all(&pool)
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
        .fetch_optional(&pool)
        .await?;

        let (prev_up, prev_down) = prev.unwrap_or((0, 0));
        let delta_up = (s.uplink - prev_up).max(0);
        let delta_down = (s.downlink - prev_down).max(0);

        db::upsert_traffic(&pool, id, day, s.uplink, s.downlink, s.connections).await?;
        if delta_up + delta_down > 0 {
            db::add_used_bytes(&pool, id, delta_up + delta_down).await?;
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

async fn fetch_metrics_text(socket_path: &str) -> Result<String> {
    if !Path::new(socket_path).exists() {
        return Err(Error::msg(format!(
            "admin socket {socket_path} not present"
        )));
    }
    let client: Client<UnixConnector, Full<Bytes>> = Client::unix();
    let uri: hyper::Uri = UnixUri::new(socket_path, "/metrics").into();
    let req = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Full::new(Bytes::new()))?;
    let resp = client.request(req).await?;
    let body = resp.into_body().collect().await?;
    Ok(String::from_utf8_lossy(&body.to_bytes()).into_owned())
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
