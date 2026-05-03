// sing-box config rendering — the heart of what makes proxy account
// changes visible to the running server.
//
// Reads template (sing-box/config.json.tpl) + DB; substitutes
// placeholders; serialises the JSON; writes atomically; returns the
// SHA-256 of the new file.
//
// Atomic write is mandatory: a partial config.json would either fail
// `sing-box check` (best case) or load with missing users (worst
// case — a security regression). We write to a tmp file in the same
// directory, fsync it, then rename — POSIX-atomic on the same
// filesystem.
//
// Cleartext password handling: sing-box's `naive` inbound checks the
// basic_auth password as cleartext (not bcrypt), so the panel
// persists the cleartext encrypted with Laravel's Crypt and decrypts
// at the DB-read boundary (see db.rs). The Rust core never sees the
// encrypted form.

use crate::db;
use crate::domain::{ProxyAccount, ServerConfig};
use crate::{Error, Result};
use serde::Serialize;
use serde_json::{json, Value};
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
    pub active_users: usize,
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
        tracing::info!(path = output_path, %hash, bytes = body.len(),
            users = safe_accounts.len(), "sing-box config rendered");
    } else {
        tracing::debug!(path = output_path, %hash, "sing-box config unchanged");
    }

    if json_output {
        println!(
            "{}",
            serde_json::to_string(&RenderOutcome {
                path: output_path.to_owned(),
                bytes: body.len(),
                hash,
                changed,
                active_users: safe_accounts.len(),
            })?
        );
    }

    Ok(())
}

/// Run `sing-box check` against the rendered file. Catches malformed
/// JSON / unknown fields / port conflicts before the reload attempt.
pub async fn validate(output_path: &str) -> Result<()> {
    let mut cmd = Command::new("docker");
    cmd.args(["exec", "ct-singbox", "sing-box", "check", "-c", output_path]);
    let out = cmd.output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::msg(format!("sing-box check failed: {stderr}")));
    }
    println!("sing-box config valid");
    Ok(())
}

async fn render_to_string(
    template_path: &str,
    cfg: &ServerConfig,
    accounts: &[ProxyAccount],
) -> Result<String> {
    let template = fs::read_to_string(template_path).await.map_err(|e| {
        Error::msg(format!(
            "could not read sing-box template at `{template_path}`: {e}. \
             Set --template / SINGBOX_CONFIG_TEMPLATE if it lives elsewhere."
        ))
    })?;

    // Build the users JSON. sing-box's `naive` inbound wants an array
    // of `{"username", "password"}` cleartext pairs. Accounts whose
    // cleartext we couldn't decrypt (encrypted with a different
    // APP_KEY, or pre-migration rows) are skipped here — the panel
    // forces a regen on first save after the migration so this is a
    // transient state.
    let users: Vec<Value> = accounts
        .iter()
        .filter_map(|a| {
            a.cleartext_password
                .as_deref()
                .map(|pw| json!({"username": a.username, "password": pw}))
        })
        .collect();

    let users_json = if users.is_empty() {
        // sing-box's naive inbound requires at least one user. Emit a
        // placeholder no real client will match.
        serde_json::to_string(&json!([{
            "username": "__no_active_accounts__",
            "password": "__placeholder_password_no_one_can_guess__"
        }]))?
    } else {
        serde_json::to_string(&Value::Array(users))?
    };

    let bindings = crate::template::Bindings::new()
        .set("Domain", &cfg.domain)
        .set("AcmeEmail", &cfg.acme_email)
        .set("AcmeDirectory", &cfg.acme_directory)
        .set("UsersJson", &users_json)
        .set("DohResolver", &cfg.doh_resolver)
        .set("ClashSecret", &clash_secret(cfg))
        .into_map();

    crate::template::render(&template, &bindings).map_err(|e| {
        Error::msg(format!(
            "could not render sing-box template `{template_path}`: {e}"
        ))
    })
}

/// Derive a clash-API secret from the ServerConfig. We don't want it
/// persisted in the DB (it's not a user-facing setting). Derive it
/// from the bcrypt admin_basic_auth_hash if available, or from the
/// ACME email as a fallback. Any deterministic input works — sing-box
/// treats this as an opaque token.
fn clash_secret(cfg: &ServerConfig) -> String {
    let mut h = Sha256::new();
    h.update(b"ct-clash-secret-v1:");
    if let Some(s) = cfg.admin_basic_auth_hash.as_deref() {
        h.update(s.as_bytes());
    } else {
        h.update(cfg.acme_email.as_bytes());
    }
    hex::encode(h.finalize())
}

async fn atomic_write(path: &str, body: &str) -> Result<()> {
    let path = Path::new(path);
    let dir = path
        .parent()
        .ok_or_else(|| Error::msg("sing-box output has no parent directory"))?;
    fs::create_dir_all(dir).await.ok();

    let tmp: PathBuf = dir.join(format!(".singbox.tmp.{}", hex::encode(rand_bytes(4))));
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

    fn account(username: &str, cleartext: &str) -> ProxyAccount {
        ProxyAccount {
            id: 1,
            username: username.into(),
            password_hash: "$2y$10$abcdefghijklmnopqrstuv".into(),
            cleartext_password: Some(cleartext.into()),
            enabled: true,
            quota_bytes: None,
            used_bytes: 0,
            expires_at: Some(Utc::now() + chrono::Duration::days(30)),
        }
    }

    #[tokio::test]
    async fn render_substitutes_placeholders_and_includes_users() {
        let dir = tempdir().unwrap();
        let tpl = dir.path().join("config.json.tpl");
        tokio::fs::write(
            &tpl,
            r#"{
                "domain": "{{ .Domain }}",
                "email": "{{ .AcmeEmail }}",
                "directory": "{{ .AcmeDirectory }}",
                "users": {{ .UsersJson }},
                "resolver": "{{ .DohResolver }}",
                "clash": "{{ .ClashSecret }}"
            }"#,
        )
        .await
        .unwrap();

        let body = render_to_string(
            tpl.to_str().unwrap(),
            &cfg(),
            &[account("alice", "alice-secret")],
        )
        .await
        .unwrap();

        assert!(body.contains(r#""domain": "proxy.example.com""#));
        assert!(body.contains(r#""username":"alice""#));
        assert!(body.contains(r#""password":"alice-secret""#));
        assert!(body.contains("https://1.1.1.1/dns-query"));
    }

    #[test]
    fn unsafe_username_is_rejected_at_domain_boundary() {
        let mut a = account("alice space", "x");
        assert!(!a.caddyfile_safe_username());
        a.username = "alice".into();
        assert!(a.caddyfile_safe_username());
    }

    #[tokio::test]
    async fn empty_user_set_emits_placeholder() {
        let dir = tempdir().unwrap();
        let tpl = dir.path().join("config.json.tpl");
        tokio::fs::write(&tpl, r#"{"users": {{ .UsersJson }}}"#)
            .await
            .unwrap();

        let body = render_to_string(tpl.to_str().unwrap(), &cfg(), &[])
            .await
            .unwrap();
        assert!(body.contains("__no_active_accounts__"));
    }
}
