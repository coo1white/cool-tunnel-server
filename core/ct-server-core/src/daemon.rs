// SPDX-License-Identifier: AGPL-3.0-only
//! Long-running daemon. Listens on a unix socket and accepts
//! `WireRequestV1` JSON-per-line, replies with `WireResponseV1`.
//!
//! Why a daemon at all (vs. one-shot CLI invocations)? The DB pool
//! stays warm, which makes per-request latency roughly 5x lower —
//! that matters for the "admin action → rendered config/reload
//! visible" cycle operators click through repeatedly.
//!
//! Pool lifecycle (post-perf/share-db-pool refactor): `serve()`
//! constructs ONE `MySqlPool` at startup and holds it for the
//! process lifetime; every `handle()` invocation borrows it. Pre-
//! refactor, every wire request opened a fresh pool via
//! `db::connect()` — the daemon docstring claimed "the DB pool stays
//! warm" but the code defeated it, paying ~30-50 ms of TCP+auth
//! handshake per request. The shared pool restores the docstring's
//! promise: the panel's "save → reload" round-trip drops by that
//! same handshake cost.

use crate::contracts::{
    ContractBoundary, RecoveryScope, SemanticContract, PRINCIPLE_LOCAL_RECOVERY,
};
use crate::daemon_fsm::{ConnectionEvent, ConnectionFsm, HengProfile, TransitionOutcome};
use crate::frame::{read_delimited, FramePolicy, FrameRead, StaticDelimitedFramePolicy};
use crate::{Error, Result};
use bytes::{BufMut, BytesMut};
use ct_protocol::{WireRequestV1, WireResponseV1};
use sqlx::MySqlPool;
use std::future::Future;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;

/// Max bytes per request line (JSON-per-line protocol). A
/// well-formed request is well under 1 KiB; 1 MiB is generous and
/// also bounds the worst case if a buggy client sends a huge blob
/// without newlines (we'd otherwise grow the read buffer
/// unboundedly).
const MAX_REQUEST_LINE_BYTES: usize = 1 << 20; // 1 MiB

/// Maximum bytes requested from the runtime per daemon socket read.
///
/// # Project Decision Logic
///
/// 8 KiB tracks the common page-size / socket-buffer sweet spot for
/// small control-plane messages: honest panel requests complete in
/// one read, while hostile peers still need many scheduler turns to
/// reach the 1 MiB hard cap. This keeps cooperative Tokio scheduling
/// fair under contention.
const MAX_REQUEST_READ_CHUNK_BYTES: usize = 8 * 1024;

/// Concurrent-handler cap. The Bun admin runtime is the only legitimate
/// client of this socket. 16 leaves headroom for parallel browser
/// actions, doctor/update work, and internal probes while preventing a
/// misbehaving local client from driving unbounded handler-task spawn.
/// `main.rs` reads this when constructing the shared `Arc<Semaphore>`
/// it passes into both `serve` and the `internal_metrics` registry
/// (so the metrics endpoint can publish
/// `ct_daemon_handler_permits_total`).
pub const MAX_CONCURRENT_HANDLERS: usize = 16;

/// Per-request line-read timeout. A connected client that sends part
/// of a request and stalls (network partition, suspended process,
/// malicious holding pattern) would otherwise keep the handler task
/// — and the semaphore permit — alive indefinitely. 30 s is generous
/// (panel requests complete in tens of ms); this is a poison-pill
/// detector, not a perf knob.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Named contract for daemon JSON-line request acquisition.
///
/// RAG agents should retrieve this constant before changing socket
/// behavior; it encodes the consensus alignment between operator UX
/// (panel saves should not spuriously fail) and availability defense
/// (one stalled peer must not retain memory or a semaphore forever).
#[doc(alias = "daemon-rag-contract")]
#[doc(alias = "daemon-self-healing-policy")]
const DAEMON_FRAME_POLICY: StaticDelimitedFramePolicy = StaticDelimitedFramePolicy::new(
    "daemon-json-line-v1",
    b'\n',
    MAX_REQUEST_LINE_BYTES,
    READ_TIMEOUT,
    MAX_REQUEST_READ_CHUNK_BYTES,
);

/// Semantic contract for the daemon JSON-line transport boundary.
///
/// # Project Decision Logic
///
/// The daemon is intentionally long-lived so the DB pool stays warm. That
/// benefit only holds if malformed or slow clients fail at connection scope
/// instead of poisoning process state. The JSON-line policy, semaphore cap,
/// FSM hard reset, and typed wire errors all enforce the same game-theory
/// posture: cooperative panel requests stay cheap; non-cooperative peers lose
/// only their own connection.
#[doc(alias = "daemon-transport-rag-contract")]
#[doc(alias = "daemon-consensus-contract")]
const DAEMON_TRANSPORT_CONTRACT: SemanticContract = SemanticContract::new(
    "daemon-json-line-transport-v1",
    "Unix-socket JSON-line daemon transport",
    "Keep the warm-pool daemon alive by making frame, timeout, and FSM violations connection-scoped.",
    RecoveryScope::Connection,
    PRINCIPLE_LOCAL_RECOVERY,
);

/// Contract-first dispatch boundary for daemon requests.
///
/// Implementations must be idempotent at the transport level:
/// malformed or unsupported input returns a typed error response for
/// that request, while the daemon keeps serving subsequent requests on
/// the same process. Domain operations may fail fast internally, but
/// must recover gracefully at this boundary.
#[doc(alias = "rag-daemon-dispatch-contract")]
#[doc(alias = "consensus-alignment-contract")]
trait WireRequestDispatcher {
    /// Dispatch a decoded protocol request into a protocol response.
    async fn dispatch_wire(&self, req: WireRequestV1) -> Result<WireResponseV1>;
}

struct DaemonDispatcher<'a> {
    pool: &'a MySqlPool,
}

impl ContractBoundary for DaemonDispatcher<'_> {
    fn contract(&self) -> SemanticContract {
        DAEMON_TRANSPORT_CONTRACT
    }
}

impl WireRequestDispatcher for DaemonDispatcher<'_> {
    async fn dispatch_wire(&self, req: WireRequestV1) -> Result<WireResponseV1> {
        handle(req, self.pool).await
    }
}

pub async fn serve(socket_path: &str, pool: MySqlPool, permits: Arc<Semaphore>) -> Result<()> {
    // Ensure parent dir exists; remove any stale socket file.
    if let Some(dir) = Path::new(socket_path).parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|source| {
            Error::io_path("create_socket_dir", dir.display().to_string(), source)
        })?;
    }
    match tokio::fs::remove_file(socket_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(Error::io_path("remove_stale_socket", socket_path, source));
        }
    }

    let listener = UnixListener::bind(socket_path)
        .map_err(|source| Error::io_path("bind_unix_socket", socket_path, source))?;
    tokio::fs::set_permissions(
        socket_path,
        std::os::unix::fs::PermissionsExt::from_mode(0o660),
    )
    .await
    .map_err(|source| Error::io_path("chmod_unix_socket", socket_path, source))?;

    tracing::info!(
        path = socket_path,
        frame_policy = DAEMON_FRAME_POLICY.policy_name(),
        max_concurrent_handlers = MAX_CONCURRENT_HANDLERS,
        read_timeout_s = READ_TIMEOUT.as_secs(),
        "ct-server-core daemon listening"
    );

    // Concurrent-handler permit cap. Each accept acquires one
    // permit before spawning; the permit drops when the handler
    // exits. The (N+1)th simultaneous connection blocks at
    // `acquire_owned().await` until a handler completes — that's
    // the backpressure signal (slower accept under saturation,
    // no OOM). Semaphore constructed in main.rs so
    // internal_metrics can read available_permits().

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
        let permit = tokio::select! {
            () = &mut shutdown => {
                tracing::info!(path = socket_path, "ct-server-core daemon shutting down");
                drop(listener);
                remove_socket_on_shutdown(socket_path).await;
                return Ok(());
            }
            permit = Arc::clone(&permits).acquire_owned() => {
                permit.map_err(|_| Error::SemaphoreClosed {
                    resource: "daemon handler",
                })?
            }
        };
        tokio::select! {
            () = &mut shutdown => {
                tracing::info!(path = socket_path, "ct-server-core daemon shutting down");
                drop(listener);
                remove_socket_on_shutdown(socket_path).await;
                return Ok(());
            }
            res = listener.accept() => {
                let (stream, _) = match res {
                    Ok(pair) => pair,
                    Err(source) => {
                        drop(permit);
                        return Err(Error::io_path("accept_unix_socket", socket_path, source));
                    }
                };
                // MySqlPool is internally Arc'd; cloning bumps a
                // refcount and shares the underlying connection set.
                // No new TCP connections are opened on clone.
                let pool = pool.clone();
                spawn_observed("daemon client handler", async move {
                    // Permit is held by the spawned task; dropped
                    // when this closure returns (handler exit or
                    // error path). A new permit becomes available
                    // for the next accept.
                    let _permit = permit;
                    if let Err(e) =
                        handle_client(stream, &pool).await
                    {
                        tracing::warn!(error = %e, "client handler errored");
                    }
                });
            }
        }
    }
}

fn spawn_observed<F>(task: &'static str, future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let handle = tokio::spawn(future);
    let monitor = tokio::spawn(async move {
        if let Err(source) = handle.await {
            let err = Error::TaskJoin { task, source };
            tracing::error!(error = %err, "detached daemon task terminated abnormally");
        }
    });
    drop(monitor);
}

async fn remove_socket_on_shutdown(socket_path: &str) {
    match tokio::fs::remove_file(socket_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => tracing::warn!(
            path = socket_path,
            error = %e,
            "could not remove daemon socket during shutdown"
        ),
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

async fn handle_client(stream: UnixStream, pool: &MySqlPool) -> Result<()> {
    let (mut rd, mut wr) = stream.into_split();
    let fsm = ConnectionFsm::new();
    advance_or_reset(&fsm, ConnectionEvent::StartReading)?;
    // One reusable request buffer per connection. `read_delimited`
    // splits complete frames out of this buffer and leaves any bytes
    // already read for the next frame, avoiding a new Vec allocation
    // per request while preserving a hard size cap.
    let mut read_buf = BytesMut::with_capacity(8 * 1024);
    let mut write_buf = BytesMut::with_capacity(512);
    let mut heng_profile = HengProfile {
        read_chunk_bytes: DAEMON_FRAME_POLICY.max_read_chunk_len(),
        pressure_basis_points: 0,
        crossed_80pct: false,
    };
    loop {
        let turn_started = Instant::now();
        tracing::trace!(
            fsm_state = fsm.state().name(),
            heng_read_chunk_bytes = heng_profile.read_chunk_bytes,
            heng_pressure_basis_points = heng_profile.pressure_basis_points,
            "daemon FSM awaiting next frame"
        );
        let turn_frame_policy =
            DAEMON_FRAME_POLICY.with_max_read_chunk_len(heng_profile.read_chunk_bytes);
        let span = tracing::info_span!(
            "otel.network.turn",
            "network.transport" = "unix",
            "network.protocol.name" = "json-line",
            "rpc.system" = "ct-daemon",
            "rpc.method" = tracing::field::Empty,
            "ct.frame_policy" = turn_frame_policy.policy_name(),
            "ct.buffer_bytes" = tracing::field::Empty,
            "ct.buffer_limit_bytes" = MAX_REQUEST_LINE_BYTES,
            "ct.status_code" = tracing::field::Empty,
            fsm_state = fsm.state().name(),
            heng_read_chunk_bytes = heng_profile.read_chunk_bytes,
            heng_pressure_basis_points = heng_profile.pressure_basis_points,
        );
        let _span_guard = span.enter();
        let frame = match read_delimited(&mut rd, &mut read_buf, &turn_frame_policy).await {
            Ok(FrameRead::Complete(frame)) => {
                advance_or_reset(&fsm, ConnectionEvent::FrameComplete)?;
                frame
            }
            Ok(FrameRead::Eof) => {
                advance_or_reset(&fsm, ConnectionEvent::PeerClosed)?;
                break;
            }
            Err(Error::ReadTimeout { .. }) => {
                fsm_hard_reset(&fsm, "read_timeout");
                span.record("ct.status_code", "read_timeout");
                tracing::warn!(
                    "network.transport" = "unix",
                    "network.protocol.name" = "json-line",
                    "rpc.system" = "ct-daemon",
                    "ct.frame_policy" = turn_frame_policy.policy_name(),
                    timeout_s = READ_TIMEOUT.as_secs(),
                    "client read timeout - closing connection"
                );
                let resp = WireResponseV1::Error {
                    code: "read_timeout".into(),
                    message: format!(
                        "no request line within {} seconds; closing",
                        READ_TIMEOUT.as_secs()
                    ),
                };
                let _ = send(&mut wr, &mut write_buf, &resp).await;
                return Ok(());
            }
            Err(Error::FrameTooLarge { limit }) => {
                fsm_hard_reset(&fsm, "frame_too_large");
                span.record("ct.status_code", "request_too_large");
                let resp = WireResponseV1::Error {
                    code: "request_too_large".into(),
                    message: format!("request line exceeds {limit} bytes; closing connection"),
                };
                tracing::warn!(
                    "network.transport" = "unix",
                    "network.protocol.name" = "json-line",
                    "rpc.system" = "ct-daemon",
                    "ct.frame_policy" = turn_frame_policy.policy_name(),
                    "ct.buffer_limit_bytes" = limit,
                    "daemon frame exceeded hard byte limit"
                );
                send(&mut wr, &mut write_buf, &resp).await?;
                return Err(Error::FrameTooLarge { limit });
            }
            Err(Error::FrameIncomplete) => {
                fsm_hard_reset(&fsm, "frame_incomplete");
                span.record("ct.status_code", "incomplete_request");
                let resp = WireResponseV1::Error {
                    code: "incomplete_request".into(),
                    message: "connection closed before newline-delimited request completed".into(),
                };
                tracing::warn!(
                    "network.transport" = "unix",
                    "network.protocol.name" = "json-line",
                    "rpc.system" = "ct-daemon",
                    "ct.frame_policy" = turn_frame_policy.policy_name(),
                    "daemon frame incomplete at peer close"
                );
                let _ = send(&mut wr, &mut write_buf, &resp).await;
                return Ok(());
            }
            Err(e) => {
                fsm_hard_reset(&fsm, "frame_read_error");
                span.record("ct.status_code", e.wire_code());
                return Err(e);
            }
        };
        span.record("ct.buffer_bytes", frame.len());

        let line = match std::str::from_utf8(&frame) {
            Ok(s) => s,
            Err(e) => {
                fsm_hard_reset(&fsm, "invalid_utf8");
                span.record("ct.status_code", "bad_request");
                let resp = WireResponseV1::Error {
                    code: "bad_request".into(),
                    message: format!("non-utf8 input: {e}"),
                };
                tracing::warn!(
                    "network.transport" = "unix",
                    "network.protocol.name" = "json-line",
                    "rpc.system" = "ct-daemon",
                    "error.type" = "utf8",
                    "daemon received non-utf8 frame"
                );
                send(&mut wr, &mut write_buf, &resp).await?;
                return Ok(());
            }
        };
        advance_or_reset(&fsm, ConnectionEvent::Utf8Decoded)?;
        let req: WireRequestV1 = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                fsm_hard_reset(&fsm, "invalid_json");
                span.record("ct.status_code", "bad_request");
                let resp = WireResponseV1::Error {
                    code: "bad_request".into(),
                    message: e.to_string(),
                };
                tracing::warn!(
                    "network.transport" = "unix",
                    "network.protocol.name" = "json-line",
                    "rpc.system" = "ct-daemon",
                    "error.type" = "json",
                    "daemon received malformed json frame"
                );
                send(&mut wr, &mut write_buf, &resp).await?;
                return Ok(());
            }
        };
        advance_or_reset(&fsm, ConnectionEvent::JsonDecoded)?;
        let method = wire_method_name(&req);
        span.record("rpc.method", method);
        let dispatcher = DaemonDispatcher { pool };
        tracing::trace!(
            contract = dispatcher.contract().id(),
            "daemon dispatch boundary selected"
        );
        let (resp, status_code) = match dispatcher.dispatch_wire(req).await {
            Ok(r) => (r, "ok"),
            Err(e) => {
                let code = e.wire_code();
                (
                    WireResponseV1::Error {
                        code: code.into(),
                        message: e.to_string(),
                    },
                    code,
                )
            }
        };
        span.record("ct.status_code", status_code);
        advance_or_reset(&fsm, ConnectionEvent::Dispatched)?;
        tracing::trace!(
            latency_ms = turn_started.elapsed().as_millis() as u64,
            "daemon network turn completed"
        );
        if let Err(e) = send(&mut wr, &mut write_buf, &resp).await {
            fsm_hard_reset(&fsm, "write_response_failed");
            return Err(e);
        }
        advance_or_reset(&fsm, ConnectionEvent::ResponseWritten)?;
        heng_profile = fsm.probe_constancy(
            turn_started.elapsed(),
            frame.len(),
            MAX_REQUEST_LINE_BYTES,
            DAEMON_FRAME_POLICY.max_read_chunk_len(),
        );
        if heng_profile.crossed_80pct {
            tracing::warn!(
                pressure_basis_points = heng_profile.pressure_basis_points,
                next_read_chunk_bytes = heng_profile.read_chunk_bytes,
                "daemon Heng constancy probe crossed 80% pressure threshold"
            );
        }
        advance_or_reset(&fsm, ConnectionEvent::ConstancyProbed)?;
    }
    Ok(())
}

fn advance_or_reset(fsm: &ConnectionFsm, event: ConnectionEvent) -> Result<()> {
    match fsm.apply(event) {
        TransitionOutcome::Advanced => Ok(()),
        TransitionOutcome::HardReset {
            event,
            expected,
            observed,
            requested,
        } => {
            tracing::warn!(
                event = event.name(),
                expected_state = expected.name(),
                observed_state = observed.name(),
                requested_state = requested.name(),
                "daemon FSM invalid transition; hard reset"
            );
            Err(Error::BadRequest {
                code: "fsm_hard_reset",
                message: format!(
                    "daemon FSM rejected event {} ({} -> {}); observed {}",
                    event.name(),
                    expected.name(),
                    requested.name(),
                    observed.name()
                ),
            })
        }
    }
}

fn fsm_hard_reset(fsm: &ConnectionFsm, reason: &'static str) {
    fsm.hard_reset(reason);
    tracing::warn!(reason, state = fsm.state().name(), "daemon FSM hard reset");
}

fn wire_method_name(req: &WireRequestV1) -> &'static str {
    match req {
        WireRequestV1::RenderCaddyfile => "render_caddyfile",
        WireRequestV1::ReloadCaddy => "reload_caddy",
        WireRequestV1::CollectTraffic => "collect_traffic",
        WireRequestV1::EnforceQuota => "enforce_quota",
        WireRequestV1::Health => "health",
    }
}

async fn send<W: AsyncWrite + Unpin>(
    w: &mut W,
    buf: &mut BytesMut,
    resp: &WireResponseV1,
) -> Result<()> {
    buf.clear();
    {
        let mut writer = (&mut *buf).writer();
        serde_json::to_writer(&mut writer, resp)?;
    }
    buf.put_u8(b'\n');
    w.write_all(&buf[..]).await?;
    w.flush().await?;
    Ok(())
}

async fn handle(req: WireRequestV1, pool: &MySqlPool) -> Result<WireResponseV1> {
    match req {
        // v0.4.0 — RenderCaddyfile / ReloadCaddy / CollectTraffic /
        // EnforceQuota are all wire-protocol dead letters:
        //
        // - The panel's SingBoxConfigGenerator shells directly to
        //   /usr/local/bin/singbox-core render-server; it does NOT
        //   dispatch through the daemon's unix socket.
        // - CaddyfileGenerator + the artisan caddy:reload path call
        //   `ct-server-core caddyfile {render,reload}` (the CLI
        //   subcommand), not this daemon wire path.
        // - CollectTraffic + EnforceQuota relied on sing-box's clash
        //   admin API, which sing-box VLESS+Reality does not expose.
        //
        // The WireRequestV1 enum variants stay in ct-protocol for
        // wire compatibility — old panel builds and the macOS client
        // both speak WireV1 — but every dispatch arm here returns
        // UnsupportedOperation so an out-of-band caller gets a clear
        // error rather than a silent no-op.
        WireRequestV1::RenderCaddyfile => Err(Error::UnsupportedOperation {
            operation: "render_caddyfile",
            message:
                "v0.4.0: panel-side SingBoxConfigGenerator renders directly via singbox-core; \
                      no daemon-side renderer remains. Use `ct-server-core caddyfile render` for \
                      Caddyfile-only renders.",
        }),
        WireRequestV1::ReloadCaddy => Err(Error::UnsupportedOperation {
            operation: "reload_caddy",
            message: "v0.4.0: Caddy reloads are operator-owned and run from the host side \
                      via `docker compose exec caddy caddy reload`.",
        }),
        WireRequestV1::CollectTraffic => Err(Error::UnsupportedOperation {
            operation: "collect_traffic",
            message: "v0.4.0: sing-box VLESS+Reality exposes no clash admin API; per-user \
                      traffic counters are not collected by the current runtime.",
        }),
        WireRequestV1::EnforceQuota => Err(Error::UnsupportedOperation {
            operation: "enforce_quota",
            message: "v0.4.0: per-user quota enforcement is retired in the current \
                      VLESS+Reality runtime; account enablement and expiry propagate via \
                      singbox.json regeneration.",
        }),
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn daemon_transport_contract_is_connection_scoped() {
        assert_eq!(
            DAEMON_TRANSPORT_CONTRACT.id(),
            "daemon-json-line-transport-v1"
        );
        assert_eq!(
            DAEMON_TRANSPORT_CONTRACT.recovery_scope(),
            RecoveryScope::Connection
        );
    }
}
