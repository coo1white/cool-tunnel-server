// Active anti-tracking probe.
//
// We dial *through* the configured proxy and hit a small JSON endpoint
// that echoes the request headers it received. If hide_ip / hide_via
// are working, the response should NOT contain X-Forwarded-For,
// Forwarded, X-Real-IP, or Via headers seen from the client side.
//
// The probe is best-effort — it doesn't tell you whether a
// censorship system can fingerprint your TLS handshake, only whether
// the configured Caddy mitigations are *actually* on the wire.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProbeResult {
    pub via: Option<String>,
    pub target: String,
    pub reachable: bool,
    pub hide_ip_effective: bool,
    pub hide_via_effective: bool,
    pub probe_resistance_effective: bool,
}

pub async fn anti_tracking(target: &str, via: Option<&str>) -> Result<()> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(false);

    if let Some(via_url) = via {
        let proxy = reqwest::Proxy::all(via_url)?;
        builder = builder.proxy(proxy);
    }

    let client = builder.build().map_err(|e| Error::msg(e.to_string()))?;

    // 1) Reachability + header echo. Most public echo endpoints
    // (postman-echo, ifconfig.co/json) reflect headers; we use
    // ifconfig.co/json by default since it shows the IP the upstream
    // saw plus a copy of the request headers.
    let reachable;
    let echoed_headers: serde_json::Value;
    match client.get(target).send().await {
        Ok(resp) => {
            reachable = resp.status().is_success();
            echoed_headers = resp.json().await.unwrap_or(serde_json::Value::Null);
        }
        Err(e) => {
            tracing::warn!(error = %e, "probe reachability failed");
            return print_result(&ProbeResult {
                via: via.map(str::to_owned),
                target: target.to_owned(),
                reachable: false,
                hide_ip_effective: false,
                hide_via_effective: false,
                probe_resistance_effective: false,
            });
        }
    }

    // 2) For probe_resistance, hit the proxy's apex *without* auth
    // and check we get an HTML page (the fake site) rather than a
    // 407 / "Proxy Authentication Required". A correctly-configured
    // server returns 200 + HTML to unauthenticated CONNECT-shaped
    // requests; that's the whole point of probe_resistance.
    let probe_resistance_effective = match via.and_then(strip_creds) {
        Some(public_url) => match client_no_proxy().get(&public_url).send().await {
            Ok(r) => {
                let status = r.status();
                let ctype = r
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                status.is_success() && ctype.starts_with("text/html")
            }
            Err(_) => false,
        },
        None => false,
    };

    let echoed = echoed_headers.as_object().cloned().unwrap_or_default();
    let saw_xff = echoed
        .get("headers")
        .and_then(|h| h.as_object())
        .map(|h| h.contains_key("X-Forwarded-For") || h.contains_key("Forwarded"))
        .unwrap_or(false);
    let saw_via = echoed
        .get("headers")
        .and_then(|h| h.as_object())
        .map(|h| h.contains_key("Via"))
        .unwrap_or(false);

    print_result(&ProbeResult {
        via: via.map(str::to_owned),
        target: target.to_owned(),
        reachable,
        hide_ip_effective: !saw_xff,
        hide_via_effective: !saw_via,
        probe_resistance_effective,
    })
}

fn print_result(r: &ProbeResult) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string(r).unwrap_or_else(|_| "{\"error\":\"serialize\"}".into()),
    );
    Ok(())
}

/// Convert `https://user:pass@host:443` into `https://host:443`.
fn strip_creds(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host_port = rest.rsplit_once('@').map_or(rest, |(_, hp)| hp);
    Some(format!("{scheme}://{host_port}"))
}

fn client_no_proxy() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}
