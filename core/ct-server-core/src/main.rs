// ct-server-core — CLI entry point.
//
// Subcommand dispatch only. Each subcommand lives in its own module so
// the heavy lifting (DB queries, admin API calls, parsing) is testable
// in isolation.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod admin;
mod caddyfile;
mod components;
mod daemon;
mod db;
mod domain;
mod err;
mod metrics;
mod probe;
mod quota;
mod subscription;

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

    /// Caddyfile template path.
    #[arg(long, env = "CADDYFILE_TEMPLATE",
          default_value = "/srv/caddy/Caddyfile.tpl", global = true)]
    template: String,

    /// Caddyfile output path.
    #[arg(long, env = "CADDYFILE_PATH",
          default_value = "/etc/caddy/Caddyfile", global = true)]
    output: String,

    /// Caddy admin unix socket.
    #[arg(long, env = "CADDY_ADMIN_SOCKET",
          default_value = "/run/caddy/admin.sock", global = true)]
    admin_socket: String,

    /// Print machine-readable JSON instead of human-readable lines.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Caddyfile generation + validation.
    Caddyfile {
        #[command(subcommand)]
        op: CaddyfileOp,
    },
    /// Talk to Caddy's admin API.
    Caddy {
        #[command(subcommand)]
        op: CaddyOp,
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
    /// Long-running JSON-over-unix-socket daemon.
    Daemon {
        #[arg(long, env = "CT_CORE_SOCKET",
              default_value = "/run/cool-tunnel/core.sock")]
        socket: String,
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
enum CaddyfileOp {
    /// Render template → /etc/caddy/Caddyfile (atomic).
    Render {
        #[arg(long)]
        dry_run: bool,
    },
    /// Run `caddy validate` on the rendered file.
    Validate,
}

#[derive(Subcommand, Debug)]
enum CaddyOp {
    /// Hot-reload via admin API.
    Reload,
    /// GET /config from the admin API and print.
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
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
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

async fn dispatch(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::Caddyfile { op } => match op {
            CaddyfileOp::Render { dry_run } => {
                caddyfile::render(&cli.database_url, &cli.template, &cli.output, dry_run, cli.json)
                    .await
            }
            CaddyfileOp::Validate => caddyfile::validate(&cli.output).await,
        },
        Cmd::Caddy { op } => match op {
            CaddyOp::Reload => admin::reload(&cli.admin_socket, &cli.output).await,
            CaddyOp::Config => admin::dump_config(&cli.admin_socket).await,
        },
        Cmd::Traffic { op } => match op {
            TrafficOp::Collect => metrics::collect(&cli.database_url, &cli.admin_socket).await,
        },
        Cmd::Quota { op } => match op {
            QuotaOp::Enforce => {
                quota::enforce(&cli.database_url, &cli.template, &cli.output, &cli.admin_socket)
                    .await
            }
        },
        Cmd::Probe { op } => match op {
            ProbeOp::AntiTracking { via, target } => {
                probe::anti_tracking(&target, via.as_deref()).await
            }
        },
        Cmd::Daemon { socket } => {
            daemon::serve(
                &socket,
                &cli.database_url,
                &cli.template,
                &cli.output,
                &cli.admin_socket,
            )
            .await
        }
        Cmd::Subscription { account_id } => {
            subscription::emit(&cli.database_url, account_id).await
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
            ComponentOp::Check { manifests } => components::print_check(&manifests, cli.json).await,
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
