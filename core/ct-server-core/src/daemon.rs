// Long-running daemon. Listens on a unix socket and accepts
// `WireRequestV1` JSON-per-line, replies with `WireResponseV1`.
//
// Why a daemon at all (vs. one-shot CLI invocations)? The DB pool
// stays warm, which makes per-request latency roughly 5x lower —
// that matters for the "save in Filament → reload visible" cycle the
// admin clicks through dozens of times.

use crate::{admin, db, metrics, singbox, Error, Result};
use ct_protocol::{WireRequestV1, WireResponseV1};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// Max bytes per request line (JSON-per-line protocol). A
/// well-formed request is well under 1 KiB; 1 MiB is generous and
/// also bounds the worst case if a buggy client sends a huge blob
/// without newlines (we'd otherwise grow the read buffer
/// unboundedly).
const MAX_REQUEST_LINE_BYTES: usize = 1 << 20; // 1 MiB

pub async fn serve(
    socket_path: &str,
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_url: &str,
) -> Result<()> {
    // Ensure parent dir exists; remove any stale socket file.
    if let Some(dir) = Path::new(socket_path).parent() {
        tokio::fs::create_dir_all(dir).await.ok();
    }
    let _ = tokio::fs::remove_file(socket_path).await;

    let listener = UnixListener::bind(socket_path)?;
    tokio::fs::set_permissions(
        socket_path,
        std::os::unix::fs::PermissionsExt::from_mode(0o660),
    )
    .await
    .ok();

    tracing::info!(path = socket_path, "ct-server-core daemon listening");

    let database_url = database_url.clone();
    let template = template.to_owned();
    let output = output.to_owned();
    let admin_url = admin_url.to_owned();

    // Graceful shutdown: stop accepting new connections on
    // SIGINT / SIGTERM, drop the listener so its socket file is
    // freed, and let in-flight handlers finish naturally (each
    // is its own tokio task and holds nothing process-global).
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                tracing::info!(path = socket_path, "ct-server-core daemon shutting down");
                drop(listener);
                let _ = tokio::fs::remove_file(socket_path).await;
                return Ok(());
            }
            res = listener.accept() => {
                let (stream, _) = res?;
                let database_url = database_url.clone();
                let template = template.clone();
                let output = output.clone();
                let admin_url = admin_url.clone();
                tokio::spawn(async move {
                    if let Err(e) =
                        handle_client(stream, &database_url, &template, &output, &admin_url).await
                    {
                        tracing::warn!(error = %e, "client handler errored");
                    }
                });
            }
        }
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "could not install SIGTERM handler; ctrl-c only");
            // Still wait on ctrl-c if SIGTERM install failed.
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

async fn handle_client(
    stream: UnixStream,
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_url: &str,
) -> Result<()> {
    let (rd, mut wr) = stream.into_split();
    // Cap the read buffer so a misbehaving client sending an
    // unterminated line can't make us allocate forever. The
    // BufReader::lines() API doesn't enforce a size limit by
    // itself; we pre-cap by reading bytes-with-limit then
    // splitting.
    let mut rd = BufReader::with_capacity(8 * 1024, rd);
    loop {
        let mut buf = Vec::with_capacity(256);
        let n = rd.read_until(b'\n', &mut buf).await?;
        if n == 0 {
            break; // EOF
        }
        if buf.len() > MAX_REQUEST_LINE_BYTES {
            let resp = WireResponseV1::Error {
                code: "request_too_large".into(),
                message: format!(
                    "request line exceeds {MAX_REQUEST_LINE_BYTES} bytes; closing connection"
                ),
            };
            send(&mut wr, &resp).await?;
            return Err(Error::msg("oversized request; closing"));
        }
        // Strip the trailing newline if present (read_until includes it).
        if buf.last() == Some(&b'\n') {
            buf.pop();
        }
        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s,
            Err(e) => {
                let resp = WireResponseV1::Error {
                    code: "bad_request".into(),
                    message: format!("non-utf8 input: {e}"),
                };
                send(&mut wr, &resp).await?;
                continue;
            }
        };
        let req: WireRequestV1 = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                let resp = WireResponseV1::Error {
                    code: "bad_request".into(),
                    message: e.to_string(),
                };
                send(&mut wr, &resp).await?;
                continue;
            }
        };
        let resp = match handle(req, database_url, template, output, admin_url).await {
            Ok(r) => r,
            Err(e) => WireResponseV1::Error {
                code: "internal".into(),
                message: e.to_string(),
            },
        };
        send(&mut wr, &resp).await?;
    }
    Ok(())
}

async fn send<W: AsyncWriteExt + Unpin>(w: &mut W, resp: &WireResponseV1) -> Result<()> {
    let mut bytes = serde_json::to_vec(resp)?;
    bytes.push(b'\n');
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

async fn handle(
    req: WireRequestV1,
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_url: &str,
) -> Result<WireResponseV1> {
    match req {
        WireRequestV1::RenderCaddyfile => {
            // Wire-protocol name is historical (the v0.0.1 stack
            // used Caddy + forwardproxy). Today this dispatches to
            // sing-box render — sing-box owns :443 / proxy traffic
            // since v0.0.2; Caddy is ACME-only since v0.0.4.
            // Renaming the variant is a v0.1 task (it'd break
            // every connected client core that speaks WireV1).
            singbox::render(database_url, template, output, false, false).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::ReloadCaddy => {
            // Same naming caveat as RenderCaddyfile: this reloads
            // sing-box via its clash API. Variant name preserved
            // for WireV1 compat.
            let started = std::time::Instant::now();
            let secret = singbox::current_clash_secret(database_url).await?;
            admin::ClashAdmin::new(admin_url, &secret)
                .reload(output)
                .await?;
            Ok(WireResponseV1::CaddyReloaded {
                duration_ms: started.elapsed().as_millis() as u64,
            })
        }
        WireRequestV1::CollectTraffic => {
            let secret = singbox::current_clash_secret(database_url).await?;
            metrics::collect(database_url, &admin::ClashAdmin::new(admin_url, &secret)).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::EnforceQuota => {
            crate::quota::enforce(database_url, template, output, admin_url).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::ProbeAntiTracking => Err(Error::msg(
            "anti-tracking probe needs a `via` URL; use the CLI for now",
        )),
        WireRequestV1::Health => {
            // Connect to the DB to confirm it's reachable; cheap.
            let pool = db::connect(database_url).await?;
            sqlx::query("SELECT 1").execute(&pool).await?;
            Ok(WireResponseV1::HealthOk)
        }
    }
}
