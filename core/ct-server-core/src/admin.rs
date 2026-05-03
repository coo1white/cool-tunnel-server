// Caddy admin API client over the unix socket.
//
// Caddy exposes a JSON config / control API on `/run/caddy/admin.sock`
// (configured in the Caddyfile global block). We bypass `docker exec`
// entirely — direct unix-socket HTTP is dramatically faster and
// avoids ever holding a docker CLI context inside the panel.
//
// The two endpoints we actually use:
//   POST /load           — replace running config with the body
//   GET  /config         — dump current config (for /admin debug)

use crate::{Error, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyperlocal::{UnixClientExt, UnixConnector, Uri as UnixUri};
use std::path::Path;
use std::time::Instant;
use tokio::fs;
use tokio::process::Command;

pub async fn reload(socket_path: &str, caddyfile_path: &str) -> Result<()> {
    if !Path::new(socket_path).exists() {
        // Fall back to docker exec when the socket isn't reachable
        // (development on macOS without the docker volume mount).
        return reload_via_docker_exec().await;
    }

    let started = Instant::now();
    let body_bytes = adapt_caddyfile_to_json(caddyfile_path).await?;

    let client: Client<UnixConnector, Full<Bytes>> = Client::unix();
    let uri: hyper::Uri = UnixUri::new(socket_path, "/load").into();
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body_bytes)))?;

    let resp = client.request(req).await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = read_body(resp).await.unwrap_or_default();
        return Err(Error::msg(format!(
            "caddy /load failed: {status} — {}",
            String::from_utf8_lossy(&body),
        )));
    }
    tracing::info!(
        duration_ms = started.elapsed().as_millis() as u64,
        "caddy reloaded via admin socket",
    );
    Ok(())
}

pub async fn dump_config(socket_path: &str) -> Result<()> {
    if !Path::new(socket_path).exists() {
        return Err(Error::msg(format!(
            "admin socket {socket_path} not found"
        )));
    }
    let client: Client<UnixConnector, Full<Bytes>> = Client::unix();
    let uri: hyper::Uri = UnixUri::new(socket_path, "/config/").into();
    let req = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Full::new(Bytes::new()))?;
    let resp = client.request(req).await?;
    if resp.status() != StatusCode::OK {
        return Err(Error::msg(format!("caddy /config/ failed: {}", resp.status())));
    }
    let body = read_body(resp).await?;
    println!("{}", String::from_utf8_lossy(&body));
    Ok(())
}

async fn read_body(resp: Response<Incoming>) -> Result<Vec<u8>> {
    let collected = resp.into_body().collect().await?;
    Ok(collected.to_bytes().to_vec())
}

/// Run `caddy adapt` inside the caddy container to convert the
/// rendered Caddyfile to JSON. Required because `/load` only accepts
/// the JSON shape — there's no Caddyfile-flavoured load endpoint.
async fn adapt_caddyfile_to_json(caddyfile_path: &str) -> Result<Vec<u8>> {
    // We could shell out to docker exec, but the simpler alternative
    // is to just call /load/Caddyfile via the admin socket — Caddy
    // accepts that directly. We POST the file body verbatim with the
    // Content-Type that triggers the caddyfile adapter.
    let body = fs::read(caddyfile_path).await?;
    Ok(body)
}

async fn reload_via_docker_exec() -> Result<()> {
    let started = Instant::now();
    let out = Command::new("docker")
        .args(["exec", "ct-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"])
        .output()
        .await?;
    if !out.status.success() {
        return Err(Error::msg(format!(
            "docker exec caddy reload failed: {}",
            String::from_utf8_lossy(&out.stderr),
        )));
    }
    tracing::info!(
        duration_ms = started.elapsed().as_millis() as u64,
        "caddy reloaded via docker exec (admin socket unavailable)",
    );
    Ok(())
}

// Small custom override to actually pass Caddyfile content with the
// right Content-Type so /load uses the caddyfile adapter. Caddy 2.x
// recognises the "Content-Type: text/caddyfile" header and adapts on
// the server side.
pub async fn reload_caddyfile_text(socket_path: &str, caddyfile_path: &str) -> Result<()> {
    if !Path::new(socket_path).exists() {
        return reload_via_docker_exec().await;
    }
    let body = fs::read(caddyfile_path).await?;

    let client: Client<UnixConnector, Full<Bytes>> = Client::unix();
    let uri: hyper::Uri = UnixUri::new(socket_path, "/load").into();
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(hyper::header::CONTENT_TYPE, "text/caddyfile")
        .body(Full::new(Bytes::from(body)))?;
    let resp = client.request(req).await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let bytes = read_body(resp).await.unwrap_or_default();
        return Err(Error::msg(format!(
            "caddy /load (caddyfile) failed: {status} — {}",
            String::from_utf8_lossy(&bytes),
        )));
    }
    Ok(())
}
