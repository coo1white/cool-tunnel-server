// Caddyfile rendering — the heart of what makes proxy account changes
// visible to Caddy.
//
// Reads template + DB; substitutes placeholders; writes atomically;
// returns the SHA-256 of the new file.
//
// Atomic write is mandatory: a partial Caddyfile would either fail
// `caddy validate` (best case) or load with missing basic_auth lines
// (worst case, a security regression). We write to a tmp file in the
// same directory, fsync it, then rename — a POSIX-atomic operation on
// the same filesystem.

use crate::{Result, Error};
use crate::db;
use crate::domain::{ProxyAccount, ServerConfig};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Serialize)]
pub struct RenderOutcome {
    pub path: String,
    pub bytes: usize,
    pub hash: String,
    pub changed: bool,
    pub active_accounts: usize,
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
    let accounts = db::active_proxy_accounts(&pool).await?;
    let safe_accounts: Vec<_> = accounts
        .into_iter()
        .filter(|a| {
            if a.caddyfile_safe_username() {
                true
            } else {
                tracing::warn!(username = %a.username, "skipping account: unsafe username");
                false
            }
        })
        .collect();

    let body = render_to_string(template_path, &cfg, &safe_accounts).await?;
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
        db::record_caddyfile_hash(&pool, &hash).await?;
        tracing::info!(path = output_path, %hash, bytes = body.len(), "caddyfile rendered");
    } else {
        tracing::debug!(path = output_path, %hash, "caddyfile unchanged");
    }

    if json_output {
        println!(
            "{}",
            serde_json::to_string(&RenderOutcome {
                path: output_path.to_owned(),
                bytes: body.len(),
                hash,
                changed,
                active_accounts: safe_accounts.len(),
            })?
        );
    }

    Ok(())
}

pub async fn validate(output_path: &str) -> Result<()> {
    // Use the local caddy binary if it's on PATH; else docker exec.
    // The panel container won't have caddy installed, so we route to
    // the caddy container.
    let mut cmd = Command::new("docker");
    cmd.args(["exec", "ct-caddy", "caddy", "validate", "--config", output_path]);
    let out = cmd.output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error(
            format!("caddy validate failed: {stderr}").into(),
        ));
    }
    println!("caddyfile valid");
    Ok(())
}

async fn render_to_string(
    template_path: &str,
    cfg: &ServerConfig,
    accounts: &[ProxyAccount],
) -> Result<String> {
    let template = fs::read_to_string(template_path).await?;

    let basic_auth = if accounts.is_empty() {
        // forward_proxy needs at least one basic_auth line, so we
        // emit a hash that nothing matches. Better than failing the
        // Caddyfile parse and leaving the previous (possibly stale)
        // active accounts in place.
        indent(
            "basic_auth __no_active_accounts__ \
             $2y$10$NotARealHashJustAPlaceholderXXXXXXXXXXXXXXXX",
            8,
        )
    } else {
        let lines: Vec<String> = accounts
            .iter()
            .map(|a| format!("basic_auth {} {}", a.username, a.password_hash))
            .collect();
        indent(&lines.join("\n"), 8)
    };

    let anti_tracking = {
        let mut lines = Vec::new();
        if cfg.hide_ip {
            lines.push("hide_ip");
        }
        if cfg.hide_via {
            lines.push("hide_via");
        }
        if cfg.probe_resistance {
            lines.push("probe_resistance");
        }
        indent(&lines.join("\n"), 8)
    };

    let admin_basic_auth = match (&cfg.admin_basic_auth_user, &cfg.admin_basic_auth_hash) {
        (Some(u), Some(h)) if !u.is_empty() && !h.is_empty() => {
            indent(&format!("basicauth {{\n    {u} {h}\n}}"), 8)
        }
        _ => String::new(),
    };

    let doh_block = if cfg.doh_resolver.is_empty() {
        String::new()
    } else {
        format!("    resolvers {}", cfg.doh_resolver)
    };

    let rendered = template
        .replace("{{DOMAIN}}", &cfg.domain)
        .replace("{{ACME_EMAIL}}", &cfg.acme_email)
        .replace("{{ACME_DIRECTORY}}", &cfg.acme_directory)
        .replace("{{ANTI_TRACKING_BLOCK}}", &anti_tracking)
        .replace("{{BASIC_AUTH_BLOCK}}", &basic_auth)
        .replace("{{ADMIN_BASIC_AUTH}}", &admin_basic_auth)
        .replace("{{DOH_RESOLVER_BLOCK}}", &doh_block);

    Ok(rendered)
}

async fn atomic_write(path: &str, body: &str) -> Result<()> {
    let path = Path::new(path);
    let dir = path.parent().ok_or_else(|| Error(
        "caddyfile output has no parent directory".into(),
    ))?;
    fs::create_dir_all(dir).await.ok();

    let tmp: PathBuf = dir.join(format!(
        ".caddyfile.tmp.{}",
        hex::encode(rand_bytes(4))
    ));

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
    // Tiny pseudo-randomness for tmp-file name uniqueness only — not
    // a security boundary. Hashes a high-resolution clock reading.
    let mut hasher = Sha256::new();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.finalize()[..n].to_vec()
}

fn indent(text: &str, spaces: usize) -> String {
    let pad = " ".repeat(spaces);
    text.lines()
        .map(|l| if l.is_empty() { l.to_owned() } else { format!("{pad}{l}") })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tempfile::tempdir;

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
            admin_basic_auth_user: None,
            admin_basic_auth_hash: None,
            last_caddyfile_hash: None,
            last_rendered_at: None,
        }
    }

    fn account(username: &str) -> ProxyAccount {
        ProxyAccount {
            id: 1,
            username: username.into(),
            password_hash: "$2y$10$abcdefghijklmnopqrstuv".into(),
            enabled: true,
            quota_bytes: None,
            used_bytes: 0,
            expires_at: Some(Utc::now() + chrono::Duration::days(30)),
        }
    }

    #[tokio::test]
    async fn render_substitutes_all_placeholders() {
        let dir = tempdir().unwrap_or_else(|_| panic!("tempdir"));
        let tpl = dir.path().join("Caddyfile.tpl");
        tokio::fs::write(
            &tpl,
            "DOMAIN={{DOMAIN}}\n\
             EMAIL={{ACME_EMAIL}}\n\
             DIR={{ACME_DIRECTORY}}\n\
             AT={{ANTI_TRACKING_BLOCK}}\n\
             BA={{BASIC_AUTH_BLOCK}}\n\
             ADMIN={{ADMIN_BASIC_AUTH}}\n\
             DOH={{DOH_RESOLVER_BLOCK}}\n",
        )
        .await
        .unwrap_or_default();

        let body = render_to_string(
            tpl.to_str().unwrap_or_default(),
            &cfg(),
            &[account("alice")],
        )
        .await
        .map_err(|_| ())
        .unwrap_or_default();

        assert!(body.contains("DOMAIN=proxy.example.com"));
        assert!(body.contains("basic_auth alice $2y$10$"));
        assert!(body.contains("hide_ip"));
        assert!(body.contains("hide_via"));
        assert!(body.contains("probe_resistance"));
    }

    #[tokio::test]
    async fn unsafe_username_is_rejected_at_domain_boundary() {
        let mut a = account("alice space");
        assert!(!a.caddyfile_safe_username());
        a.username = "alice".into();
        assert!(a.caddyfile_safe_username());
        a.username = "..".into();
        assert!(a.caddyfile_safe_username()); // dots are allowed
        a.username = "a\nb".into();
        assert!(!a.caddyfile_safe_username());
    }
}
