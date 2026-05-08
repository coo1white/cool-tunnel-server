// SPDX-License-Identifier: AGPL-3.0-only
// Long-running daemon. Listens on a unix socket and accepts
// `WireRequestV1` JSON-per-line, replies with `WireResponseV1`.
//
// Why a daemon at all (vs. one-shot CLI invocations)? The DB pool
// stays warm, which makes per-request latency roughly 5x lower —
// that matters for the "save in Filament → reload visible" cycle the
// admin clicks through dozens of times.
//
// Pool lifecycle (post-perf/share-db-pool refactor): `serve()`
// constructs ONE `MySqlPool` at startup and holds it for the
// process lifetime; every `handle()` invocation borrows it. Pre-
// refactor, every wire request opened a fresh pool via
// `db::connect()` — the daemon docstring claimed "the DB pool stays
// warm" but the code defeated it, paying ~30-50 ms of TCP+auth
// handshake per request. The shared pool restores the docstring's
// promise: the panel's "save → reload" round-trip drops by that
// same handshake cost.

use crate::{admin, metrics, singbox, Error, Result};
use ct_protocol::{WireRequestV1, WireResponseV1};
use sqlx::MySqlPool;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;

/// Max bytes per request line (JSON-per-line protocol). A
/// well-formed request is well under 1 KiB; 1 MiB is generous and
/// also bounds the worst case if a buggy client sends a huge blob
/// without newlines (we'd otherwise grow the read buffer
/// unboundedly).
const MAX_REQUEST_LINE_BYTES: usize = 1 << 20; // 1 MiB

/// Concurrent-handler cap. The panel is the only legitimate client of
/// this socket and runs FrankenPHP with `worker num 4` (default in
/// docker/panel/Caddyfile). 8 → 16 ceiling; 16 chosen to leave
/// headroom for the queue + scheduler + the components.md probe also
/// shelling out, while still preventing a misbehaving client from
/// driving unbounded handler-task spawn. (T-1, v0.0.65 — defense-in-
/// depth; the Unix socket's 0o660 perms already gate access at the
/// container-user layer.)
const MAX_CONCURRENT_HANDLERS: usize = 16;

/// Per-request line-read timeout. A connected client that sends part
/// of a request and stalls (network partition, suspended process,
/// malicious holding pattern) would otherwise keep the handler task
/// — and the semaphore permit — alive indefinitely. 30 s is generous
/// (panel requests complete in tens of ms); this is a poison-pill
/// detector, not a perf knob. (T-2, v0.0.65.)
const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn serve(
    socket_path: &str,
    pool: MySqlPool,
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

    tracing::info!(
        path = socket_path,
        max_concurrent_handlers = MAX_CONCURRENT_HANDLERS,
        read_timeout_s = READ_TIMEOUT.as_secs(),
        "ct-server-core daemon listening"
    );

    let template = template.to_owned();
    let output = output.to_owned();
    let admin_url = admin_url.to_owned();

    // Concurrent-handler permit cap (T-1, v0.0.65). Each accept
    // acquires one permit before spawning its handler task; the
    // permit drops when the handler exits. The 17th simultaneous
    // connection blocks at `acquire_owned().await` until a handler
    // completes — that's the backpressure signal we want
    // (clients see slower accept under saturation, the daemon
    // doesn't OOM).
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_HANDLERS));

    // Graceful shutdown: stop accepting new connections on
    // SIGINT / SIGTERM, drop the listener so its socket file is
    // freed, and let in-flight handlers finish naturally (each
    // is its own tokio task and holds nothing process-global).
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        // Acquire a permit BEFORE the accept call. If the cap is
        // reached, accept won't run until a handler completes —
        // which is the point. Holding the permit across .await is
        // fine: tokio::sync::Semaphore is async-aware (unlike the
        // Coalescer's std::sync::Mutex; different tool, different
        // need).
        let permit = match Arc::clone(&permits).acquire_owned().await {
            Ok(p) => p,
            Err(_) => {
                // Semaphore::close was called somewhere. The only
                // path to that today is if `permits` is dropped
                // while a permit await is pending — not in our
                // control flow. Treat as a fatal invariant break.
                return Err(Error::msg(
                    "daemon semaphore closed unexpectedly; bailing out of accept loop",
                ));
            }
        };
        tokio::select! {
            _ = &mut shutdown => {
                tracing::info!(path = socket_path, "ct-server-core daemon shutting down");
                drop(listener);
                let _ = tokio::fs::remove_file(socket_path).await;
                return Ok(());
            }
            res = listener.accept() => {
                let (stream, _) = res?;
                // MySqlPool is internally Arc'd; cloning bumps a
                // refcount and shares the underlying connection set.
                // No new TCP connections are opened on clone.
                let pool = pool.clone();
                let template = template.clone();
                let output = output.clone();
                let admin_url = admin_url.clone();
                tokio::spawn(async move {
                    // Permit is held by the spawned task; dropped
                    // when this closure returns (handler exit or
                    // error path). A new permit becomes available
                    // for the next accept.
                    let _permit = permit;
                    if let Err(e) =
                        handle_client(stream, &pool, &template, &output, &admin_url).await
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
    pool: &MySqlPool,
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
        // Per-request read timeout (T-2, v0.0.65). A stalled client
        // (network partition, suspended process, hostile holding
        // pattern) would otherwise keep this handler — and the
        // T-1 semaphore permit — alive indefinitely. 30 s is well
        // above any legitimate request latency; treat any read that
        // takes longer as a poison pill and close the connection.
        let n = match tokio::time::timeout(READ_TIMEOUT, rd.read_until(b'\n', &mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e.into()),
            Err(_elapsed) => {
                tracing::warn!(
                    timeout_s = READ_TIMEOUT.as_secs(),
                    "client read timeout — closing connection"
                );
                // Best-effort error response; ignore write failure
                // (the stalled client likely can't read it anyway).
                let resp = WireResponseV1::Error {
                    code: "read_timeout".into(),
                    message: format!(
                        "no request line within {} seconds; closing",
                        READ_TIMEOUT.as_secs()
                    ),
                };
                let _ = send(&mut wr, &resp).await;
                return Ok(());
            }
        };
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
        let resp = match handle(req, pool, template, output, admin_url).await {
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
    pool: &MySqlPool,
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
            singbox::render(pool, template, output, false, false).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::ReloadCaddy => {
            // Same naming caveat as RenderCaddyfile: this reloads
            // sing-box via its clash API. Variant name preserved
            // for WireV1 compat.
            let started = std::time::Instant::now();
            let secret = singbox::current_clash_secret().await?;
            admin::ClashAdmin::new(admin_url, &secret)
                .reload(output)
                .await?;
            Ok(WireResponseV1::CaddyReloaded {
                duration_ms: started.elapsed().as_millis() as u64,
            })
        }
        WireRequestV1::CollectTraffic => {
            let secret = singbox::current_clash_secret().await?;
            metrics::collect(pool, &admin::ClashAdmin::new(admin_url, &secret)).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::EnforceQuota => {
            crate::quota::enforce(pool, template, output, admin_url).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::ProbeAntiTracking => Err(Error::msg(
            "anti-tracking probe needs a `via` URL; use the CLI for now",
        )),
        WireRequestV1::Health => {
            // SELECT 1 borrows a connection from the shared pool;
            // no fresh TCP/auth handshake. Used by the panel's
            // health probe, so this runs whenever the operator
            // refreshes the panel — keeping it cheap matters.
            sqlx::query("SELECT 1").execute(pool).await?;
            Ok(WireResponseV1::HealthOk)
        }
    }
}
