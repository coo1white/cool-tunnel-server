// Active anti-tracking probe.
//
// We dial *through* the configured proxy and hit a small JSON
// endpoint that echoes the request headers it received. If
// hide_ip / hide_via are working, the response should NOT contain
// X-Forwarded-For, Forwarded, X-Real-IP, or Via headers seen from
// the client side.
//
// Transport: a packaged `naive` client binary (klzgrad/naiveproxy)
// is spawned as a child process bound to a free port on
// 127.0.0.1, and reqwest dials through it as an HTTP CONNECT
// proxy. This is required because sing-box's `naive` inbound
// enforces a padding extension on CONNECT; vanilla reqwest is
// dropped at the inbound with `missing naive padding` (R4-3 in
// docs/audits/2026-05-04T06-31-58Z.md). Shelling out to the
// upstream reference client is the lowest-risk way to speak the
// padding correctly without re-implementing it in Rust. The
// binary is pinned in docker/panel/Dockerfile (ARG NAIVE_VERSION
// + ARG NAIVE_SHA256) and verified by manifests/naiveproxy-client
// .upstream.json.
//
// The probe is best-effort — it doesn't tell you whether a
// censorship system can fingerprint your TLS handshake, only
// whether the configured Caddy mitigations are *actually* on the
// wire.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::sleep;

/// Path to the bundled naive client binary inside the panel image.
const NAIVE_BINARY: &str = "/usr/local/bin/naive";

/// How long we wait for the spawned naive subprocess to bind its
/// local listener before declaring failure. Naive's startup is
/// dominated by Chromium net stack init (~50-200 ms on the panel
/// container's CPU class); 3 s is generous headroom for a slow
/// VPS without making a wedged process hang the probe call.
const NAIVE_STARTUP_TIMEOUT: Duration = Duration::from_secs(3);

/// Polling interval for the readiness loop.
const NAIVE_STARTUP_POLL: Duration = Duration::from_millis(50);

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
    // The naive subprocess is held in `_naive_proc` for its kill-
    // on-drop behaviour: when this function returns, the child is
    // killed and its sockets close. Without this, a probe failure
    // path could leak a SOCKS/HTTP listener inside the panel image.
    let _naive_proc: Option<NaiveLocal>;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(false);

    if let Some(via_url) = via {
        let local = NaiveLocal::spawn(via_url).await?;
        let proxy = reqwest::Proxy::all(local.proxy_url())?;
        builder = builder.proxy(proxy);
        _naive_proc = Some(local);
    } else {
        _naive_proc = None;
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
        Some(public_url) => match client_no_proxy() {
            Ok(c) => match c.get(&public_url).send().await {
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
            Err(e) => {
                tracing::warn!(error = %e, "probe-resistance check skipped");
                false
            }
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

/// A locally-spawned naive client subprocess. Translates plain
/// HTTP CONNECT requests on a 127.0.0.1 port into authenticated,
/// padding-aware HTTP/2 CONNECTs to the upstream proxy. Holding
/// this struct keeps the child alive; dropping it kills the child
/// (Command::kill_on_drop).
struct NaiveLocal {
    _child: Child,
    port: u16,
}

impl NaiveLocal {
    async fn spawn(via_url: &str) -> Result<Self> {
        let port = pick_free_port()?;
        let listen = format!("http://127.0.0.1:{port}");
        let mut child = Command::new(NAIVE_BINARY)
            .args(["--listen", &listen, "--proxy", via_url])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| Error::msg(format!("spawn {NAIVE_BINARY}: {e}")))?;

        // Poll the local port until naive is bound, or until we've
        // burned NAIVE_STARTUP_TIMEOUT. If the child exits inside
        // that window, naive could not run at all (bad arg, missing
        // dep, etc.) — surface that as a distinct error rather than
        // letting the bind-poll keep ticking.
        let deadline = Instant::now() + NAIVE_STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(Error::msg(format!(
                    "naive client exited before binding 127.0.0.1:{port} (status={:?})",
                    status.code()
                )));
            }
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return Ok(Self {
                    _child: child,
                    port,
                });
            }
            sleep(NAIVE_STARTUP_POLL).await;
        }
        Err(Error::msg(format!(
            "naive client did not bind 127.0.0.1:{port} within {:?}",
            NAIVE_STARTUP_TIMEOUT
        )))
    }

    fn proxy_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

fn pick_free_port() -> Result<u16> {
    // Bind, capture the assigned port, drop the listener so naive
    // can take it. A short TOCTTOU window between drop and naive's
    // bind exists; in the panel container's tight environment, the
    // race is acceptably remote.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| Error::msg(format!("probe: bind ephemeral port: {e}")))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| Error::msg(format!("probe: local_addr: {e}")))
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

fn client_no_proxy() -> Result<reqwest::Client> {
    // No silent fallback to `Client::new()` — that path would lose
    // the 10s timeout and the no_proxy() opt-out, both of which
    // are load-bearing for the probe's correctness. If TLS init
    // genuinely fails on this machine, propagate the error.
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .map_err(|e| Error::msg(format!("probe: could not construct no-proxy client: {e}")))
}
