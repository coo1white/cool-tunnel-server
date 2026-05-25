// SPDX-License-Identifier: AGPL-3.0-only
//! Caddyfile rendering.
//!
//! Caddy's role is ACME for the panel domain, layer4 SNI routing on
//! :443, and an inner :8443 HTTPS panel reverse-proxy. Proxy traffic
//! is forwarded untouched to ct-singbox, where Reality TLS terminates.
//! The Caddyfile has no per-account data; it is a function of
//! `ServerConfig` plus `PanelDomain`.
//!
//! Practical consequences:
//!   - `render()` no longer reads the `proxy_accounts` table.
//!   - `active_users` in the JSON outcome is fixed at 0 for
//!     compatibility with existing JSON consumers.
//!   - Caddy reloads are driven by the host-side operator, where
//!     Docker access belongs.

use crate::db;
use crate::template;
use crate::{Error, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::MySqlPool;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize)]
pub struct CaddyRenderOutcome {
    pub path: String,
    pub bytes: usize,
    pub hash: String,
    pub changed: bool,
    /// The Caddyfile carries no per-account data, so this stays 0.
    /// The field remains for compatibility with existing JSON consumers.
    pub active_users: usize,
}

pub async fn render(
    pool: &MySqlPool,
    panel_domain: &str,
    template_path: &str,
    output_path: &str,
    dry_run: bool,
    json_output: bool,
) -> Result<()> {
    let cfg = db::server_config(pool).await?;

    let template =
        fs::read_to_string(template_path)
            .await
            .map_err(|source| Error::TemplateRead {
                path: template_path.to_owned(),
                source,
            })?;

    // Validate every operator-controlled binding before substituting
    // it into the Caddyfile. Caddyfile grammar treats `{` `}` as
    // block delimiters, `"` as quoted-string opener, and `\n` as a
    // directive terminator — a hostile DOMAIN like
    //
    //   example.com\n}\nadmin localhost:2019\n{
    //
    // would otherwise break out of the `{{ .Domain }} { … }`
    // site block in caddy/Caddyfile.tpl and inject a fully-functional
    // Caddy admin endpoint onto the public surface. Refuse to render
    // rather than attempt to sanitise.
    template::caddyfile_validate("Domain", &cfg.domain)
        .map_err(|e| Error::validation("Caddyfile Domain", e))?;
    template::caddyfile_validate("PanelDomain", panel_domain)
        .map_err(|e| Error::validation("Caddyfile PanelDomain", e))?;
    template::caddyfile_validate("AcmeEmail", &cfg.acme_email)
        .map_err(|e| Error::validation("Caddyfile AcmeEmail", e))?;
    template::caddyfile_validate("AcmeDirectory", &cfg.acme_directory)
        .map_err(|e| Error::validation("Caddyfile AcmeDirectory", e))?;

    let bindings = template::Bindings::new()
        .set("Domain", &cfg.domain)
        .set("PanelDomain", panel_domain)
        .set("AcmeEmail", &cfg.acme_email)
        .set("AcmeDirectory", &cfg.acme_directory)
        .into_map();

    let body = template::render(&template, &bindings).map_err(|source| Error::TemplateRender {
        path: template_path.to_owned(),
        source,
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
                active_users: 0,
            })?
        );
    }
    Ok(())
}

async fn atomic_write(path: &str, body: &str) -> Result<()> {
    let path = Path::new(path);
    let dir = path.parent().ok_or_else(|| Error::MissingParent {
        path: path.display().to_string(),
    })?;
    fs::create_dir_all(dir)
        .await
        .map_err(|source| Error::AtomicWrite {
            path: path.display().to_string(),
            op: "create_parent_dir",
            source,
        })?;

    let tmp: PathBuf = dir.join(format!(".caddy.tmp.{}", hex::encode(rand_bytes(4))));
    {
        let mut f = fs::File::create(&tmp)
            .await
            .map_err(|source| Error::AtomicWrite {
                path: tmp.display().to_string(),
                op: "create_tmp",
                source,
            })?;
        f.write_all(body.as_bytes())
            .await
            .map_err(|source| Error::AtomicWrite {
                path: tmp.display().to_string(),
                op: "write_tmp",
                source,
            })?;
        f.sync_all().await.map_err(|source| Error::AtomicWrite {
            path: tmp.display().to_string(),
            op: "sync_tmp",
            source,
        })?;
    }
    fs::rename(&tmp, path)
        .await
        .map_err(|source| Error::AtomicWrite {
            path: path.display().to_string(),
            op: "rename",
            source,
        })?;
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
        // template.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap()
            .join("caddy/Caddyfile.tpl");
        let tpl = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(_) => return, // template not on disk in this sandbox
        };
        let bindings = template::Bindings::new()
            .set("Domain", &cfg().domain)
            .set("PanelDomain", "panel.proxy.example.com")
            .set("AcmeEmail", &cfg().acme_email)
            .set("AcmeDirectory", &cfg().acme_directory)
            .into_map();
        let body = template::render(&tpl, &bindings).unwrap();
        // Globals.
        assert!(body.contains("admin@example.com"));
        assert!(body.contains("acme_ca https://acme-v02.api.letsencrypt.org/directory"));
        // layer4 SNI router.
        assert!(body.contains("layer4 {"));
        // v0.4.0 SNI matcher: scopes the panel.<DOMAIN> subdomain to
        // the inner :8443 Caddy site; everything else (Reality
        // cover-site SNI like www.microsoft.com) falls through to
        // ct-singbox.
        assert!(body.contains("sni panel.proxy.example.com"));
        // caddy-l4's short-form proxy directive — `proxy <host>:<port>`.
        // v0.4.0: cover-site SNI → tcp/ct-singbox:443 (the sing-box
        // VLESS+Reality container); panel SNI → 127.0.0.1:8443
        // (the inner Caddy reverse-proxy site).
        assert!(body.contains("proxy ct-singbox:443"));
        assert!(body.contains("proxy 127.0.0.1:8443"));
        // Inner panel site block.
        assert!(body.contains("https://panel.proxy.example.com:8443"));
        assert!(body.contains("reverse_proxy admin-web:3000"));
        // No proxy-domain ACME cert: Reality handles the proxy path.
        assert!(!body.contains("https://proxy.example.com:8443"));
        // No v0.2.x forward_proxy / probe_resistance / basic_auth.
        assert!(!body.contains("forward_proxy"));
        assert!(!body.contains("probe_resistance"));
        assert!(!body.contains("basic_auth"));
        // No retired ct-naive routing either.
        assert!(!body.contains("ct-naive"));
    }

    // JSON consumers read `changed`, `hash`, and `active_users`.
    // active_users stays in the JSON for compatibility, but is always
    // 0 because Caddy has no per-account data.
    #[test]
    fn render_outcome_json_pins_consumer_visible_keys() {
        let out = CaddyRenderOutcome {
            path: "/etc/caddy/Caddyfile".into(),
            bytes: 512,
            hash: "deadbeef".repeat(8),
            changed: true,
            active_users: 0,
        };
        let s = serde_json::to_string(&out).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("changed").is_some(), "consumer reads `changed`: {s}");
        assert!(v.get("hash").is_some(), "consumer reads `hash`: {s}");
        assert!(
            v.get("active_users").is_some(),
            "consumer reads `active_users`: {s}"
        );
    }
}
