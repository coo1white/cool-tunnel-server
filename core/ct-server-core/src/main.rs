// SPDX-License-Identifier: AGPL-3.0-only
//! ct-server-core — CLI entry point.
//!
//! Subcommand dispatch only. Each subcommand lives in its own module so
//! the heavy lifting (DB queries, admin API calls, parsing) is testable
//! in isolation.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod caddy;
mod canary;
mod components;
mod contracts;
mod daemon;
mod daemon_fsm;
mod db;
mod domain;
mod err;
mod frame;
// haproxy/ deleted in v0.2.0 (Caddy SNI-routes the panel reverse-proxy
// itself; HAProxy front door is gone).
mod internal_metrics;
// naive/ retired in v0.4.0 — replaced by singbox-core (Bun TS package
// bundled into the panel container). singbox/ + quota/ + metrics/ +
// admin/ + credentials/ all deleted alongside the sing-box-via-Rust
// renderer they hung off:
//   - singbox::render rendered the v0.3.x naive inbound shape from
//     a template; the v0.4.0 renderer is singbox-core's
//     renderServerConfig, shelled to from PHP.
//   - quota::enforce and metrics::collect both spoke to sing-box's
//     clash admin API. v0.4.0 sing-box VLESS+Reality does not expose
//     a clash API at all; per-user accounting is operator-side via
//     `singbox-core supervise`'s healthz + the panel's revocation bus.
//   - admin/ was the clash-API HTTP client used by quota + metrics.
//   - credentials::assert_locked compared the rendered naive users[]
//     against DB tuples; v0.4.0's equivalent check is
//     `operator/src/util/drift-check.ts`'s parseSingboxJsonUsers.
mod observability;
mod probe;
mod redis_bridge;
mod template;
mod util;

pub use err::{Error, Result};

use clap::{Parser, Subcommand};
use std::process::ExitCode;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "ct-server-core", version, about)]
struct Cli {
    /// Database URL. Defaults to env `DATABASE_URL` or assembled
    /// panel-style from DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME /
    /// DB_PASSWORD.
    #[arg(long, env = "DATABASE_URL", global = true)]
    database_url: Option<String>,

    // v0.4.0 — dropped Cli fields:
    //   template       (was SINGBOX_CONFIG_TEMPLATE; sing-box template
    //                  rendering moved to singbox-core, shelled to from
    //                  panel-side SingBoxConfigGenerator).
    //   output         (was SINGBOX_CONFIG_PATH; only consumer was the
    //                  deleted Rust renderer + credentials::assert_locked).
    //   admin_url      (was SINGBOX_CLASH_URL; sing-box VLESS+Reality has
    //                  no clash admin API at all).
    //   admin_secret   (was SINGBOX_CLASH_SECRET; same — no clash API).
    // The corresponding env vars in docker-compose are deprecated; if
    // they're set the binary silently ignores them (clap with no matching
    // arg is a no-op).
    /// Panel subdomain. Used by the Caddyfile renderer to attach
    /// Caddy auto-HTTPS for the panel cert. Defaults to
    /// `panel.${DOMAIN}` when unset; install.sh writes the chosen
    /// value into .env at first boot. (R1-1 / R1-2, v0.0.33.)
    #[arg(long, env = "PANEL_DOMAIN", default_value = "", global = true)]
    panel_domain: String,

    /// Print machine-readable JSON instead of human-readable lines.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Caddyfile generation + Caddy reload. v0.4.0: Caddy is the
    /// layer4 SNI splitter (panel.* → inner :8443, everything else →
    /// tcp/ct-singbox:443) plus the inner panel reverse-proxy. No
    /// per-account state here — that lives in /data/config/singbox.json
    /// (singbox-core's output, file-watched by ct-singbox's supervisor).
    Caddyfile {
        #[command(subcommand)]
        op: CaddyfileOp,
    },
    // v0.4.0 — removed Cmd variants:
    //   Singbox / SingboxOp  → renderer moved to singbox-core (Bun TS)
    //   Server / ServerOp    → clash admin API doesn't exist on sing-box
    //                          VLESS+Reality
    //   Traffic / TrafficOp  → per-user counters came from clash-API
    //   Quota / QuotaOp      → quota enforcement via clash-API reload
    //   Guard / GuardOp      → credentials::assert_locked compared the
    //                          v0.3.x naive users shape; v0.4.0's
    //                          equivalent is operator/src/util/drift-check
    //   Admin::ClashSecret   → derives a bearer for an API that's gone
    /// Active probes (anti-tracking, connectivity, ACME).
    Probe {
        #[command(subcommand)]
        op: ProbeOp,
    },
    /// Long-running JSON-over-unix-socket daemon. Also subscribes
    /// to the Redis revocation channel for ≤100 ms Filament-to-
    /// sing-box reload propagation.
    Daemon {
        #[arg(
            long,
            env = "CT_CORE_SOCKET",
            default_value = "/run/cool-tunnel/core.sock"
        )]
        socket: String,
        /// Redis URL for the revocation bridge subscription. Empty
        /// (default) skips the subscriber — single-host dev only.
        #[arg(long, env = "REDIS_URL", default_value = "")]
        redis_url: String,
        /// Bind address for the operator-internal-health
        /// `/metrics` endpoint (Prometheus text-format). Empty
        /// (default) → endpoint disabled. Recommended single-
        /// container value: `127.0.0.1:9292` (ct-server-core
        /// runs inside the panel container alongside FrankenPHP;
        /// `docker compose exec ct-panel curl
        /// http://127.0.0.1:9292/metrics` reaches it). Per
        /// LTSC.md § Internal-health observability vs user
        /// analytics, this surface is operator-internal-health
        /// only — never per-user data, never a public port.
        /// (v0.0.67.)
        #[arg(long, env = "CT_METRICS_BIND", default_value = "")]
        metrics_bind: String,
    },
    /// Component-as-machine-part: list / check installed components.
    Component {
        #[command(subcommand)]
        op: ComponentOp,
    },
    /// Operator-facing administration helpers.
    Admin {
        #[command(subcommand)]
        op: AdminOp,
    },
    /// Self-probe canary — early-warning surface for "this VPS is
    /// becoming unreachable from its own network position." See
    /// `docs/going-to-china.md` for the operator-facing context.
    Canary {
        #[command(subcommand)]
        op: CanaryOp,
    },
    /// Print the build manifest.
    Version,
}

#[derive(Subcommand, Debug)]
enum CanaryOp {
    /// Run one self-probe (DoH-resolve apex + TCP-connect to
    /// haproxy:443) and append the result to ServerConfig.
    /// `self_probe_history`. Wired into the Laravel scheduler
    /// (every 5 min) by panel/routes/console.php.
    Probe,
    /// Print the recorded self-probe history (one JSON entry per
    /// line, oldest first). Operator surface for "what's the
    /// canary saying right now" without going through the panel.
    Status,
}

#[derive(Subcommand, Debug)]
enum AdminOp {
    // v0.4.0 — `Admin::ClashSecret` removed. The clash API the secret
    // gated doesn't exist on sing-box VLESS+Reality, and the upstream
    // drift probe at manifests/sing-box.upstream.json is replaced in
    // v0.4.0 by operator/src/util/version-bridge.ts (which shells to
    // `singbox-core version --json`, not the clash /version endpoint).
    /// Print the resolved panel hostname to stdout. The Cycle 3
    /// `SoT` (v0.0.55) anchor — single source of truth for
    /// `panel.<base>` derivation, mirrored byte-for-byte by
    /// `panel/config/cool-tunnel.php::panel_domain`. Used by
    /// `scripts/verify_sot.sh` to assert PHP/Rust parity.
    /// Resolution: `PANEL_DOMAIN` env > `panel.<DOMAIN>` env >
    /// fail-fast. Whitespace in either is trimmed; both empty
    /// errors loudly rather than producing `panel.` with no base.
    PanelDomain,
}

// GuardOp removed in v0.4.0 — credentials::assert_locked compared the
// v0.3.x naive users shape against DB tuples; v0.4.0's equivalent
// three-way drift check lives in operator/src/util/drift-check.ts
// (DB UUID ⇄ rendered singbox.json users[] UUID ⇄ subscription
// endpoint UUID).

#[derive(Subcommand, Debug)]
enum ComponentOp {
    /// List components from the manifests directory.
    List {
        #[arg(long, env = "CT_MANIFESTS_DIR", default_value = "/srv/manifests")]
        manifests: String,
    },
    /// Run OK/NG check against every component manifest.
    Check {
        #[arg(long, env = "CT_MANIFESTS_DIR", default_value = "/srv/manifests")]
        manifests: String,
    },
}

// SingboxOp removed in v0.4.0 — the renderer is now singbox-core
// (Bun TS), shelled to from panel-side SingBoxConfigGenerator. The
// "validate" path moves into singbox-core supervise as well (sing-box
// check runs in-container, not via this CLI).

#[derive(Subcommand, Debug)]
enum CaddyfileOp {
    /// Render template → /etc/caddy/Caddyfile (atomic).
    Render {
        #[arg(long)]
        dry_run: bool,
        /// Override template path.
        #[arg(
            long,
            env = "CADDYFILE_TEMPLATE",
            default_value = "/srv/caddy/Caddyfile.tpl"
        )]
        template: String,
        /// Override output path.
        #[arg(long, env = "CADDYFILE_PATH", default_value = "/etc/caddy/Caddyfile")]
        output: String,
    },
    /// Tell Caddy to reload the on-disk Caddyfile in place.
    ///
    /// v0.2.0+: replaces the `server reload` path that used to PUT
    /// the rendered sing-box config to sing-box's clash API. Now
    /// runs `caddy reload --config /etc/caddy/Caddyfile` inside
    /// the ct-caddy container via `docker exec`. Graceful — Caddy
    /// drains in-flight connections, swaps the new config in, and
    /// resumes serving with no dropped TLS handshakes.
    Reload {
        /// Override Caddyfile path (must match what the ct-caddy
        /// container reads — typically /etc/caddy/Caddyfile).
        #[arg(long, env = "CADDYFILE_PATH", default_value = "/etc/caddy/Caddyfile")]
        output: String,
    },
}

// NaiveOp removed in v0.4.0 — see singbox-core/ for the replacement.
//
// HaproxyOp deleted in v0.2.0 (HAProxy SNI router replaced by Caddy
// SNI routing). The `Cmd::Haproxy` dispatch arm + this enum landed
// together in v0.0.33; both retired in the architecture cut.
//
// ServerOp / TrafficOp / QuotaOp deleted in v0.4.0 — all three were
// thin clash-API wrappers; sing-box VLESS+Reality does not expose a
// clash API.

#[derive(Subcommand, Debug)]
enum ProbeOp {
    AntiTracking {
        #[arg(long)]
        via: Option<String>,
        #[arg(long, default_value = "https://ifconfig.co/json")]
        target: String,
    },
}

fn main() -> ExitCode {
    // tracing must write to stderr — several CLI subcommands
    // (`--json` render output, `probe anti-tracking`, `singbox
    // render`) emit machine-readable JSON on stdout that is parsed
    // by the panel and the stress harness. Default fmt() writes to
    // stdout, which would interleave INFO/WARN lines with the JSON
    // and break every downstream parser.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .compact()
        .try_init();

    let cli = Cli::parse();
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("failed to start tokio runtime: {e}");
            return ExitCode::from(2);
        }
    };

    let result = rt.block_on(async move { dispatch(cli).await });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            let chain = format_error_chain(&e);
            if !chain.is_empty() {
                eprint!("{chain}");
            }
            ExitCode::from(1)
        }
    }
}

/// Walk the `source()` chain on a top-level error and format each
/// underlying cause as an indented "caused by ({depth}): ..." line
/// with a trailing newline. Pure function so it can be unit-tested
/// without capturing stderr.
///
/// Walking the chain surfaces the originating type and message so
/// the panel-side log + the operator's `docker compose logs` both
/// carry actionable context.
fn format_error_chain(e: &crate::Error) -> String {
    use std::error::Error as _;
    let mut out = String::new();
    let mut current: Option<&(dyn std::error::Error)> = e.source();
    let mut depth = 1;
    while let Some(err) = current {
        out.push_str(&format!("       caused by ({depth}): {err}\n"));
        current = err.source();
        depth += 1;
        if depth > 16 {
            // Defensive: bound the walk so a pathological cyclic
            // source chain (shouldn't be possible with our
            // explicit From impls, but defence-in-depth) can't
            // spin forever on the user's terminal.
            out.push_str(&format!("       (chain truncated at {depth} levels)\n"));
            break;
        }
    }
    out
}

/// Resolve the panel subdomain. Cycle 3 / v0.0.55 made
/// [`util::domain::panel_domain`] the canonical source; this
/// wrapper preserves the CLI-flag override path
/// (`--panel-domain` accepts an ad-hoc per-invocation value used
/// by some debug paths). The DB-fallback the pre-Cycle-3 version
/// did has been retired — env is the single source of truth, and
/// the panel renderer is no longer responsible for reconciling
/// post-install ServerConfig.domain edits with the panel hostname
/// (operators who change ServerConfig.domain via the UI now have
/// to also rotate their `.env`'s `PANEL_DOMAIN`; the v0.0.54
/// auto-heal in update.sh + the Filament UI making both fields
/// editable side-by-side cover this discipline).
fn resolve_panel_domain(cli_value: &str) -> Result<String> {
    if !cli_value.trim().is_empty() {
        return Ok(cli_value.trim().to_owned());
    }
    util::domain::panel_domain()
}

async fn dispatch(cli: Cli) -> Result<()> {
    match cli.cmd {
        // v0.4.0 — removed dispatch arms:
        //   Cmd::Singbox  → renderer is singbox-core (Bun TS) shelled
        //                  to from panel-side SingBoxConfigGenerator
        //   Cmd::Server   → clash admin API doesn't exist on sing-box
        //                  VLESS+Reality
        //   Cmd::Traffic  → per-user counters came from clash-API
        //   Cmd::Quota    → quota enforcement via clash-API reload
        //   Cmd::Guard    → credentials::assert_locked compared the
        //                  v0.3.x naive users shape; replaced by
        //                  operator/src/util/drift-check.ts
        // Cmd::Naive dispatch removed in v0.4.0 (rendering moved to
        // singbox-core/ Bun package). Cmd::Haproxy dispatch removed in
        // v0.2.0 (Caddy SNI-routes the panel reverse-proxy itself).
        Cmd::Caddyfile { op } => match op {
            CaddyfileOp::Render {
                dry_run,
                template,
                output,
            } => {
                let panel_domain = resolve_panel_domain(&cli.panel_domain)?;
                let pool = db::connect(&cli.database_url).await?;
                caddy::render(&pool, &panel_domain, &template, &output, dry_run, cli.json).await
            }
            CaddyfileOp::Reload { output } => caddy::reload(&output).await,
        },
        Cmd::Probe { op } => match op {
            ProbeOp::AntiTracking { via, target } => {
                probe::anti_tracking(&target, via.as_deref()).await
            }
        },
        Cmd::Daemon {
            socket,
            redis_url,
            metrics_bind,
        } => {
            // Build the shared pool ONCE here. Both the wire-handler
            // serve loop and the redis_bridge subscriber share it,
            // so neither path pays per-request connection setup.
            // sqlx's MySqlPool is internally Arc-wrapped — clones
            // bump a refcount, not a connection count.
            let pool = db::connect(&cli.database_url).await?;
            tracing::info!(
                max_connections = 4,
                "ct-server-core: shared DB pool ready (lifted from per-request)"
            );

            // T-1 semaphore lifted from `daemon::serve` to here
            // (v0.0.67) so the optional internal_metrics registry can
            // read `available_permits()` for the
            // `ct_daemon_handler_permits_used` gauge without a
            // duplicate construction site.
            let permits =
                std::sync::Arc::new(tokio::sync::Semaphore::new(daemon::MAX_CONCURRENT_HANDLERS));

            // Optional internal-metrics endpoint. Off by default;
            // operator opts in via --metrics-bind / CT_METRICS_BIND.
            // Per LTSC.md, operator-internal-health only — never
            // per-user data.
            let metrics_registry = if metrics_bind.trim().is_empty() {
                None
            } else {
                let r = internal_metrics::MetricsRegistry::new(
                    permits.clone(),
                    daemon::MAX_CONCURRENT_HANDLERS,
                    pool.clone(),
                );
                internal_metrics::spawn(metrics_bind.clone(), r.clone());
                Some(r)
            };

            // v0.0.88: the daemon prefers discrete REDIS_HOST/PORT/
            // PASSWORD/DATABASE env vars over REDIS_URL (the URL
            // form rejects passwords with `/+=` from
            // `openssl rand -base64`). Either path is sufficient
            // to start the subscriber; only if BOTH are missing
            // do we run without revocations.
            let has_discrete_redis = std::env::var("REDIS_HOST")
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if !redis_url.is_empty() || has_discrete_redis {
                redis_bridge::spawn(redis_url, metrics_registry.clone());
            } else {
                tracing::warn!(
                    "neither REDIS_HOST nor REDIS_URL set — running without revocation subscriber"
                );
            }
            daemon::serve(&socket, pool, permits, metrics_registry).await
        }
        Cmd::Component { op } => match op {
            ComponentOp::List { manifests } => {
                let list = components::list(&manifests).await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&list)?);
                } else {
                    for m in &list {
                        println!(
                            "{:<24}  kind={:<14}  version={}",
                            m.name,
                            format!("{:?}", m.kind).to_lowercase(),
                            m.version,
                        );
                    }
                }
                Ok(())
            }
            ComponentOp::Check { manifests } => {
                let pool = db::connect(&cli.database_url).await?;
                components::print_check(&manifests, &pool, cli.json).await
            }
        },
        Cmd::Admin { op } => match op {
            AdminOp::PanelDomain => {
                let pd = util::domain::panel_domain()?;
                println!("{pd}");
                Ok(())
            }
        },
        Cmd::Canary { op } => match op {
            CanaryOp::Probe => {
                let pool = db::connect(&cli.database_url).await?;
                canary::probe(&pool).await
            }
            CanaryOp::Status => {
                let pool = db::connect(&cli.database_url).await?;
                canary::status(&pool).await
            }
        },
        Cmd::Version => {
            println!(
                "{{\"name\":\"ct-server-core\",\"version\":\"{}\",\"protocol\":{}}}",
                env!("CARGO_PKG_VERSION"),
                ct_protocol::PROTOCOL_VERSION,
            );
            Ok(())
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod main_tests {
    use super::*;

    #[test]
    fn format_error_chain_walks_nested_source() {
        // The real value of the chain walk: surface the underlying
        // cause when an outer error wraps an inner one. Operator
        // sees `error: connection pool drained` plus a
        // "caused by (1): connection refused" line below.
        let e = crate::Error::Io {
            op: "connection pool drained",
            path: None,
            source: std::io::Error::other("connection refused"),
        };
        let chain = format_error_chain(&e);
        assert!(
            chain.contains("connection refused"),
            "inner io message must surface: got {chain:?}"
        );
        assert!(
            chain.starts_with("       caused by (1): connection refused"),
            "depth-1 label + indent: got {chain:?}"
        );
    }

    #[test]
    fn format_error_chain_is_empty_for_terminal_config_error() {
        let e = crate::Error::config("something broke");
        let chain = format_error_chain(&e);
        assert_eq!(
            chain, "",
            "source-less config errors print nothing in the chain"
        );
    }

    #[test]
    fn format_error_chain_walks_one_level_io_error() {
        let io = std::io::Error::other("file not found");
        let e: crate::Error = io.into();
        let chain = format_error_chain(&e);
        assert!(chain.contains("file not found"), "got {chain:?}");
    }
}
