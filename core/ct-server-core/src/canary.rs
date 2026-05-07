// Self-probe canary — early-warning surface for "this VPS is
// becoming unreachable from its own network position."
//
// Runs every 5 minutes via Laravel's scheduler (panel/routes/
// console.php). Each invocation:
//   1. Reads ServerConfig.{domain, doh_resolver} from the panel DB.
//   2. Sends an RFC 8484 DoH query for `domain` IN A through the
//      operator's chosen DoH resolver. Asserts the response carries
//      ≥1 answer record.
//   3. TCP-connects to the docker-internal `haproxy:443` (the SNI
//      router's listening port) with a short timeout. Asserts the
//      handshake-level reachability of the actual proxy listener.
//   4. Appends the result to ServerConfig.self_probe_history, a
//      bounded JSON array trimmed to the last MAX_HISTORY entries.
//
// The panel reads the tail of self_probe_history to drive a "last N
// self-probes failed" banner (operator-side) so blocking / DoH /
// haproxy issues surface ~15 min ahead of user complaints.
//
// What this canary catches:
//   - Operator's chosen DoH resolver became unreachable (Cloudflare-
//     from-China is the canonical case — see v0.0.22 DohEndpoint
//     check + v0.0.57 default switch).
//   - DoH resolver returns 0 answers (captive portal / DNS poisoner).
//   - haproxy crashed / failed to start (TCP connect timeout).
//
// What this canary does NOT catch:
//   - External IP poisoning (the apex resolves correctly via the VPS's
//     DoH but maps to a different IP from inside China). This requires
//     external probe infrastructure not available in v0.0.57.
//   - Sing-box crashed but haproxy still accepts connections (the TCP
//     connect succeeds against haproxy; we don't TLS-handshake into
//     sing-box). v0.0.58 follow-up.
//
// (v0.0.57 china-readiness.)

use crate::db;
use crate::Result;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Bounded history length. The panel banner only needs the tail of
/// recent results; trimming on write keeps the JSON column small
/// (ten entries ~1 KiB) and bounds growth across daemon uptime.
const MAX_HISTORY: usize = 10;

/// Per-step timeout. DoH lookups typically <100 ms when the resolver
/// is reachable; TCP-connect to docker-internal haproxy is sub-ms.
/// 5 s is generous enough to absorb transient hiccups without
/// stalling the 5-min cron.
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize, Deserialize)]
pub struct CanaryEntry {
    /// ISO-8601 UTC timestamp of when the probe ran.
    pub ts: String,
    /// "ok" or "fail" — coarse-grain status the panel reads to count
    /// consecutive failures.
    pub status: String,
    /// Human-readable explanation when status = "fail". Surfaced in
    /// the panel banner so the operator can act without grepping
    /// docker logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Run one canary probe and append the result to ServerConfig.
pub async fn probe(pool: &MySqlPool) -> Result<()> {
    let cfg = db::server_config(pool).await?;
    let result = run_probe(&cfg.domain, &cfg.doh_resolver).await;
    let entry = match result {
        Ok(()) => CanaryEntry {
            ts: Utc::now().to_rfc3339(),
            status: "ok".to_owned(),
            reason: None,
        },
        Err(reason) => {
            tracing::warn!(reason = %reason, "self-probe failed");
            CanaryEntry {
                ts: Utc::now().to_rfc3339(),
                status: "fail".to_owned(),
                reason: Some(reason),
            }
        }
    };
    append_history(pool, &entry).await?;
    println!("{}", serde_json::to_string(&entry)?);
    Ok(())
}

/// Print the most recent probe entries as JSON-per-line — operator
/// surface for "what's the canary saying right now" without going
/// through the panel.
pub async fn status(pool: &MySqlPool) -> Result<()> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT self_probe_history FROM server_configs ORDER BY id LIMIT 1")
            .fetch_optional(pool)
            .await?;
    let history = match row.and_then(|(s,)| s) {
        Some(json) => serde_json::from_str::<Vec<CanaryEntry>>(&json).unwrap_or_default(),
        None => Vec::new(),
    };
    if history.is_empty() {
        println!(r#"{{"history": [], "note": "no self-probe runs recorded yet"}}"#);
        return Ok(());
    }
    for e in &history {
        println!("{}", serde_json::to_string(e)?);
    }
    Ok(())
}

async fn run_probe(domain: &str, doh_url: &str) -> std::result::Result<(), String> {
    if domain.trim().is_empty() {
        return Err("ServerConfig.domain is empty".to_owned());
    }
    if doh_url.trim().is_empty() {
        return Err("ServerConfig.doh_resolver is empty".to_owned());
    }

    // Step 1: DoH-resolve the apex.
    timeout(STEP_TIMEOUT, doh_resolve(domain, doh_url))
        .await
        .map_err(|_| format!("DoH lookup timed out after {STEP_TIMEOUT:?}"))?
        .map_err(|e| format!("DoH lookup failed: {e}"))?;

    // Step 2: TCP-connect to docker-internal haproxy:443. The
    // docker network's DNS resolves "haproxy" to the haproxy
    // service's IP; ":443" is haproxy's SNI router listening port.
    timeout(STEP_TIMEOUT, TcpStream::connect("haproxy:443"))
        .await
        .map_err(|_| format!("TCP connect to haproxy:443 timed out after {STEP_TIMEOUT:?}"))?
        .map_err(|e| format!("TCP connect to haproxy:443 failed: {e}"))?;

    Ok(())
}

async fn doh_resolve(name: &str, doh_url: &str) -> std::result::Result<(), String> {
    let query = build_dns_query(name)?;
    let b64 = URL_SAFE_NO_PAD.encode(&query);
    let url = if doh_url.contains('?') {
        format!("{doh_url}&dns={b64}")
    } else {
        format!("{doh_url}?dns={b64}")
    };

    let client = reqwest::Client::builder()
        .timeout(STEP_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/dns-message")
        .send()
        .await
        .map_err(|e| format!("DoH request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "DoH HTTP {status} (resolver may be censored or misconfigured)"
        ));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("DoH body read failed: {e}"))?;
    if body.len() < 12 {
        return Err(format!("DoH response too small ({} bytes)", body.len()));
    }
    // RFC 1035 header bytes 6-7 are ANCOUNT. Zero answers on a real
    // domain (we own this one — the apex always has an A record)
    // signals a captive portal / DNS poisoner / NXDOMAIN-on-everything
    // intercept between us and the resolver.
    let ancount = u16::from_be_bytes([body[6], body[7]]);
    if ancount == 0 {
        return Err(format!(
            "DoH returned 0 answer records for {name} (possible censorship intercept — try a different resolver via the panel)"
        ));
    }
    Ok(())
}

/// Build an RFC 1035 wire-format DNS query for `name` IN A. Standard
/// query (QR=0, OPCODE=0), recursion desired (RD=1), single question.
/// Each label is `<length-byte><label-bytes>`, terminated by a 0-byte;
/// QTYPE = A (1), QCLASS = IN (1).
fn build_dns_query(name: &str) -> std::result::Result<Vec<u8>, String> {
    let name = name.trim().trim_end_matches('.');
    if name.is_empty() {
        return Err("empty hostname".to_owned());
    }
    let mut buf = Vec::with_capacity(12 + name.len() + 6);
    // 12-byte header.
    buf.extend_from_slice(&[
        0x00, 0x01, // ID
        0x01, 0x00, // flags: standard query, RD=1
        0x00, 0x01, // QDCOUNT=1
        0x00, 0x00, // ANCOUNT=0
        0x00, 0x00, // NSCOUNT=0
        0x00, 0x00, // ARCOUNT=0
    ]);
    // QNAME.
    for label in name.split('.') {
        if label.is_empty() {
            return Err(format!("invalid hostname: `{name}` (empty label)"));
        }
        if label.len() > 63 {
            return Err(format!("invalid hostname: `{name}` (label > 63 bytes)"));
        }
        let len_byte = u8::try_from(label.len())
            .map_err(|_| format!("invalid hostname: `{name}` (label length > 255)"))?;
        buf.push(len_byte);
        buf.extend_from_slice(label.as_bytes());
    }
    buf.push(0x00); // QNAME terminator
                    // QTYPE = A (1), QCLASS = IN (1).
    buf.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    Ok(buf)
}

async fn append_history(pool: &MySqlPool, entry: &CanaryEntry) -> Result<()> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT self_probe_history FROM server_configs ORDER BY id LIMIT 1")
            .fetch_optional(pool)
            .await?;
    let mut history = row
        .and_then(|(s,)| s)
        .and_then(|json| serde_json::from_str::<Vec<CanaryEntry>>(&json).ok())
        .unwrap_or_default();
    history.push(CanaryEntry {
        ts: entry.ts.clone(),
        status: entry.status.clone(),
        reason: entry.reason.clone(),
    });
    if history.len() > MAX_HISTORY {
        let drop = history.len() - MAX_HISTORY;
        history.drain(0..drop);
    }
    let json = serde_json::to_string(&history)?;
    sqlx::query("UPDATE server_configs SET self_probe_history = ? WHERE id = (SELECT id FROM (SELECT id FROM server_configs ORDER BY id LIMIT 1) AS s)")
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
    fn dns_query_for_example_com_matches_known_29_byte_form() {
        // Sanity check against the hand-rolled wire-format query in
        // components::verify_via_doh — building "example.com" through
        // build_dns_query must reproduce the same byte sequence.
        let q = build_dns_query("example.com").unwrap();
        let expected: &[u8] = &[
            0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // header
            0x07, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 0x03, b'c', b'o', b'm', 0x00, 0x00,
            0x01, 0x00, 0x01,
        ];
        assert_eq!(q, expected);
    }

    #[test]
    fn dns_query_strips_trailing_dot() {
        let a = build_dns_query("proxy.example.com").unwrap();
        let b = build_dns_query("proxy.example.com.").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn dns_query_rejects_empty() {
        assert!(build_dns_query("").is_err());
        assert!(build_dns_query("   ").is_err());
    }

    #[test]
    fn dns_query_rejects_empty_label() {
        assert!(build_dns_query("foo..bar").is_err());
    }

    #[test]
    fn dns_query_rejects_oversize_label() {
        let long = "a".repeat(64);
        assert!(build_dns_query(&format!("{long}.example.com")).is_err());
    }
}
