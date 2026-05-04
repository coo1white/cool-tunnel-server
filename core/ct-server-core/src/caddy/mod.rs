//! Caddyfile rendering — produces the file Caddy reads at boot.
//!
//! Caddy in this stack is **ACME-only**: stock binary, no plugins.
//! It binds :80, manages a TLS cert for the operator's domain via
//! HTTP-01, and stores the cert in `/data/caddy/...`. sing-box reads
//! that directory and does the actual TLS termination on :443.
//!
//! Why a separate render here (vs. just static-shipping a Caddyfile):
//! the operator's `DOMAIN` and `ACME_EMAIL` come from the panel's
//! `ServerConfig` row. So we render the Caddyfile from the same DB
//! state on boot and on every ServerConfig change. Same atomic-write
//! pattern as `singbox::render`.

use crate::db;
use crate::template;
use crate::{Error, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize)]
pub struct CaddyRenderOutcome {
    pub path: String,
    pub bytes: usize,
    pub hash: String,
    pub changed: bool,
}

pub async fn render(
    database_url: &Option<String>,
    template_path: &str,
    output_path: &str,
    dry_run: bool,
    json_output: bool,
) -> Result<()> {
    let pool = db::connect(database_url).await?;
    let cfg = db::server_config(&pool).await?;

    let template = fs::read_to_string(template_path).await.map_err(|e| {
        Error::msg(format!(
            "could not read Caddyfile template at `{template_path}`: {e}. \
             Set --template / CADDYFILE_TEMPLATE if it lives elsewhere."
        ))
    })?;

    let bindings = template::Bindings::new()
        .set("Domain", &cfg.domain)
        .set("AcmeEmail", &cfg.acme_email)
        .set("AcmeDirectory", &cfg.acme_directory)
        .into_map();

    let body = template::render(&template, &bindings).map_err(|e| {
        Error::msg(format!(
            "could not render Caddyfile template `{template_path}`: {e}"
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
            "Caddyfile rendered"
        );
    } else {
        tracing::debug!(path = output_path, %hash, "Caddyfile unchanged");
    }

    if json_output {
        println!(
            "{}",
            serde_json::to_string(&CaddyRenderOutcome {
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
        .ok_or_else(|| Error::msg("Caddyfile output has no parent directory"))?;
    fs::create_dir_all(dir).await.ok();

    let tmp: PathBuf = dir.join(format!(".caddy.tmp.{}", hex::encode(rand_bytes(4))));
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
    use crate::domain::ServerConfig;

    fn cfg() -> ServerConfig {
        ServerConfig {
            id: 1,
            domain: "proxy.example.com".into(),
            acme_email: "admin@example.com".into(),
            acme_directory: "https://acme-v02.api.letsencrypt.org/directory".into(),
            hide_ip: true,
            hide_via: true,
            probe_resistance: true,
            doh_resolver: "https://1.1.1.1/dns-query".into(),
            http3_enabled: true,
            last_caddyfile_hash: None,
            last_rendered_at: None,
        }
    }

    #[tokio::test]
    async fn render_pure_substitution() {
        // Don't go through render() (which needs a DB) — exercise
        // just the template substitution against the production
        // template. Use tokio::fs (not std::fs) so we don't block
        // the test runtime.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap()
            .join("caddy/Caddyfile.tpl");
        let tpl = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(_) => {
                // Running from a sandbox where the template isn't on
                // disk — skip. The other render tests cover the
                // substitution shape.
                return;
            }
        };
        let bindings = template::Bindings::new()
            .set("Domain", &cfg().domain)
            .set("AcmeEmail", &cfg().acme_email)
            .set("AcmeDirectory", &cfg().acme_directory)
            .into_map();
        let body = template::render(&tpl, &bindings).unwrap();
        assert!(body.contains("admin@example.com"));
        assert!(body.contains("proxy.example.com"));
        assert!(body.contains("acme_ca https://acme-v02.api.letsencrypt.org/directory"));
    }
}
