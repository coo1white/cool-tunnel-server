// ct-server-core — CLI entry point.
//
// Subcommand dispatch only. Each subcommand lives in its own module so
// the heavy lifting (DB queries, admin API calls, parsing) is testable
// in isolation.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod admin;
mod caddy;
mod components;
mod daemon;
mod db;
mod domain;
mod err;
mod haproxy;
mod laravel_crypt;
mod metrics;
mod probe;
mod quota;
mod redis_bridge;
mod singbox;
mod subscription;
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

    /// sing-box config template path.
    #[arg(
        long,
        env = "SINGBOX_CONFIG_TEMPLATE",
        default_value = "/srv/sing-box/config.json.tpl",
        global = true
    )]
    template: String,

    /// sing-box config output path.
    #[arg(
        long,
        env = "SINGBOX_CONFIG_PATH",
        default_value = "/etc/sing-box/config.json",
        global = true
    )]
    output: String,

    /// sing-box clash-API base URL. Default targets the
    /// docker-internal `ct-singbox:9090` listener bound by
    /// `experimental.clash_api.external_controller`. The compose
    /// `ports:` map MUST NOT publish 9090 (audit-enforced) — this
    /// is a TCP listener intended for `ct-net` peers only.
    #[arg(
        long,
        env = "SINGBOX_CLASH_URL",
        default_value = "http://ct-singbox:9090",
        global = true
    )]
    admin_url: String,

    /// Optional override for the clash-API bearer token. Empty
    /// (default) → derive deterministically from ServerConfig at
    /// each call site, matching what `singbox::render` baked into
    /// `experimental.clash_api.secret`. Set this only for
    /// host-side dev where the panel's ServerConfig isn't reachable.
    #[arg(long, env = "SINGBOX_CLASH_SECRET", default_value = "", global = true)]
    admin_secret: String,

    /// Panel subdomain. Used by the Caddyfile and haproxy.cfg
    /// renderers to (a) attach Caddy auto-HTTPS for the panel cert
    /// and (b) point the haproxy SNI rule at it. Defaults to
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
    /// sing-box config generation + validation.
    Singbox {
        #[command(subcommand)]
        op: SingboxOp,
    },
    /// Caddyfile generation (ACME-only Caddy — see docs/architecture.md).
    Caddyfile {
        #[command(subcommand)]
        op: CaddyfileOp,
    },
    /// HAProxy SNI-router config generation (R1-1 / R1-2, v0.0.33).
    Haproxy {
        #[command(subcommand)]
        op: HaproxyOp,
    },
    /// Talk to sing-box's clash API.
    Server {
        #[command(subcommand)]
        op: ServerOp,
    },
    /// Pull metrics + roll into traffic_logs.
    Traffic {
        #[command(subcommand)]
        op: TrafficOp,
    },
    /// Enforce per-account quotas + expiry.
    Quota {
        #[command(subcommand)]
        op: QuotaOp,
    },
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
    },
    /// Emit a SubscriptionManifestV1 to stdout for `account_id`.
    Subscription {
        #[arg(long)]
        account_id: i64,
    },
    /// Component-as-machine-part: list / check installed components.
    Component {
        #[command(subcommand)]
        op: ComponentOp,
    },
    /// Print the build manifest.
    Version,
}

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

#[derive(Subcommand, Debug)]
enum SingboxOp {
    /// Render template → /etc/sing-box/config.json (atomic).
    Render {
        #[arg(long)]
        dry_run: bool,
    },
    /// Run `sing-box check` on the rendered file.
    Validate,
}

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
}

#[derive(Subcommand, Debug)]
enum HaproxyOp {
    /// Render template → /usr/local/etc/haproxy/haproxy.cfg (atomic).
    Render {
        #[arg(long)]
        dry_run: bool,
        /// Override template path.
        #[arg(
            long,
            env = "HAPROXY_CONFIG_TEMPLATE",
            default_value = "/srv/haproxy/haproxy.cfg.tpl"
        )]
        template: String,
        /// Override output path.
        #[arg(
            long,
            env = "HAPROXY_CONFIG_PATH",
            default_value = "/usr/local/etc/haproxy/haproxy.cfg"
        )]
        output: String,
    },
}

#[derive(Subcommand, Debug)]
enum ServerOp {
    /// Hot-reload via the clash API.
    Reload,
    /// GET /configs from the clash API and print.
    Config,
}

#[derive(Subcommand, Debug)]
enum TrafficOp {
    Collect,
}

#[derive(Subcommand, Debug)]
enum QuotaOp {
    Enforce,
}

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
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
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
            ExitCode::from(1)
        }
    }
}

/// Resolve the panel subdomain. Prefers the explicit CLI / env value
/// (`--panel-domain` / `PANEL_DOMAIN`) — operator-set in `.env` per
/// the v0.0.33 install path. Falls back to `panel.${DOMAIN}` derived
/// from the `server_configs` row, so an older deployment that hasn't
/// rotated its `.env` to add `PANEL_DOMAIN` still gets a usable
/// default at render time. Returns an error if neither is set
/// (should not happen post-install, but the operator-friendly
/// message is better than a silent fall-through).
async fn resolve_panel_domain(cli_value: &str, database_url: &Option<String>) -> Result<String> {
    if !cli_value.is_empty() {
        return Ok(cli_value.to_owned());
    }
    let pool = db::connect(database_url).await?;
    let cfg = db::server_config(&pool).await?;
    if cfg.domain.is_empty() {
        return Err(Error::msg(
            "PANEL_DOMAIN not set and ServerConfig.domain is empty — cannot derive default",
        ));
    }
    Ok(format!("panel.{}", cfg.domain))
}

async fn dispatch(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::Singbox { op } => match op {
            SingboxOp::Render { dry_run } => {
                singbox::render(
                    &cli.database_url,
                    &cli.template,
                    &cli.output,
                    dry_run,
                    cli.json,
                )
                .await
            }
            SingboxOp::Validate => singbox::validate(&cli.output).await,
        },
        Cmd::Caddyfile { op } => match op {
            CaddyfileOp::Render {
                dry_run,
                template,
                output,
            } => {
                let panel_domain =
                    resolve_panel_domain(&cli.panel_domain, &cli.database_url).await?;
                caddy::render(
                    &cli.database_url,
                    &panel_domain,
                    &template,
                    &output,
                    dry_run,
                    cli.json,
                )
                .await
            }
        },
        Cmd::Haproxy { op } => match op {
            HaproxyOp::Render {
                dry_run,
                template,
                output,
            } => {
                let panel_domain =
                    resolve_panel_domain(&cli.panel_domain, &cli.database_url).await?;
                haproxy::render(
                    &cli.database_url,
                    &panel_domain,
                    &template,
                    &output,
                    dry_run,
                    cli.json,
                )
                .await
            }
        },
        Cmd::Server { op } => {
            // CLI Server.{Reload,Config} are operator-facing — they
            // have no DB pool to derive the secret from on their
            // own. If --admin-secret / SINGBOX_CLASH_SECRET is empty
            // we load ServerConfig once and use the deterministic
            // value; an explicit override wins for ad-hoc debugging.
            let secret = if cli.admin_secret.is_empty() {
                singbox::current_clash_secret(&cli.database_url).await?
            } else {
                cli.admin_secret.clone()
            };
            let admin_client = admin::ClashAdmin::new(&cli.admin_url, &secret);
            match op {
                ServerOp::Reload => admin_client.reload(&cli.output).await,
                ServerOp::Config => admin_client.dump_config().await,
            }
        }
        Cmd::Traffic { op } => match op {
            TrafficOp::Collect => {
                let secret = if cli.admin_secret.is_empty() {
                    singbox::current_clash_secret(&cli.database_url).await?
                } else {
                    cli.admin_secret.clone()
                };
                metrics::collect(
                    &cli.database_url,
                    &admin::ClashAdmin::new(&cli.admin_url, &secret),
                )
                .await
            }
        },
        Cmd::Quota { op } => match op {
            QuotaOp::Enforce => {
                quota::enforce(
                    &cli.database_url,
                    &cli.template,
                    &cli.output,
                    &cli.admin_url,
                )
                .await
            }
        },
        Cmd::Probe { op } => match op {
            ProbeOp::AntiTracking { via, target } => {
                probe::anti_tracking(&target, via.as_deref()).await
            }
        },
        Cmd::Daemon { socket, redis_url } => {
            if !redis_url.is_empty() {
                redis_bridge::spawn(
                    redis_url,
                    cli.database_url.clone(),
                    cli.template.clone(),
                    cli.output.clone(),
                    cli.admin_url.clone(),
                );
            } else {
                tracing::warn!("REDIS_URL empty — running without revocation subscriber");
            }
            daemon::serve(
                &socket,
                &cli.database_url,
                &cli.template,
                &cli.output,
                &cli.admin_url,
            )
            .await
        }
        Cmd::Subscription { account_id } => subscription::emit(&cli.database_url, account_id).await,
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
                components::print_check(&manifests, &cli.database_url, cli.json).await
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
