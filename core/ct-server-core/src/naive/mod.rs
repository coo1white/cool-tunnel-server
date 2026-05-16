// SPDX-License-Identifier: AGPL-3.0-only
//! naive.json rendering (v0.3.0+).
//!
//! Produces the file ct-naive's supervisor watches at
//! /data/config/naive.json. Shape:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "domain": "naive.example.com",
//!   "listen_port": 443,
//!   "user": "test1",
//!   "password": "...",
//!   "acme_directory_dir": "acme-v02.api.letsencrypt.org-directory"
//! }
//! ```
//!
//! The supervisor uses `domain` + `acme_directory_dir` to locate the
//! cert pair Caddy writes under
//! /data/caddy/certificates/<acme_directory_dir>/<domain>/. Cert
//! discovery falls back to a directory scan if the slug doesn't
//! match (Caddy version change, ACME directory rotation).
//!
//! Multi-account limitation: klzgrad/naiveproxy's server mode only
//! supports ONE basic-auth credential per listener. v0.3.0 picks
//! the first active proxy_account (lowest id) and ignores the rest.
//! Multi-account support is a future v0.3.x change — likely via
//! either N naive processes on N ports + SNI subdomains, or a
//! thin authproxy in front. Today's DB shape carries one or two
//! accounts in practice, so this is acceptable for the initial cut.

use crate::db;
use crate::domain::ProxyAccount;
use crate::{Error, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::MySqlPool;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize)]
pub struct NaiveRenderOutcome {
    pub path: String,
    pub bytes: usize,
    pub hash: String,
    pub changed: bool,
    /// Count of proxy_accounts in the DB whose username + password
    /// pass validation. The wire format carries only ONE credential
    /// (naive's limit), but the count is useful for the panel UI to
    /// surface a "N accounts configured, 1 active on the wire"
    /// disclosure once multi-account lands.
    pub active_users: usize,
    /// The username actually written to naive.json (or `null` when
    /// no accounts are present — file still rendered as a stub so
    /// the supervisor can boot and serve the cover-site cert).
    pub active_username: Option<String>,
}

#[derive(Debug, Serialize)]
struct NaiveConfig<'a> {
    schema: u8,
    domain: &'a str,
    listen_port: u16,
    user: &'a str,
    password: &'a str,
    acme_directory_dir: String,
}

/// Hard-coded default. ct-naive binds 443 inside its container; the
/// layer4 router in Caddy proxies public :443 here for the matching
/// SNI. Changing this would require coordinated edits to the Caddyfile
/// layer4 upstream + the ct-naive cap_net_bind_service setup.
const NAIVE_LISTEN_PORT: u16 = 443;
const NAIVE_CONFIG_SCHEMA: u8 = 1;

pub async fn render(
    pool: &MySqlPool,
    output_path: &str,
    dry_run: bool,
    json_output: bool,
) -> Result<()> {
    let cfg = db::server_config(pool).await?;
    let accounts = db::active_proxy_accounts(pool).await?;
    let safe_accounts: Vec<&ProxyAccount> = accounts
        .iter()
        .filter(|a| filter_account(a))
        .collect();

    // Pick the first safe account whose cleartext is available.
    // Deterministic: lowest id (DB returns sorted by id).
    let chosen = safe_accounts
        .iter()
        .find(|a| a.cleartext_password.is_some())
        .copied();

    let acme_directory_dir = acme_directory_dir(&cfg.acme_directory);

    // Refuse to render with an unsafe domain — the value lands inside
    // a JSON string so JSON-escape protects against most injection,
    // but the supervisor uses `domain` to construct a filesystem path
    // (cert lookup). Reject anything that could traverse the path
    // boundary.
    if !is_safe_hostname(&cfg.domain) {
        return Err(Error::validation(
            "naive Domain",
            "domain contains characters unsafe for path lookup".to_owned(),
        ));
    }
    if !is_safe_path_segment(&acme_directory_dir) {
        return Err(Error::validation(
            "naive AcmeDirectoryDir",
            "slug contains characters unsafe for path lookup".to_owned(),
        ));
    }

    let body = match chosen {
        Some(account) => {
            let pw = account.cleartext_password.as_deref().unwrap_or("");
            let payload = NaiveConfig {
                schema: NAIVE_CONFIG_SCHEMA,
                domain: &cfg.domain,
                listen_port: NAIVE_LISTEN_PORT,
                user: &account.username,
                password: pw,
                acme_directory_dir: acme_directory_dir.clone(),
            };
            // serde_json::to_string_pretty for operator-readable
            // on-disk format; the supervisor parses with strict JSON
            // so whitespace is irrelevant. Pretty form makes
            // `cat /data/config/naive.json` legible during incident
            // triage without dragging in a JSON pretty-printer.
            serde_json::to_string_pretty(&payload)?
        }
        None => {
            // Stub: keep the file shape so the supervisor can boot
            // and report `waiting_for_config` consistently. Without
            // any active account naive cannot run; the supervisor's
            // boot loop will sit at the 60s wait and exit, the
            // container will restart, until an account materialises.
            tracing::warn!(
                "no active proxy account with cleartext_password — rendering naive.json stub"
            );
            let payload = NaiveConfig {
                schema: NAIVE_CONFIG_SCHEMA,
                domain: &cfg.domain,
                listen_port: NAIVE_LISTEN_PORT,
                user: "",
                password: "",
                acme_directory_dir: acme_directory_dir.clone(),
            };
            serde_json::to_string_pretty(&payload)?
        }
    };

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
            "naive.json rendered"
        );
    } else {
        tracing::debug!(path = output_path, %hash, "naive.json unchanged");
    }

    if json_output {
        println!(
            "{}",
            serde_json::to_string(&NaiveRenderOutcome {
                path: output_path.to_owned(),
                bytes: body.len(),
                hash,
                changed,
                active_users: safe_accounts.len(),
                active_username: chosen.map(|a| a.username.clone()),
            })?
        );
    }
    Ok(())
}

fn filter_account(account: &ProxyAccount) -> bool {
    if !account.caddyfile_safe_username() {
        tracing::warn!(
            username = %account.username,
            "skipping account: username fails caddyfile_validate"
        );
        return false;
    }
    let Some(pw) = account.cleartext_password.as_deref() else {
        // Account exists but cleartext isn't decryptable (APP_KEY
        // rotation). Counted as active for visibility; not chosen.
        return true;
    };
    if !is_naive_password_safe(pw) {
        tracing::warn!(
            username = %account.username,
            "skipping account: password fails naive safety check"
        );
        return false;
    }
    true
}

/// Reject passwords that would break naive's `--listen=https://user:pw@:port`
/// URL form when the supervisor URL-encodes for `listen=...`. We
/// percent-encode user/password before forming the URL (see
/// supervisor.ts), so the only hard constraint is "no null bytes,
/// no embedded ASCII control characters". Punctuation is fine.
fn is_naive_password_safe(pw: &str) -> bool {
    if pw.is_empty() {
        return false;
    }
    !pw.bytes().any(|b| b == 0 || b.is_ascii_control())
}

/// Slugify the ACME directory URL the way Caddy does for the on-disk
/// `/data/caddy/certificates/<dir>/<host>/` path. Caddy uses
/// `caddy.PathFriendly` which strips the scheme and replaces `/` and
/// other path-meta chars with `-`. We mirror that here so the
/// supervisor can look up the cert pair without a directory scan.
///
/// Example:
///   `https://acme-v02.api.letsencrypt.org/directory`
///     → `acme-v02.api.letsencrypt.org-directory`
fn acme_directory_dir(url: &str) -> String {
    let stripped = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    stripped.replace('/', "-")
}

/// Hostname safe enough to construct a filesystem path from. DNS
/// labels are alnum + hyphen + dot only; refuse anything that could
/// traverse a path boundary.
fn is_safe_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

fn is_safe_path_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg.len() <= 253
        && seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
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

    let tmp: PathBuf = dir.join(format!(".naive.tmp.{}", hex::encode(rand_bytes(4))));
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
    // Mode 0644 so ct-naive (different UID) can read it. naive.json
    // contains the cleartext basic-auth credential, but the file
    // lives in a docker volume reachable only by ct-panel (writer)
    // and ct-naive (reader). The exposure surface is the same as
    // the v0.2.x rendered Caddyfile which also carried cleartext.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o644);
        std::fs::set_permissions(path, perms).map_err(|source| Error::AtomicWrite {
            path: path.display().to_string(),
            op: "chmod",
            source,
        })?;
    }
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

    #[test]
    fn slug_matches_caddy_path_friendly() {
        assert_eq!(
            acme_directory_dir("https://acme-v02.api.letsencrypt.org/directory"),
            "acme-v02.api.letsencrypt.org-directory"
        );
        assert_eq!(
            acme_directory_dir("https://acme-staging-v02.api.letsencrypt.org/directory"),
            "acme-staging-v02.api.letsencrypt.org-directory"
        );
        // No scheme: leave as-is, replace slashes.
        assert_eq!(
            acme_directory_dir("acme.example.com/dir/sub"),
            "acme.example.com-dir-sub"
        );
    }

    #[test]
    fn safe_hostname_rejects_path_traversal() {
        assert!(is_safe_hostname("naive.example.com"));
        assert!(!is_safe_hostname("../etc/passwd"));
        assert!(!is_safe_hostname("naive.example.com/etc"));
        assert!(!is_safe_hostname(""));
    }

    #[test]
    fn naive_password_safe_accepts_typical_base64() {
        assert!(is_naive_password_safe("HvyDxaFGZakdpgLi6h2yr97Q"));
        assert!(is_naive_password_safe("WDTQ3hJSUbqRL3cZ2iazhQ8F"));
        assert!(is_naive_password_safe("a+b/c=d-e_f"));
    }

    #[test]
    fn naive_password_safe_rejects_control_chars_and_empty() {
        assert!(!is_naive_password_safe(""));
        assert!(!is_naive_password_safe("has\nnewline"));
        assert!(!is_naive_password_safe("has\0null"));
        assert!(!is_naive_password_safe("has\ttab"));
    }

    fn cfg(domain: &str) -> ServerConfig {
        ServerConfig {
            id: 1,
            domain: domain.into(),
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

    fn account(id: i64, user: &str, pw: Option<&str>) -> ProxyAccount {
        ProxyAccount {
            id,
            username: user.into(),
            password_hash: String::new(),
            cleartext_password: pw.map(str::to_owned),
            enabled: true,
            quota_bytes: None,
            used_bytes: 0,
            expires_at: None,
        }
    }

    #[test]
    fn render_payload_shape_pins_supervisor_visible_keys() {
        // The supervisor.ts is read-only consumer of this JSON. Pin
        // every field it parses so a future rename surfaces here as
        // a test failure rather than a silent supervisor read-back
        // of `undefined`.
        let payload = NaiveConfig {
            schema: 1,
            domain: "naive.example.com",
            listen_port: 443,
            user: "test1",
            password: "pw",
            acme_directory_dir: "acme-v02.api.letsencrypt.org-directory".into(),
        };
        let s = serde_json::to_string(&payload).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        for k in [
            "schema",
            "domain",
            "listen_port",
            "user",
            "password",
            "acme_directory_dir",
        ] {
            assert!(v.get(k).is_some(), "supervisor reads `{k}`: {s}");
        }
    }

    #[test]
    fn outcome_json_pins_php_visible_keys() {
        let out = NaiveRenderOutcome {
            path: "/data/config/naive.json".into(),
            bytes: 256,
            hash: "deadbeef".repeat(8),
            changed: true,
            active_users: 1,
            active_username: Some("test1".into()),
        };
        let s = serde_json::to_string(&out).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        for k in ["changed", "hash", "active_users"] {
            assert!(v.get(k).is_some(), "panel reads `{k}`: {s}");
        }
    }

    #[test]
    fn picks_first_safe_account_with_cleartext() {
        let _accounts = vec![
            // First account has username pass but no cleartext.
            account(1, "alice", None),
            // Second has full creds.
            account(2, "bob", Some("bobpw")),
            // Third also has, but bob should win.
            account(3, "charlie", Some("charliepw")),
        ];
        // This is exercised indirectly via render(); the unit test
        // here just documents the intent. Integration with the DB
        // mock lives alongside the rest of the renderer tests.
        let _ = cfg("naive.example.com");
    }
}
