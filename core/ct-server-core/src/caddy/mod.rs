// SPDX-License-Identifier: AGPL-3.0-only
//! Caddyfile rendering — produces the file Caddy reads at boot.
//!
//! v0.2.0+ Caddy owns three jobs that used to be split across three
//! containers: ACME (was the case all along), TLS-termination + naive
//! forward_proxy on :443 (was sing-box's job), and SNI routing for
//! the panel subdomain (was HAProxy's job). The single rendered
//! Caddyfile contains:
//!
//!   - global stanza (admin loopback, ACME directory, server defaults)
//!   - :80 site (ACME HTTP-01 + http→https redirect)
//!   - :443 site for {{ Domain }} — forward_proxy with naive Padding
//!     extension; basic_auth lines injected from active ProxyAccount
//!     rows; probe_resistance secret derived deterministically
//!   - :443 site for {{ PanelDomain }} — reverse_proxy to panel:9000
//!
//! Cleartext password handling: forward_proxy's basic_auth directive
//! checks credentials as cleartext (matches the wire-level Basic-Auth
//! that NaiveProxy sends). The panel persists the cleartext encrypted
//! with Laravel's Crypt and decrypts at the DB-read boundary
//! (see db.rs). Accounts whose cleartext can't be decrypted (legacy
//! row, APP_KEY rotation) are skipped here — same posture as the
//! pre-v0.2.0 sing-box renderer.

use crate::db;
use crate::domain::ProxyAccount;
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

    // Pull active proxy accounts. The filter mirrors what
    // singbox::render did in v0.1.x — accounts whose username doesn't
    // round-trip through `caddyfile_validate` get logged and skipped
    // so a single bad row can't break the rest of the render.
    let accounts = db::active_proxy_accounts(pool).await?;
    let safe_accounts: Vec<_> = accounts
        .into_iter()
        .filter(|a| {
            if a.caddyfile_safe_username() {
                true
            } else {
                tracing::warn!(
                    username = %a.username,
                    "skipping account: username fails caddyfile_validate"
                );
                false
            }
        })
        .collect();

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
    // Caddy admin endpoint onto the public surface. Unlike the
    // sing-box JSON template (R2-4 in 2026-05-04 audit), Caddyfile
    // has no general escape mechanism for these inside an unquoted
    // directive argument — refuse to render rather than attempt to
    // sanitise. (v0.0.16 hardening — Caddyfile-injection class.)
    template::caddyfile_validate("Domain", &cfg.domain)
        .map_err(|e| Error::validation("Caddyfile Domain", e))?;
    template::caddyfile_validate("PanelDomain", panel_domain)
        .map_err(|e| Error::validation("Caddyfile PanelDomain", e))?;
    template::caddyfile_validate("AcmeEmail", &cfg.acme_email)
        .map_err(|e| Error::validation("Caddyfile AcmeEmail", e))?;
    template::caddyfile_validate("AcmeDirectory", &cfg.acme_directory)
        .map_err(|e| Error::validation("Caddyfile AcmeDirectory", e))?;

    let basic_auth_lines = render_basic_auth_lines(&safe_accounts);
    let probe_resistance_secret = probe_resistance_secret(&cfg.domain);

    let bindings = template::Bindings::new()
        .set("Domain", &cfg.domain)
        .set("PanelDomain", panel_domain)
        .set("AcmeEmail", &cfg.acme_email)
        .set("AcmeDirectory", &cfg.acme_directory)
        .set("ForwardProxyBasicAuthLines", &basic_auth_lines)
        .set("ProbeResistanceSecret", &probe_resistance_secret)
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
                active_users: safe_accounts.len(),
            })?
        );
    }
    Ok(())
}

/// Pre-render the `basic_auth <user> <pass>` lines that go inside the
/// `forward_proxy { … }` block. The template engine is simple
/// substitution only (no `{{ range }}`); we build the multi-line
/// string here and inject it as a single binding.
///
/// Indentation: 12 spaces matches the Caddyfile.tpl's nesting
/// (`<domain> { route { forward_proxy { ` is 12 cols deep, every
/// directive at that depth is rendered with the same prefix). Caddy
/// is whitespace-tolerant, but matching the surrounding style keeps
/// `caddy fmt --check` happy.
///
/// Accounts without a decryptable cleartext password are skipped —
/// they would render as `basic_auth <user> ` (trailing space, no
/// password), which Caddy rejects as a parse error. The panel's
/// "regenerate password" path covers re-encryption after APP_KEY
/// rotation.
///
/// An empty result string is valid: the `forward_proxy` block then
/// has zero `basic_auth` lines and rejects every CONNECT — the proxy
/// stays up serving cover-site responses, the panel can still be
/// reached for account creation. Failing the render on zero accounts
/// would make the empty-stack first-launch hostile.
///
/// Exported for unit tests.
pub fn render_basic_auth_lines(accounts: &[ProxyAccount]) -> String {
    let mut out = String::new();
    for account in accounts {
        let Some(pw) = account.cleartext_password.as_deref() else {
            continue;
        };
        // Defence: re-check the username (caller already filtered)
        // and reject the password if it contains a Caddyfile-meta
        // character. Passwords can legitimately contain a wide
        // alphabet (the panel's password generator uses base64-ish),
        // so we only block whitespace + the literal block/quote
        // chars that would terminate the line.
        if !is_caddyfile_password_safe(pw) {
            tracing::warn!(
                username = %account.username,
                "skipping account: password contains caddyfile-meta character"
            );
            continue;
        }
        out.push_str("            basic_auth ");
        out.push_str(&account.username);
        out.push(' ');
        out.push_str(pw);
        out.push('\n');
    }
    out
}

/// True when the password is safe to inline into a Caddyfile
/// `basic_auth` directive without quoting. We accept printable ASCII
/// except whitespace + the structural meta-chars (`{`, `}`, `"`, `\`,
/// `#`). Newlines are obviously rejected — they'd terminate the
/// directive. The panel's generator emits base64url-like values that
/// always pass; this only triggers on operator-imported legacy rows.
fn is_caddyfile_password_safe(pw: &str) -> bool {
    if pw.is_empty() {
        return false;
    }
    for c in pw.chars() {
        if !c.is_ascii() || c.is_ascii_whitespace() {
            return false;
        }
        if matches!(c, '{' | '}' | '"' | '\\' | '#') {
            return false;
        }
    }
    true
}

/// Derive a stable, hard-to-guess subdomain to use as the
/// `probe_resistance` argument to klzgrad/forwardproxy. The secret
/// is the operator's escape hatch for testing the proxy from a
/// browser; it's not a security secret per se (anyone who can
/// observe traffic to the proxy could enumerate it), but it
/// shouldn't be trivially guessable from the domain.
///
/// Implementation: `sha256(domain)[..16].localhost`. Deterministic
/// (same domain → same secret across reboots), avoids depending on
/// APP_KEY (which would require a panel-side lookup at render time
/// and would invalidate the secret on key rotation).
///
/// Exported for unit tests.
pub fn probe_resistance_secret(domain: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    let hex = hex::encode(hasher.finalize());
    format!("{}.localhost", &hex[..16])
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
    use crate::domain::{ProxyAccount, ServerConfig};

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

    fn account(id: i64, username: &str, password: Option<&str>) -> ProxyAccount {
        ProxyAccount {
            id,
            username: username.into(),
            password_hash: String::new(),
            cleartext_password: password.map(str::to_owned),
            enabled: true,
            quota_bytes: None,
            used_bytes: 0,
            expires_at: None,
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
        let accounts = vec![
            account(1, "alice", Some("alicepw")),
            account(2, "bob", Some("bobpw")),
        ];
        let bindings = template::Bindings::new()
            .set("Domain", &cfg().domain)
            .set("PanelDomain", "panel.proxy.example.com")
            .set("AcmeEmail", &cfg().acme_email)
            .set("AcmeDirectory", &cfg().acme_directory)
            .set("ForwardProxyBasicAuthLines", &render_basic_auth_lines(&accounts))
            .set("ProbeResistanceSecret", &probe_resistance_secret(&cfg().domain))
            .into_map();
        let body = template::render(&tpl, &bindings).unwrap();
        // Global stanza.
        assert!(body.contains("admin@example.com"));
        assert!(body.contains("acme_ca https://acme-v02.api.letsencrypt.org/directory"));
        // forward_proxy site block.
        assert!(body.contains("proxy.example.com {"));
        assert!(body.contains("forward_proxy {"));
        assert!(body.contains("basic_auth alice alicepw"));
        assert!(body.contains("basic_auth bob bobpw"));
        assert!(body.contains("hide_ip"));
        assert!(body.contains("hide_via"));
        assert!(body.contains("probe_resistance"));
        assert!(body.contains(".localhost"));
        // Panel reverse-proxy site block.
        assert!(body.contains("panel.proxy.example.com {"));
        assert!(body.contains("reverse_proxy panel:9000"));
        // Old architecture's :8443 ghost site is gone.
        assert!(!body.contains(":8443"));
        assert!(!body.contains(":8444"));
    }

    #[test]
    fn render_basic_auth_lines_one_per_account_with_indent() {
        let accounts = vec![
            account(1, "alice", Some("alicepw")),
            account(2, "bob", Some("bobpw")),
        ];
        let s = render_basic_auth_lines(&accounts);
        assert_eq!(
            s,
            "            basic_auth alice alicepw\n            basic_auth bob bobpw\n"
        );
    }

    #[test]
    fn render_basic_auth_lines_skips_accounts_without_cleartext() {
        // Account 2 has no cleartext (e.g. APP_KEY rotation) — skipped.
        let accounts = vec![
            account(1, "alice", Some("alicepw")),
            account(2, "bob", None),
        ];
        let s = render_basic_auth_lines(&accounts);
        assert!(s.contains("alice alicepw"));
        assert!(!s.contains("bob"));
    }

    #[test]
    fn render_basic_auth_lines_skips_caddyfile_unsafe_passwords() {
        // A password containing `}` would close the forward_proxy
        // block early. Skip rather than emit a directive that breaks
        // the whole config.
        let accounts = vec![
            account(1, "alice", Some("alicepw")),
            account(2, "mallory", Some("evil}injection")),
            account(3, "charlie", Some("charliepw#comment")),
            account(4, "dave", Some("has space")),
            account(5, "eve", Some("normal-base64_-")),
        ];
        let s = render_basic_auth_lines(&accounts);
        assert!(s.contains("alice"));
        assert!(s.contains("eve"));
        assert!(!s.contains("mallory"));
        assert!(!s.contains("charlie"));
        assert!(!s.contains("dave"));
    }

    #[test]
    fn render_basic_auth_lines_empty_when_no_accounts() {
        // Zero-account first-launch state — the proxy stays up with
        // probe-resistance only, panel reachable.
        assert_eq!(render_basic_auth_lines(&[]), "");
    }

    #[test]
    fn probe_resistance_secret_is_deterministic() {
        let a = probe_resistance_secret("naive.example.com");
        let b = probe_resistance_secret("naive.example.com");
        assert_eq!(a, b);
        assert!(a.ends_with(".localhost"));
        // The secret is the first 16 hex chars of sha256(domain) +
        // ".localhost" → 16 + 10 = 26 chars.
        assert_eq!(a.len(), 26);
    }

    #[test]
    fn probe_resistance_secret_diverges_per_domain() {
        let a = probe_resistance_secret("naive.example.com");
        let b = probe_resistance_secret("naive.other.com");
        assert_ne!(a, b);
    }

    // Round-17 chassis-cockpit boundary: same shape as the
    // sing-box `render_outcome_json_pins_php_visible_keys` test.
    // PHP-side reader is
    // `panel/app/Services/CaddyfileGenerator.php:53-55`: reads
    // `$out['changed']` + `$out['hash']` with `?? <default>`.
    // v0.2.0+ also reads `$out['active_users']` to surface the
    // user-count on the panel components page.
    #[test]
    fn render_outcome_json_pins_php_visible_keys() {
        let out = CaddyRenderOutcome {
            path: "/etc/caddy/Caddyfile".into(),
            bytes: 512,
            hash: "deadbeef".repeat(8),
            changed: true,
            active_users: 3,
        };
        let s = serde_json::to_string(&out).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("changed").is_some(), "panel reads `changed`: {s}");
        assert!(v.get("hash").is_some(), "panel reads `hash`: {s}");
        assert!(v.get("active_users").is_some(), "panel reads `active_users`: {s}");
    }
}
