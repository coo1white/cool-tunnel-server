//! HAProxy SNI-router config rendering.
//!
//! HAProxy in this stack is a TCP/SSL-passthrough router on :443:
//! it sniffs the SNI from each TLS ClientHello and forwards raw
//! bytes to either Caddy (panel subdomain) or sing-box (proxy
//! domain). No TLS decryption happens at the router — each backend
//! terminates its own TLS, preserving the on-the-wire fingerprint
//! (anti-tracking probe-resistance).
//!
//! Why a separate render here (vs. just static-shipping a cfg):
//! the operator's `DOMAIN` lives in the panel's `ServerConfig` row
//! and `PANEL_DOMAIN` lives in the per-install `.env`. Either can
//! change between deployments and both must appear inside the
//! generated frontend's `use_backend` rule. So we render from the
//! same DB+env state as the Caddyfile + sing-box config, and the
//! same atomic-write pattern keeps a partial cfg from reaching
//! haproxy on the next reload.
//!
//! (R1-1 / R1-2 in 2026-05-04 audit; landed in v0.0.33.)

use crate::db;
use crate::template;
use crate::{Error, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize)]
pub struct HaproxyRenderOutcome {
    pub path: String,
    pub bytes: usize,
    pub hash: String,
    pub changed: bool,
}

pub async fn render(
    database_url: &Option<String>,
    panel_domain: &str,
    template_path: &str,
    output_path: &str,
    dry_run: bool,
    json_output: bool,
) -> Result<()> {
    let pool = db::connect(database_url).await?;
    let cfg = db::server_config(&pool).await?;

    let template = fs::read_to_string(template_path).await.map_err(|e| {
        Error::msg(format!(
            "could not read haproxy template at `{template_path}`: {e}. \
             Set --template / HAPROXY_CONFIG_TEMPLATE if it lives elsewhere."
        ))
    })?;

    // Both Domain and PanelDomain land verbatim inside an HAProxy
    // `use_backend ... if { req_ssl_sni -i <name> }` ACL test.
    // HAProxy's config grammar treats spaces, `\n`, `{`, `}`, and
    // `#` (line comment) as terminators / delimiters; a hostile
    // name like
    //
    //   panel.example.com\n  use_backend evil if always_true
    //
    // would otherwise inject a fully-functional rule. The hostname
    // constraints HAProxy needs are a strict subset of what
    // `caddyfile_validate` already enforces (alpha-num, dots,
    // hyphens — no whitespace, quoting, or brace), so we reuse it.
    template::caddyfile_validate("Domain", &cfg.domain).map_err(Error::msg)?;
    template::caddyfile_validate("PanelDomain", panel_domain).map_err(Error::msg)?;

    let bindings = template::Bindings::new()
        .set("Domain", &cfg.domain)
        .set("PanelDomain", panel_domain)
        .into_map();

    let body = template::render(&template, &bindings).map_err(|e| {
        Error::msg(format!(
            "could not render haproxy template `{template_path}`: {e}"
        ))
    })?;

    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    let hash = hex::encode(hasher.finalize());

    if dry_run {
        print!("{body}");
        return Ok(());
    }

    let changed = match fs::read(output_path).await {
        Ok(existing) => {
            let mut h = Sha256::new();
            h.update(&existing);
            hex::encode(h.finalize()) != hash
        }
        Err(_) => true,
    };

    if changed {
        atomic_write(output_path, &body).await?;
        tracing::info!(
            path = output_path, %hash, bytes = body.len(),
            "haproxy.cfg rendered"
        );
    } else {
        tracing::debug!(path = output_path, %hash, "haproxy.cfg unchanged");
    }

    if json_output {
        println!(
            "{}",
            serde_json::to_string(&HaproxyRenderOutcome {
                path: output_path.to_owned(),
                bytes: body.len(),
                hash,
                changed,
            })?
        );
    }
    Ok(())
}

async fn atomic_write(path: &str, body: &str) -> Result<()> {
    let path = Path::new(path);
    let dir = path
        .parent()
        .ok_or_else(|| Error::msg("haproxy output has no parent directory"))?;
    fs::create_dir_all(dir).await.ok();

    let tmp: PathBuf = dir.join(format!(".haproxy.tmp.{}", hex::encode(rand_bytes(4))));
    {
        let mut f = fs::File::create(&tmp).await?;
        f.write_all(body.as_bytes()).await?;
        f.sync_all().await?;
    }
    fs::rename(&tmp, path).await?;
    Ok(())
}

fn rand_bytes(n: usize) -> Vec<u8> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut hasher = Sha256::new();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.finalize()[..n].to_vec()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn render_pure_substitution() {
        // Skip when running outside the repo (sandboxed test runners).
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap()
            .join("haproxy/haproxy.cfg.tpl");
        let tpl = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(_) => return,
        };
        let bindings = template::Bindings::new()
            .set("Domain", "proxy.example.com")
            .set("PanelDomain", "panel.proxy.example.com")
            .into_map();
        let body = template::render(&tpl, &bindings).unwrap();
        assert!(body.contains("panel.proxy.example.com"));
        assert!(body.contains("sing-box:443"));
        assert!(body.contains("caddy:8444"));
        // The default backend MUST be the proxy (not the panel).
        // See haproxy.cfg.tpl rationale comment: routing default
        // to the panel would expose the Filament login to any
        // SNI-less probe.
        assert!(body.contains("default_backend naive_singbox"));
    }
}
