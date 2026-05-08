// SPDX-License-Identifier: AGPL-3.0-only
// sing-box clash API client (HTTP over the docker-internal network).
//
// sing-box exposes its management API in clash-style at
// `experimental.clash_api.external_controller`. We pin that to
// `0.0.0.0:9090` inside the ct-singbox container; the docker-compose
// `ports:` map for sing-box does NOT publish 9090 to the host, so
// the listener is reachable only from peers on the `ct-net` docker
// network (i.e. the panel) and is not addressable from the public
// internet.
//
// Auth: clash API supports a static `secret` field in its config;
// clients pass it as `Authorization: Bearer <secret>`. The secret is
// derived deterministically from ServerConfig (see
// `singbox::clash_secret`) so the panel + the daemon agree without
// a separate secret-distribution step.
//
// Endpoints we use:
//   PUT /configs?force=true&path=<path>   — reload from a file on disk
//   GET /configs                          — current loaded config
//   GET /metrics                          — kept for the legacy
//                                           Prometheus path; today
//                                           returns no matching
//                                           samples (see metrics.rs).
//
// The clash spec also has POST /configs (with body) but reload-from-
// path keeps the actual config bytes off the wire and lets sing-box
// validate from disk — same path our atomic-write lands at.
//
// Why we held an `external_controller_unix` field for so long: that
// name never existed in upstream sing-box. The pre-1.13 JSON decoder
// silently ignored unknown fields, so the unix socket was never
// bound and admin::reload always took the docker-compose-restart
// fallback (~1s). 1.13 made unknown fields hard errors, which
// surfaced the bug — and forced this rewrite onto the upstream-
// supported `external_controller` (TCP, docker-internal-only).

use crate::{Error, Result};
use reqwest::Client;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Bounded HTTP timeout for clash-API calls. A reload should
/// complete in well under a second; a hung sing-box (deadlock,
/// signal-blocked, OOM-stalled) must not wedge the panel's reload
/// path forever.
const CLASH_HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Bounded timeout for the docker-compose-restart fallback. 60s is
/// generous — `docker compose restart sing-box` is ~1s on a healthy
/// host. The cap exists so a hung docker daemon (network blip, disk
/// full, etc.) doesn't wedge the reload path.
const DOCKER_RESTART_TIMEOUT: Duration = Duration::from_secs(60);

/// Connection-and-secret pair for the sing-box clash API. Construct
/// once per call site (cheap — `reqwest::Client::new()` reuses an
/// internal connection pool, but this struct is stateless beyond the
/// two strings, so we don't bother caching the Client across calls).
pub struct ClashAdmin {
    /// Base URL, e.g. `http://ct-singbox:9090`. No trailing slash.
    url: String,
    /// Bearer token. Must match the `secret` field in the rendered
    /// `experimental.clash_api` block. Empty string disables auth
    /// (clash API treats empty secret as "no auth required") — used
    /// in dev / unit tests, not in production.
    secret: String,
}

impl ClashAdmin {
    pub fn new(url: &str, secret: &str) -> Self {
        Self {
            url: url.trim_end_matches('/').to_owned(),
            secret: secret.to_owned(),
        }
    }

    /// Reload sing-box from `config_path` via PUT /configs?path=…&force=true.
    /// Falls back to `docker compose restart sing-box` when the HTTP
    /// endpoint is unreachable (host-side dev with no network, or
    /// sing-box still booting on a fresh stack). The fallback path
    /// is bounded by DOCKER_RESTART_TIMEOUT and emits at WARN so an
    /// operator inspecting logs notices when the fast path is missed.
    pub async fn reload(&self, config_path: &str) -> Result<()> {
        let started = Instant::now();
        let endpoint = format!(
            "{}/configs?force=true&path={}",
            self.url,
            percent_encode_path(config_path),
        );

        let req = self
            .client()?
            .put(&endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("{}");
        let req = self.with_auth(req);

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) if is_connect_error(&e) => {
                tracing::warn!(
                    error = %e,
                    url = %self.url,
                    "clash API unreachable — falling back to docker compose restart"
                );
                return reload_via_docker_restart().await;
            }
            Err(e) => return Err(Error::msg(format!("clash PUT /configs: {e}"))),
        };

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::msg(format!(
                "sing-box clash /configs failed: {status} — {body}. \
                 Validate the rendered config first: \
                 `docker compose exec ct-singbox sing-box check -c /etc/sing-box/config.json`"
            )));
        }
        tracing::info!(
            duration_ms = started.elapsed().as_millis() as u64,
            path = config_path,
            "sing-box reloaded via clash API"
        );
        Ok(())
    }

    /// GET /configs — print the live config as JSON to stdout.
    /// Operator-facing; not on the hot path.
    pub async fn dump_config(&self) -> Result<()> {
        let endpoint = format!("{}/configs", self.url);
        let req = self.with_auth(self.client()?.get(&endpoint));
        let resp = req
            .send()
            .await
            .map_err(|e| Error::msg(format!("clash GET /configs: {e}")))?;
        if !resp.status().is_success() {
            return Err(Error::msg(format!(
                "sing-box clash /configs failed: {}",
                resp.status()
            )));
        }
        let body = resp
            .text()
            .await
            .map_err(|e| Error::msg(format!("clash GET /configs body: {e}")))?;
        println!("{body}");
        Ok(())
    }

    /// GET /metrics — kept for the legacy Prometheus scrape path
    /// (see metrics.rs). Returns "" when the endpoint isn't
    /// reachable so metrics::collect's no-op stays a no-op rather
    /// than a hard error.
    pub async fn fetch_metrics_text(&self) -> Result<String> {
        let endpoint = format!("{}/metrics", self.url);
        let req = self.with_auth(self.client()?.get(&endpoint));
        let resp = req
            .send()
            .await
            .map_err(|e| Error::msg(format!("clash GET /metrics: {e}")))?;
        let body = resp
            .text()
            .await
            .map_err(|e| Error::msg(format!("clash GET /metrics body: {e}")))?;
        Ok(body)
    }

    fn client(&self) -> Result<Client> {
        Client::builder()
            .timeout(CLASH_HTTP_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|e| Error::msg(format!("reqwest client build: {e}")))
    }

    fn with_auth(&self, b: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.secret.is_empty() {
            b
        } else {
            b.bearer_auth(&self.secret)
        }
    }
}

async fn reload_via_docker_restart() -> Result<()> {
    let started = Instant::now();
    let out = tokio::time::timeout(
        DOCKER_RESTART_TIMEOUT,
        Command::new("docker")
            .args(["compose", "restart", "sing-box"])
            .output(),
    )
    .await
    .map_err(|_| {
        Error::msg(format!(
            "docker compose restart sing-box timed out after {}s. \
             Investigate: `docker ps` and `docker compose logs --tail=50 sing-box`.",
            DOCKER_RESTART_TIMEOUT.as_secs(),
        ))
    })??;
    if !out.status.success() {
        return Err(Error::msg(format!(
            "docker compose restart sing-box failed: {}",
            String::from_utf8_lossy(&out.stderr),
        )));
    }
    tracing::warn!(
        duration_ms = started.elapsed().as_millis() as u64,
        "sing-box reloaded via docker compose restart (clash API unreachable)"
    );
    Ok(())
}

/// True for "couldn't even open a TCP connection" errors. We use this
/// to decide whether to take the docker-compose-restart fallback.
/// 5xx / 4xx HTTP responses are NOT connect errors — they mean the
/// API answered, just unhappily; those propagate as Err.
fn is_connect_error(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout()
}

/// Percent-encode a path for use as a URL query value. We can't
/// pull in the `urlencoding` crate here without ballooning the
/// dependency tree, and reqwest's url builder takes us most of the
/// way but encodes some safe chars we'd rather pass through.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_keeps_path_chars() {
        assert_eq!(
            percent_encode_path("/etc/sing-box/config.json"),
            "/etc/sing-box/config.json",
        );
    }

    #[test]
    fn percent_encode_escapes_query_chars() {
        // Spaces, &, ?, # would otherwise corrupt the query string.
        assert_eq!(percent_encode_path("a b&c?d#e"), "a%20b%26c%3Fd%23e");
    }

    #[test]
    fn trailing_slash_is_normalised() {
        let a = ClashAdmin::new("http://ct-singbox:9090/", "tok");
        let b = ClashAdmin::new("http://ct-singbox:9090", "tok");
        assert_eq!(a.url, b.url);
    }

    #[test]
    fn empty_secret_skips_auth_header() {
        // Construct a real RequestBuilder (against a dummy URL we
        // never send) so we can introspect the resulting headers.
        let admin = ClashAdmin::new("http://example", "");
        let req = admin
            .with_auth(reqwest::Client::new().get("http://example/configs"))
            .build()
            .unwrap();
        assert!(req.headers().get(reqwest::header::AUTHORIZATION).is_none());
    }

    #[test]
    fn nonempty_secret_attaches_bearer() {
        let admin = ClashAdmin::new("http://example", "tok-abc");
        let req = admin
            .with_auth(reqwest::Client::new().get("http://example/configs"))
            .build()
            .unwrap();
        let auth = req
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(auth, "Bearer tok-abc");
    }
}
