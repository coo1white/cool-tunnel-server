// sing-box clash API client (over unix socket).
//
// sing-box exposes its management API in clash-style at
// `experimental.clash_api.external_controller_unix` =
// `/run/sing-box/clash.sock` (configured in the rendered config). We
// bypass `docker exec` entirely — direct unix-socket HTTP is faster
// and avoids holding a docker CLI context inside the panel.
//
// The endpoints we use:
//   PUT /configs?force=true&path=<path>   — reload from a file on disk
//   GET /configs                          — current loaded config
//
// The clash spec also has POST /configs (with body) but reload-from-
// path keeps the actual config bytes off the wire and lets sing-box
// validate from disk — same path our atomic-write lands at.

use crate::{Error, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyperlocal::{UnixClientExt, UnixConnector, Uri as UnixUri};
use std::path::Path;
use std::time::Instant;
use tokio::process::Command;

/// Reload sing-box from `config_path` via the clash-API unix socket.
/// Falls back to `docker compose restart` when the socket isn't
/// reachable (host-side dev with no shared volume).
pub async fn reload(socket_path: &str, config_path: &str) -> Result<()> {
    if !Path::new(socket_path).exists() {
        return reload_via_docker_restart().await;
    }

    let started = Instant::now();
    let path_arg = urlencoding::encode(config_path);
    let endpoint = format!("/configs?force=true&path={path_arg}");

    let client: Client<UnixConnector, Full<Bytes>> = Client::unix();
    let uri: hyper::Uri = UnixUri::new(socket_path, &endpoint).into();
    let req = Request::builder()
        .method(Method::PUT)
        .uri(uri)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from_static(b"{}")))?;

    let resp = client.request(req).await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = read_body(resp).await.unwrap_or_default();
        return Err(Error::msg(format!(
            "sing-box clash /configs failed: {status} — {}",
            String::from_utf8_lossy(&body),
        )));
    }
    tracing::info!(
        duration_ms = started.elapsed().as_millis() as u64,
        path = config_path,
        "sing-box reloaded via clash API",
    );
    Ok(())
}

/// Backward-compat alias for the old caller name. Same semantics —
/// the daemon (redis_bridge, quota) used `reload_caddyfile_text` so
/// we keep the name to avoid touching every call site.
pub async fn reload_caddyfile_text(socket_path: &str, config_path: &str) -> Result<()> {
    reload(socket_path, config_path).await
}

pub async fn dump_config(socket_path: &str) -> Result<()> {
    if !Path::new(socket_path).exists() {
        return Err(Error::msg(format!(
            "clash API socket {socket_path} not found"
        )));
    }
    let client: Client<UnixConnector, Full<Bytes>> = Client::unix();
    let uri: hyper::Uri = UnixUri::new(socket_path, "/configs").into();
    let req = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Full::new(Bytes::new()))?;
    let resp = client.request(req).await?;
    if resp.status() != StatusCode::OK {
        return Err(Error::msg(format!(
            "sing-box clash /configs failed: {}",
            resp.status()
        )));
    }
    let body = read_body(resp).await?;
    println!("{}", String::from_utf8_lossy(&body));
    Ok(())
}

async fn read_body(resp: Response<Incoming>) -> Result<Vec<u8>> {
    let collected = resp.into_body().collect().await?;
    Ok(collected.to_bytes().to_vec())
}

async fn reload_via_docker_restart() -> Result<()> {
    let started = Instant::now();
    let out = Command::new("docker")
        .args(["compose", "restart", "sing-box"])
        .output()
        .await?;
    if !out.status.success() {
        return Err(Error::msg(format!(
            "docker compose restart sing-box failed: {}",
            String::from_utf8_lossy(&out.stderr),
        )));
    }
    tracing::warn!(
        duration_ms = started.elapsed().as_millis() as u64,
        "sing-box reloaded via docker compose restart (clash socket unavailable)",
    );
    Ok(())
}

// Tiny percent-encoder; we only need URL-encoding of a path here so
// pulling in `urlencoding` would be overkill — keeping a private
// helper to avoid a new dep.
mod urlencoding {
    pub fn encode(s: &str) -> String {
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
}
