// Long-running daemon. Listens on a unix socket and accepts
// `WireRequestV1` JSON-per-line, replies with `WireResponseV1`.
//
// Why a daemon at all (vs. one-shot CLI invocations)? The DB pool
// stays warm, which makes per-request latency roughly 5x lower —
// that matters for the "save in Filament → reload visible" cycle the
// admin clicks through dozens of times.

use crate::{admin, caddyfile, db, metrics, Error, Result};
use ct_protocol::{WireRequestV1, WireResponseV1};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

pub async fn serve(
    socket_path: &str,
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
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
    let admin_socket = admin_socket.to_owned();

    loop {
        let (stream, _) = listener.accept().await?;
        let database_url = database_url.clone();
        let template = template.clone();
        let output = output.clone();
        let admin_socket = admin_socket.clone();
        tokio::spawn(async move {
            if let Err(e) =
                handle_client(stream, &database_url, &template, &output, &admin_socket).await
            {
                tracing::warn!(error = %e, "client handler errored");
            }
        });
    }
}

async fn handle_client(
    stream: UnixStream,
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
) -> Result<()> {
    let (rd, mut wr) = stream.into_split();
    let mut lines = BufReader::new(rd).lines();
    while let Some(line) = lines.next_line().await? {
        let req: WireRequestV1 = match serde_json::from_str(&line) {
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
        let resp = match handle(req, database_url, template, output, admin_socket).await {
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
    admin_socket: &str,
) -> Result<WireResponseV1> {
    match req {
        WireRequestV1::RenderCaddyfile => {
            // Reuse the CLI render but capture the structured outcome
            // by re-implementing the logic here. (We could refactor
            // caddyfile::render to return RenderOutcome; left for v0.0.2.)
            caddyfile::render(database_url, template, output, false, false).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::ReloadCaddy => {
            let started = std::time::Instant::now();
            admin::reload_caddyfile_text(admin_socket, output).await?;
            Ok(WireResponseV1::CaddyReloaded {
                duration_ms: started.elapsed().as_millis() as u64,
            })
        }
        WireRequestV1::CollectTraffic => {
            metrics::collect(database_url, admin_socket).await?;
            Ok(WireResponseV1::Ok)
        }
        WireRequestV1::EnforceQuota => {
            crate::quota::enforce(database_url, template, output, admin_socket).await?;
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
