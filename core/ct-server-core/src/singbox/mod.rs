// SPDX-License-Identifier: AGPL-3.0-only
//! sing-box config rendering — the heart of what makes proxy account
//! changes visible to the running server.
//!
//! Reads template (sing-box/config.json.tpl) + DB; substitutes
//! placeholders; serialises the JSON; writes atomically; returns the
//! SHA-256 of the new file.
//!
//! Atomic write is mandatory: a partial config.json would either fail
//! `sing-box check` (best case) or load with missing users (worst
//! case — a security regression). We write to a tmp file in the same
//! directory, fsync it, then rename — POSIX-atomic on the same
//! filesystem.
//!
//! Cleartext password handling: sing-box's `naive` inbound checks the
//! basic_auth password as cleartext (not bcrypt), so the panel
//! persists the cleartext encrypted with Laravel's Crypt and decrypts
//! at the DB-read boundary (see db.rs). The Rust core never sees the
//! encrypted form.

use crate::db;
use crate::domain::{ProxyAccount, ServerConfig};
use crate::{Error, Result};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::MySqlPool;
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
    pool: &MySqlPool,
    template_path: &str,
    output_path: &str,
    dry_run: bool,
    json_output: bool,
) -> Result<()> {
    let cfg = db::server_config(pool).await?;
    let accounts = db::active_proxy_accounts(pool).await?;
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

    // The hash is computed over (rendered config) AND (cert mtime).
    // The mtime is NOT in the rendered file (sing-box would reject
    // an unknown JSON field) — it's just an extra input to the change-
    // detection hash so a Caddy cert renewal flips `changed = true`
    // and the existing scheduled `singbox:render --if-changed --reload`
    // path picks up the rotation without any other plumbing.
    let cert_mtime = read_cert_mtime(&cfg).await;
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    if let Some(t) = cert_mtime {
        hasher.update(format!("\x00cert-mtime:{t}").as_bytes());
    }
    let hash = hex::encode(hasher.finalize());

    if dry_run {
        print!("{body}");
        return Ok(());
    }

    let last_hash = cfg.last_caddyfile_hash.clone().unwrap_or_default();
    let changed = last_hash != hash;

    if changed {
        atomic_write(output_path, &body).await?;
        db::record_caddyfile_hash(pool, &hash).await?;
        tracing::info!(
            path = output_path, %hash, bytes = body.len(),
            users = safe_accounts.len(),
            cert_mtime_seen = cert_mtime.is_some(),
            "sing-box config rendered"
        );
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

/// Derive the clash-API bearer token. Used by every reload caller
/// (daemon / quota / redis_bridge) to construct a
/// [`crate::admin::ClashAdmin`] whose secret matches what the most
/// recent `render` baked into `experimental.clash_api.secret`.
///
/// Pure over the `CT_CLASH_SECRET_SEED` env var — no DB round-trip
/// is required, so this signature carries no pool. (post-R2-2;
/// the legacy `database_url` parameter was dropped in the
/// shared-pool refactor — it had been a stale artefact since R2-2.)
pub async fn current_clash_secret() -> Result<String> {
    clash_secret()
}

/// Run `sing-box check` against the rendered file. Catches malformed
/// JSON / unknown fields / port conflicts before the reload attempt.
///
/// Bounded by a 30s timeout so a hung docker daemon doesn't wedge
/// the validation step.
pub async fn validate(output_path: &str) -> Result<()> {
    let mut cmd = Command::new("docker");
    cmd.args(["exec", "ct-singbox", "sing-box", "check", "-c", output_path]);
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| Error::ExternalCommandTimedOut {
            command: "docker exec ct-singbox sing-box check",
            timeout: std::time::Duration::from_secs(30),
            hint: "`sing-box check` timed out after 30s. \
                       Is the ct-singbox container running? `docker ps`"
                .to_owned(),
        })??;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::ExternalCommandFailed {
            command: "docker exec ct-singbox sing-box check",
            stderr: stderr.into_owned(),
        });
    }
    println!("sing-box config valid");
    Ok(())
}

async fn render_to_string(
    template_path: &str,
    cfg: &ServerConfig,
    accounts: &[ProxyAccount],
) -> Result<String> {
    let template =
        fs::read_to_string(template_path)
            .await
            .map_err(|source| Error::TemplateRead {
                path: template_path.to_owned(),
                source,
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

    // sing-box reads cert + key files at config-load time. The files
    // are written by Caddy's auto-HTTPS into the shared volume; we
    // reference them via stable paths derived from Caddy's standard
    // layout. See cert_paths() for the layout rules.
    let (cert_path, key_path) = cert_paths(cfg);

    // sing-box 1.12+ replaced the single `dns.servers[].address` field
    // (a full URL) with separate `type` / `server` / `path` fields.
    // Split DohResolver here so the template can emit the new shape.
    let (doh_server, doh_path) = split_doh_url(&cfg.doh_resolver);

    let secret = clash_secret()?;
    let listen = clash_listen();
    // Defense-in-depth: every binding below lands inside a JSON `"..."`
    // string in the rendered sing-box config (or feeds one further
    // down the line), so we apply `template::json_escape` at the
    // binding site. UsersJson is already a fully-rendered JSON
    // fragment (object/array, not a string-context substitution),
    // and ClashSecret is hex by construction (clash_secret()), so
    // both are passed through verbatim. ClashListen is host:port from
    // CT_CLASH_LISTEN — operator-controlled, but escaped anyway for
    // consistency with the rest of the binding table.
    let bindings = crate::template::Bindings::new()
        .set("Domain", crate::template::json_escape(&cfg.domain))
        .set("AcmeEmail", crate::template::json_escape(&cfg.acme_email))
        .set(
            "AcmeDirectory",
            crate::template::json_escape(&cfg.acme_directory),
        )
        .set("UsersJson", &users_json)
        .set(
            "DohResolver",
            crate::template::json_escape(&cfg.doh_resolver),
        )
        .set("DohServer", crate::template::json_escape(&doh_server))
        .set("DohPath", crate::template::json_escape(&doh_path))
        .set("ClashSecret", &secret)
        .set("ClashListen", crate::template::json_escape(&listen))
        .set("CertPath", crate::template::json_escape(&cert_path))
        .set("KeyPath", crate::template::json_escape(&key_path))
        .into_map();

    crate::template::render(&template, &bindings).map_err(|source| Error::TemplateRender {
        path: template_path.to_owned(),
        source,
    })
}

/// Derive the certificate / key paths Caddy uses for our domain.
/// Caddy stores certs under `$XDG_DATA_HOME/caddy/certificates/...`,
/// and the official caddy image sets `XDG_DATA_HOME=/data`, so
/// inside the caddy container the cert lands at:
///
/// ```text
/// /data/caddy/certificates/<ca-folder>/<domain>/<domain>.crt
/// ```
///
/// The `caddy_data` named volume's root is therefore the directory
/// caddy writes to (i.e. it contains a top-level `caddy/` subdir).
/// We mount `caddy_data` at `/data/caddy` in the sing-box container,
/// so from sing-box's perspective the cert is at:
///
/// ```text
/// /data/caddy/caddy/certificates/<ca-folder>/<domain>/<domain>.crt
/// ```
///
/// (The double `caddy/` is the volume's own subdir surfacing under
/// the chosen mount point, not a typo.) `<ca-folder>` is derived
/// from the ACME directory URL by stripping the scheme and
/// replacing slashes with dashes — see ca_folder_from_directory.
fn cert_paths(cfg: &ServerConfig) -> (String, String) {
    let ca_folder = ca_folder_from_directory(&cfg.acme_directory);
    let base = format!(
        "/data/caddy/caddy/certificates/{ca}/{d}/{d}",
        ca = ca_folder,
        d = cfg.domain,
    );
    (format!("{base}.crt"), format!("{base}.key"))
}

/// Split a DoH URL like "https://1.1.1.1/dns-query" into (server, path).
/// sing-box 1.12+ requires DNS server `type` + `server` + `path` fields
/// rather than the legacy single `address` URL. Empty/malformed input
/// yields an empty server with the standard `/dns-query` path so the
/// rendered template stays well-formed (sing-box will reject it at
/// validation time, surfacing the real misconfiguration).
fn split_doh_url(url: &str) -> (String, String) {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    match rest.find('/') {
        Some(i) => (rest[..i].to_string(), rest[i..].to_string()),
        None => (rest.to_string(), "/dns-query".to_string()),
    }
}

fn ca_folder_from_directory(url: &str) -> String {
    // Strip `https://` (or `http://`) and replace any `/` with `-`.
    // Matches Caddy's storage/util layout, which has been stable across
    // 2.x releases.
    let stripped = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    stripped.replace('/', "-").trim_end_matches('-').to_owned()
}

/// Read the cert file's last-modified mtime as a UNIX-epoch-secs
/// integer. None when the file doesn't exist yet (Caddy hasn't
/// finished the first ACME issuance). The value is used purely as
/// an extra input to the change-detection hash — a renewed cert
/// flips its mtime, which flips the rendered-config hash, which
/// triggers the existing scheduled reload path.
async fn read_cert_mtime(cfg: &ServerConfig) -> Option<u64> {
    use std::time::UNIX_EPOCH;
    let (cert_path, _) = cert_paths(cfg);
    let meta = tokio::fs::metadata(&cert_path).await.ok()?;
    let mtime = meta.modified().ok()?;
    mtime.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// Derive the clash-API bearer secret from `CT_CLASH_SECRET_SEED`.
/// The seed is a per-install random byte string generated by
/// install.sh from /dev/urandom into .env on first boot. Sing-box
/// treats the resulting hex digest as an opaque token; it must be
/// reproducible on every process that talks to the clash API
/// (panel renderer, daemon, quota, redis-bridge).
///
/// Refuses to derive when the seed is missing or empty. An empty
/// seed would reduce the bearer to `sha256("ct-clash-secret-v1:")`,
/// derivable by anyone who reads the source — exactly the R2-2
/// vulnerability in docs/audits/2026-05-04T06-31-58Z.md (which
/// previously fell back to the publicly-readable acme_email when
/// the per-install seed wasn't set).
///
/// Listen address (`host:port`) for sing-box's clash-API HTTP
/// listener. Substituted into config.json.tpl as `{{ .ClashListen }}`.
///
/// H3 (2026-05-05 audit) — pre-fix this was hardcoded to
/// `0.0.0.0:9090` in the template, binding the management API on
/// every interface inside the sing-box container. The compose
/// `ports:` block deliberately does not publish 9090, so external
/// reach was blocked, but any neighbour on the `ct-net` docker
/// network (caddy, panel) could reach it. The audit-enforced CI
/// guard catches accidental host-port mappings, but does NOT cap
/// the inter-container blast radius.
///
/// Default chosen for fail-closed semantics: `127.0.0.1:9090`. An
/// operator running ct-server-core outside docker-compose with no
/// env override gets a loopback-only listener. The shipped
/// docker-compose.yml overrides via `CT_CLASH_LISTEN=172.30.0.10:9090`
/// (a static IP on the `ct-clash` internal network — only the panel
/// container is on that network, so caddy can no longer reach
/// clash-API even though sing-box keeps its public 443 on `ct-net`).
///
/// The env var is read at every render call, so a deployment can
/// tighten or relax this without rebuilding the image.
pub(crate) fn clash_listen() -> String {
    std::env::var("CT_CLASH_LISTEN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1:9090".to_string())
}

/// `pub(crate)` so callers in the same crate (template renderer,
/// admin client, quota, redis bridge) can derive the same value.
/// External callers should use [`current_clash_secret`].
pub(crate) fn clash_secret() -> Result<String> {
    let seed = std::env::var("CT_CLASH_SECRET_SEED").unwrap_or_default();
    if seed.is_empty() {
        return Err(Error::config(
            "CT_CLASH_SECRET_SEED is unset or empty. install.sh generates \
             this on first boot from /dev/urandom; if you upgraded from a \
             pre-R2-2 build, append `CT_CLASH_SECRET_SEED=$(openssl rand \
             -hex 32)` to .env and redeploy panel + sing-box so both pick \
             up the new value.",
        ));
    }
    let mut h = Sha256::new();
    h.update(b"ct-clash-secret-v1:");
    h.update(seed.as_bytes());
    Ok(hex::encode(h.finalize()))
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

    let tmp: PathBuf = dir.join(format!(".singbox.tmp.{}", hex::encode(rand_bytes(4))));
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

    // fsync the PARENT DIRECTORY after the rename. POSIX rename is
    // atomic with respect to a concurrent reader, but the directory
    // entry update may sit in the page cache for a long time. After
    // a power loss between the rename and the next implicit sync,
    // the directory entry can revert — the rename appears "to have
    // happened" to a process running, but the on-disk metadata
    // points at the old inode (or, on some filesystems, no inode at
    // all, leaving the file vanished). For sing-box that means a
    // revoked credential silently re-activates after an unclean
    // reboot. Costs ~1 fdatasync per render — negligible compared
    // to the file write itself, and only happens on actual config
    // changes (the SHA-256 dedupe at the caller short-circuits
    // unchanged renders before reaching this function).
    let dirfile = fs::File::open(dir)
        .await
        .map_err(|source| Error::AtomicWrite {
            path: dir.display().to_string(),
            op: "open_parent_dir",
            source,
        })?;
    dirfile
        .sync_all()
        .await
        .map_err(|source| Error::AtomicWrite {
            path: dir.display().to_string(),
            op: "sync_parent_dir",
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
        // render_to_string -> clash_secret() reads CT_CLASH_SECRET_SEED
        // from the environment; without it, it errors. Set a fixed
        // test seed so the assertions stay deterministic. Process-
        // global env state is OK here because every render-touching
        // test in this module sets the same value.
        std::env::set_var("CT_CLASH_SECRET_SEED", "test-seed-for-render");
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
                "clash": "{{ .ClashSecret }}",
                "cert": "{{ .CertPath }}",
                "key":  "{{ .KeyPath }}"
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
        // Cert paths land at the standard Caddy location for the
        // pinned Let's Encrypt production directory.
        assert!(
            body.contains(
                "/data/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/proxy.example.com/proxy.example.com.crt"
            ),
            "rendered body should contain the standard LE cert path; got: {body}"
        );
        assert!(body.contains("proxy.example.com.key"));
    }

    #[test]
    fn ca_folder_strips_scheme_and_replaces_slashes() {
        assert_eq!(
            ca_folder_from_directory("https://acme-v02.api.letsencrypt.org/directory"),
            "acme-v02.api.letsencrypt.org-directory",
        );
        assert_eq!(
            ca_folder_from_directory("https://acme-staging-v02.api.letsencrypt.org/directory"),
            "acme-staging-v02.api.letsencrypt.org-directory",
        );
        // No scheme — passes through.
        assert_eq!(ca_folder_from_directory("local-test"), "local-test",);
        // Trailing slash gets eaten.
        assert_eq!(
            ca_folder_from_directory("https://example.com/dir/"),
            "example.com-dir",
        );
    }

    #[test]
    fn cert_paths_compose_correctly() {
        let c = cfg();
        let (cert, key) = cert_paths(&c);
        assert_eq!(
            cert,
            "/data/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/proxy.example.com/proxy.example.com.crt"
        );
        assert_eq!(
            key,
            "/data/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/proxy.example.com/proxy.example.com.key"
        );
    }

    #[test]
    fn unsafe_username_is_rejected_at_domain_boundary() {
        let mut a = account("alice space", "x");
        assert!(!a.caddyfile_safe_username());
        a.username = "alice".into();
        assert!(a.caddyfile_safe_username());
    }

    #[test]
    fn split_doh_url_handles_common_shapes() {
        assert_eq!(
            split_doh_url("https://1.1.1.1/dns-query"),
            ("1.1.1.1".to_string(), "/dns-query".to_string()),
        );
        assert_eq!(
            split_doh_url("https://dns.google/some/custom"),
            ("dns.google".to_string(), "/some/custom".to_string()),
        );
        // No path: falls back to /dns-query so the rendered template
        // remains valid for sing-box's default expectations.
        assert_eq!(
            split_doh_url("https://1.1.1.1"),
            ("1.1.1.1".to_string(), "/dns-query".to_string()),
        );
        // Empty input: empty server, default path. sing-box check
        // will reject the empty server, surfacing the misconfig.
        assert_eq!(split_doh_url(""), (String::new(), "/dns-query".to_string()),);
    }

    #[tokio::test]
    async fn empty_user_set_emits_placeholder() {
        std::env::set_var("CT_CLASH_SECRET_SEED", "test-seed-for-render");
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

    // Round-17 chassis-cockpit boundary: pin the JSON-output keys
    // the PHP panel parses from `ct-server-core --json singbox
    // render`. The PHP side
    // (`panel/app/Services/SingBoxConfigGenerator.php:67-69`)
    // reads `$out['changed']` and `$out['hash']` with `?? <default>`
    // — so a Rust-side rename produces null on the cockpit and the
    // operator silently sees "no change" + "saved hash null" with
    // no diagnostic. This test fails first if either field is
    // renamed or removed.
    #[test]
    fn render_outcome_json_pins_php_visible_keys() {
        let out = RenderOutcome {
            path: "/etc/sing-box/config.json".into(),
            bytes: 1024,
            hash: "deadbeef".repeat(8),
            changed: true,
            active_users: 3,
        };
        let s = serde_json::to_string(&out).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(
            v.get("changed").is_some(),
            "panel reads `changed` — RenderOutcome MUST emit it: {s}"
        );
        assert!(
            v.get("hash").is_some(),
            "panel reads `hash` — RenderOutcome MUST emit it: {s}"
        );
        // `path`, `bytes`, `active_users` aren't read by the panel
        // today, but emit them so a future panel feature ("show
        // last render bytes in admin UI") doesn't have to touch
        // the Rust struct.
    }
}
