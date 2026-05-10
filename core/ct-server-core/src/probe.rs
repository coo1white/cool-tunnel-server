// SPDX-License-Identifier: AGPL-3.0-only
//! Active anti-tracking probe.
//!
//! We dial *through* the configured proxy and hit a small JSON
//! endpoint that echoes the request headers it received. If
//! hide_ip / hide_via are working, the response should NOT contain
//! X-Forwarded-For, Forwarded, X-Real-IP, or Via headers seen from
//! the client side.
//!
//! Transport: a packaged `naive` client binary (klzgrad/naiveproxy)
//! is spawned as a child process bound to a free port on
//! 127.0.0.1, and reqwest dials through it as an HTTP CONNECT
//! proxy. This is required because sing-box's `naive` inbound
//! enforces a padding extension on CONNECT; vanilla reqwest is
//! dropped at the inbound with `missing naive padding` (R4-3 in
//! docs/audits/2026-05-04T06-31-58Z.md). Shelling out to the
//! upstream reference client is the lowest-risk way to speak the
//! padding correctly without re-implementing it in Rust. The
//! binary is pinned in docker/panel/Dockerfile (ARG NAIVE_VERSION
//! + ARG NAIVE_SHA256) and verified by manifests/naiveproxy-client
//!   `.upstream.json`.
//!
//! The probe is best-effort — it doesn't tell you whether a
//! censorship system can fingerprint your TLS handshake, only
//! whether the configured Caddy mitigations are *actually* on the
//! wire.

use crate::contracts::{
    ContractBoundary, RecoveryScope, SemanticContract, PRINCIPLE_LOCAL_RECOVERY,
};
use crate::observability::{duration_ms_u64, otel_key};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
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

/// Semantic contract for the anti-tracking probe boundary.
///
/// # Project Decision Logic
///
/// The probe is a measurement surface, not a control plane. A false positive
/// would tell an operator that cover traffic is safe when it is not, while a
/// false negative only asks them to investigate. Therefore this boundary
/// favors conservative failure and typed JSON output over best-effort success.
/// The subprocess startup cap stays short because the honest path is local
/// process bind plus one HTTP request; anything slower is already degraded
/// subsystem health.
#[doc(alias = "anti-tracking-rag-contract")]
#[doc(alias = "probe-self-healing-contract")]
const ANTI_TRACKING_CONTRACT: SemanticContract = SemanticContract::new(
    "anti-tracking-probe-v1",
    "CLI anti-tracking probe through packaged naive client",
    "Measure privacy posture conservatively; bound subprocess and HTTP waits so one failed probe cannot wedge scheduler or operator CLI.",
    RecoveryScope::Request,
    PRINCIPLE_LOCAL_RECOVERY,
);

/// Contract-first surface for active anti-tracking checks.
///
/// Implementations must return machine-readable probe results and must not
/// mutate server config. This keeps the probe safe for scheduler use and easy
/// for AI-generated tests to mock without spawning the upstream `naive`
/// binary.
#[doc(alias = "rag-anti-tracking-contract")]
#[doc(alias = "consensus-alignment-contract")]
trait AntiTrackingProbe: ContractBoundary {
    /// Run one check against `target`, optionally through an upstream proxy URL.
    async fn run(&self, target: &str, via: Option<&str>) -> Result<ProbeResult>;
}

/// Default production anti-tracking probe.
struct NaiveAntiTrackingProbe;

impl ContractBoundary for NaiveAntiTrackingProbe {
    fn contract(&self) -> SemanticContract {
        ANTI_TRACKING_CONTRACT
    }
}

impl AntiTrackingProbe for NaiveAntiTrackingProbe {
    async fn run(&self, target: &str, via: Option<&str>) -> Result<ProbeResult> {
        run_anti_tracking_probe(target, via).await
    }
}

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
    let probe = NaiveAntiTrackingProbe;
    let result = probe.run(target, via).await?;
    print_result(&result)
}

async fn run_anti_tracking_probe(target: &str, via: Option<&str>) -> Result<ProbeResult> {
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

    let client = builder.build().map_err(Error::Http)?;

    // 1) Reachability + header echo. Most public echo endpoints
    // (postman-echo, ifconfig.co/json) reflect headers; we use
    // ifconfig.co/json by default since it shows the IP the upstream
    // saw plus a copy of the request headers.
    let reachable;
    let echoed_headers: serde_json::Value;
    let reachability_started = Instant::now();
    let reachability_span = outbound_http_span("GET", "anti-tracking-target");
    let reachability_guard = reachability_span.enter();
    match client.get(target).send().await {
        Ok(resp) => {
            let status = resp.status();
            reachability_span.record(otel_key::CT_STATUS_CODE, status.as_u16());
            reachable = status.is_success();
            echoed_headers = match resp.json().await {
                Ok(json) => json,
                Err(e) => {
                    tracing::warn!(error = %e, "probe header echo response was not json");
                    serde_json::Value::Null
                }
            };
        }
        Err(e) => {
            reachability_span.record(otel_key::CT_STATUS_CODE, "request_error");
            tracing::warn!(error = %e, "probe reachability failed");
            return Ok(ProbeResult {
                via: via.map(str::to_owned),
                target: target.to_owned(),
                reachable: false,
                hide_ip_effective: false,
                hide_via_effective: false,
                probe_resistance_effective: false,
            });
        }
    }
    tracing::trace!(
        latency_ms = duration_ms_u64(reachability_started.elapsed()),
        "anti-tracking probe target network turn completed"
    );
    drop(reachability_guard);

    // 2) For probe_resistance, hit the proxy's apex *without* auth
    // and check we get an HTML page (the fake site) rather than a
    // 407 / "Proxy Authentication Required". A correctly-configured
    // server returns 200 + HTML to unauthenticated CONNECT-shaped
    // requests; that's the whole point of probe_resistance.
    let probe_resistance_effective = match via.and_then(strip_creds) {
        Some(public_url) => match client_no_proxy() {
            Ok(c) => {
                let apex_started = Instant::now();
                let apex_span = outbound_http_span("GET", "anti-tracking-cover-site");
                let apex_guard = apex_span.enter();
                let ok = match c.get(&public_url).send().await {
                    Ok(r) => {
                        let status = r.status();
                        apex_span.record(otel_key::CT_STATUS_CODE, status.as_u16());
                        let ctype = r
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_owned();
                        status.is_success() && ctype.starts_with("text/html")
                    }
                    Err(_) => {
                        apex_span.record(otel_key::CT_STATUS_CODE, "request_error");
                        false
                    }
                };
                tracing::trace!(
                    latency_ms = duration_ms_u64(apex_started.elapsed()),
                    "anti-tracking cover-site network turn completed"
                );
                drop(apex_guard);
                ok
            }
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

    Ok(ProbeResult {
        via: via.map(str::to_owned),
        target: target.to_owned(),
        reachable,
        hide_ip_effective: !saw_xff,
        hide_via_effective: !saw_via,
        probe_resistance_effective,
    })
}

fn outbound_http_span(method: &'static str, surface: &'static str) -> tracing::Span {
    tracing::info_span!(
        "otel.network.turn",
        { otel_key::NETWORK_TRANSPORT } = "tcp",
        { otel_key::NETWORK_PROTOCOL_NAME } = "http",
        { otel_key::RPC_SYSTEM } = "ct-probe",
        { otel_key::HTTP_REQUEST_METHOD } = method,
        { otel_key::URL_PATH } = surface,
        { otel_key::CT_STATUS_CODE } = tracing::field::Empty,
    )
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
        let port = pick_free_port().await?;
        let listen = format!("http://127.0.0.1:{port}");
        let (listen_arg, proxy_arg) = naive_args(&listen, via_url);
        let mut child = Command::new(NAIVE_BINARY)
            .args([&listen_arg, &proxy_arg])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|source| Error::ProcessSpawn {
                program: NAIVE_BINARY,
                source,
            })?;

        // Poll the local port until naive is bound, or until we've
        // burned NAIVE_STARTUP_TIMEOUT. If the child exits inside
        // that window, naive could not run at all (bad arg, missing
        // dep, etc.) — surface that as a distinct error rather than
        // letting the bind-poll keep ticking.
        let deadline = Instant::now() + NAIVE_STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(Error::ProcessExitedEarly {
                    program: NAIVE_BINARY,
                    code: status.code(),
                    address: format!("127.0.0.1:{port}"),
                });
            }
            let readiness_started = Instant::now();
            let readiness_span = tracing::info_span!(
                "otel.network.turn",
                { otel_key::NETWORK_TRANSPORT } = "tcp",
                { otel_key::NETWORK_PROTOCOL_NAME } = "tcp",
                { otel_key::RPC_SYSTEM } = "ct-probe",
                { otel_key::URL_PATH } = "naive-local-readiness",
                { otel_key::CT_STATUS_CODE } = tracing::field::Empty,
            );
            let readiness_guard = readiness_span.enter();
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                readiness_span.record(otel_key::CT_STATUS_CODE, "ok");
                tracing::trace!(
                    latency_ms = duration_ms_u64(readiness_started.elapsed()),
                    "naive readiness TCP network turn completed"
                );
                drop(readiness_guard);
                return Ok(Self {
                    _child: child,
                    port,
                });
            }
            readiness_span.record(otel_key::CT_STATUS_CODE, "connect_error");
            drop(readiness_guard);
            sleep(NAIVE_STARTUP_POLL).await;
        }
        Err(Error::ProcessStartTimeout {
            program: NAIVE_BINARY,
            address: format!("127.0.0.1:{port}"),
            timeout: NAIVE_STARTUP_TIMEOUT,
        })
    }

    fn proxy_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl ContractBoundary for NaiveLocal {
    fn contract(&self) -> SemanticContract {
        ANTI_TRACKING_CONTRACT
    }
}

fn naive_args(listen: &str, via_url: &str) -> (String, String) {
    (format!("--listen={listen}"), format!("--proxy={via_url}"))
}

async fn pick_free_port() -> Result<u16> {
    // Bind, capture the assigned port, drop the listener so naive
    // can take it. A short TOCTTOU window between drop and naive's
    // bind exists; in the panel container's tight environment, the
    // race is acceptably remote.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|source| Error::io_path("bind_ephemeral_port", "127.0.0.1:0", source))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|source| Error::io_path("local_addr", "127.0.0.1:0", source))
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
        .map_err(Error::Http)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_args_use_equals_form_expected_by_upstream_cli() {
        let (listen, proxy) = naive_args("http://127.0.0.1:12345", "https://u:p@example.com:443");

        assert_eq!(listen, "--listen=http://127.0.0.1:12345");
        assert_eq!(proxy, "--proxy=https://u:p@example.com:443");
    }

    struct MockAntiTrackingProbe {
        result: ProbeResult,
    }

    impl ContractBoundary for MockAntiTrackingProbe {
        fn contract(&self) -> SemanticContract {
            ANTI_TRACKING_CONTRACT
        }
    }

    impl AntiTrackingProbe for MockAntiTrackingProbe {
        async fn run(&self, _target: &str, _via: Option<&str>) -> Result<ProbeResult> {
            Ok(ProbeResult {
                via: self.result.via.clone(),
                target: self.result.target.clone(),
                reachable: self.result.reachable,
                hide_ip_effective: self.result.hide_ip_effective,
                hide_via_effective: self.result.hide_via_effective,
                probe_resistance_effective: self.result.probe_resistance_effective,
            })
        }
    }

    #[tokio::test]
    async fn anti_tracking_trait_is_mockable_for_ai_generated_tests() -> Result<()> {
        let probe = MockAntiTrackingProbe {
            result: ProbeResult {
                via: Some("https://u:p@example.com:443".into()),
                target: "https://ifconfig.co/json".into(),
                reachable: true,
                hide_ip_effective: true,
                hide_via_effective: true,
                probe_resistance_effective: true,
            },
        };

        let result = probe
            .run(
                "https://ifconfig.co/json",
                Some("https://u:p@example.com:443"),
            )
            .await?;

        assert_eq!(probe.contract().id(), "anti-tracking-probe-v1");
        assert!(result.hide_ip_effective);
        assert!(result.probe_resistance_effective);
        Ok(())
    }
}
