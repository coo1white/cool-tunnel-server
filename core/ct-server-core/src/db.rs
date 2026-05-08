// SPDX-License-Identifier: AGPL-3.0-only
// Shared SQLx pool and DB queries.
//
// COMPILE-TIME SQL TYPE CHECKING (v0.0.11+).
//
// All queries below use `sqlx::query!()` / `sqlx::query_as!()`,
// which inspect the live schema during `cargo sqlx prepare` and
// embed the result in `core/.sqlx/*.json`. The build then uses
// `SQLX_OFFLINE=true` to validate every query against that
// frozen metadata at `cargo check` time. Schema regressions
// (column dropped, retyped, renamed) fail the build, never
// production. See `docs/sqlx-offline.md` and the
// `make sqlx-prepare` target.
//
// Type-mapping notes:
//   - Laravel `\$table->id()` / `\$table->foreignId()` →
//     `BIGINT UNSIGNED` → sqlx returns `u64`. We cast to `i64`
//     at the struct boundary; primary-key IDs in any plausible
//     deployment are nowhere near 2^63 so the cast is lossless.
//   - Laravel `\$table->boolean()` → `TINYINT(1)` → sqlx returns
//     `i8`. We compare `!= 0` for the bool field.
//   - Laravel `\$table->timestamp()->nullable()` → with chrono
//     feature, sqlx returns `Option<chrono::DateTime<chrono::Utc>>`.

use crate::domain::{ProxyAccount, ServerConfig};
use crate::Result;
use chrono::NaiveDate;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions};
use std::env;
use std::str::FromStr;
use std::time::Duration;

pub async fn connect(database_url: &Option<String>) -> Result<MySqlPool> {
    // Resolve connection options. Prefer URL-style (`--database-url`
    // or `DATABASE_URL`) when present; otherwise build options from
    // the discrete `DB_*` env vars Laravel hands us.
    //
    // The discrete-vars path was previously formatted into a
    // `mysql://user:pass@host:port/db` URL and re-parsed by sqlx,
    // which broke when DB_PASSWORD contained URL-special characters
    // (`/`, `@`, `:`, `#`, `?`). install.sh's recommended generator
    // (`openssl rand -base64 32`) produces `/` in roughly a third of
    // outputs, which made first-deploy fail with the famously
    // unhelpful `error: error with configuration: invalid port
    // number` — the URL parser misread the `/` in the password as
    // the path separator and the password's tail as the port.
    // Caught on the first real-world Debian 13 RackNerd deploy
    // (v0.0.25 hotfix). Use the typed builder so secrets bypass
    // URL escaping entirely.
    let opts = if let Some(url) = database_url
        .clone()
        .or_else(|| env::var("DATABASE_URL").ok())
    {
        MySqlConnectOptions::from_str(&url)?
    } else {
        options_from_env(|k| env::var(k).ok())
    };

    let pool = MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Build typed sqlx connection options from the discrete `DB_*`
/// env vars Laravel hands the panel. Pure over an env-var lookup
/// closure so the v0.0.25 regression test can inject values
/// without mutating the process environment.
fn options_from_env<F>(get: F) -> MySqlConnectOptions
where
    F: Fn(&str) -> Option<String>,
{
    let host = get("DB_HOST").unwrap_or_else(|| "db".into());
    let port = get("DB_PORT")
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3306);
    let db = get("DB_DATABASE").unwrap_or_else(|| "cooltunnel".into());
    let user = get("DB_USERNAME").unwrap_or_else(|| "cooltunnel".into());
    let pass = get("DB_PASSWORD").unwrap_or_default();
    MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .database(&db)
        .username(&user)
        .password(&pass)
}

pub async fn server_config(pool: &MySqlPool) -> Result<ServerConfig> {
    let row = sqlx::query!(
        r#"
        SELECT
            id, domain, acme_email, acme_directory,
            anti_tracking_hide_ip,
            anti_tracking_hide_via,
            anti_tracking_probe_resistance,
            anti_tracking_doh_resolver,
            http3_enabled,
            last_caddyfile_hash,
            last_rendered_at
        FROM server_configs
        WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(ServerConfig {
        id: row.id as i64,
        domain: row.domain,
        acme_email: row.acme_email,
        acme_directory: row.acme_directory,
        hide_ip: row.anti_tracking_hide_ip != 0,
        hide_via: row.anti_tracking_hide_via != 0,
        probe_resistance: row.anti_tracking_probe_resistance != 0,
        doh_resolver: row.anti_tracking_doh_resolver,
        http3_enabled: row.http3_enabled != 0,
        last_caddyfile_hash: row.last_caddyfile_hash,
        last_rendered_at: row.last_rendered_at,
    })
}

pub async fn active_proxy_accounts(pool: &MySqlPool) -> Result<Vec<ProxyAccount>> {
    let rows = sqlx::query!(
        r#"
        SELECT id, username, password_hash, password_cleartext_encrypted,
               enabled, quota_bytes, used_bytes, expires_at
        FROM proxy_accounts
        WHERE enabled = 1
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (quota_bytes IS NULL OR used_bytes < quota_bytes)
        ORDER BY username
        "#,
    )
    .fetch_all(pool)
    .await?;

    let app_key = std::env::var("APP_KEY").ok();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        // password_cleartext_encrypted is TEXT NULL — sqlx returns
        // Option<String>. Decryption errors are logged + skipped:
        // a stale APP_KEY or pre-migration row should not lock the
        // operator out of every other account.
        let cleartext = r.password_cleartext_encrypted.and_then(|enc| {
            match crate::laravel_crypt::decrypt(&enc, app_key.as_deref().unwrap_or("")) {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!(error = %e, "could not decrypt cleartext for account");
                    None
                }
            }
        });
        out.push(ProxyAccount {
            id: r.id as i64,
            username: r.username,
            password_hash: r.password_hash,
            cleartext_password: cleartext,
            enabled: r.enabled != 0,
            quota_bytes: r.quota_bytes.map(|n| n as i64),
            used_bytes: r.used_bytes as i64,
            expires_at: r.expires_at,
        });
    }
    Ok(out)
}

pub async fn record_caddyfile_hash(pool: &MySqlPool, hash: &str) -> Result<()> {
    sqlx::query!(
        r#"
        UPDATE server_configs
        SET last_caddyfile_hash = ?, last_rendered_at = NOW()
        WHERE id = 1
        "#,
        hash,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn upsert_traffic(
    pool: &MySqlPool,
    proxy_account_id: i64,
    day: NaiveDate,
    uplink: i64,
    downlink: i64,
    connections: i64,
) -> Result<i64> {
    // Schema columns are UNSIGNED — bind as u64/u32 to match. Internal
    // callers pass i64; clamp negatives to 0 (a metric-source bug
    // anyway) and cast for the bind.
    let pid: u64 = proxy_account_id.max(0) as u64;
    let up: u64 = uplink.max(0) as u64;
    let down: u64 = downlink.max(0) as u64;
    let conn: u32 = connections.max(0) as u32;
    let res = sqlx::query!(
        r#"
        INSERT INTO traffic_logs
            (proxy_account_id, day, uplink_bytes, downlink_bytes, connections, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
            uplink_bytes   = VALUES(uplink_bytes),
            downlink_bytes = VALUES(downlink_bytes),
            connections    = GREATEST(connections, VALUES(connections)),
            updated_at     = NOW()
        "#,
        pid, day, up, down, conn,
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected() as i64)
}

/// Maximum byte delta accepted in a single call. 1 PiB is well
/// above any plausible per-window traffic for a single proxy
/// account; values above this are almost certainly a parsing bug
/// in the metric source (sing-box upgrade changed the line shape,
/// the parser misread a label, etc.) and we reject them rather
/// than instantly disabling everyone via the quota path.
const MAX_USED_BYTES_DELTA: i64 = 1 << 50; // 1 PiB

pub async fn add_used_bytes(pool: &MySqlPool, proxy_account_id: i64, delta: i64) -> Result<()> {
    if delta < 0 {
        return Err(crate::Error::msg(format!(
            "add_used_bytes: refusing negative delta {delta} for account {proxy_account_id}"
        )));
    }
    if delta > MAX_USED_BYTES_DELTA {
        return Err(crate::Error::msg(format!(
            "add_used_bytes: delta {delta} for account {proxy_account_id} \
             exceeds {MAX_USED_BYTES_DELTA} (sane upper bound); \
             likely a metric-source regression — refusing to apply"
        )));
    }
    // proxy_accounts.id and used_bytes are BIGINT UNSIGNED — bind as u64.
    let d: u64 = delta as u64;
    let id: u64 = proxy_account_id.max(0) as u64;
    sqlx::query!(
        r#"
        UPDATE proxy_accounts
        SET used_bytes = used_bytes + ?, last_seen_at = NOW(), updated_at = NOW()
        WHERE id = ?
        "#,
        d,
        id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Single-account disable. Kept for the daemon's per-account
/// revocation path (Redis pub/sub) where the SQL is a one-shot
/// outside any larger transaction. The quota enforcer inlines its
/// own UPDATE inside a transaction since it needs SELECT FOR
/// UPDATE atomicity.
#[allow(dead_code)]
pub async fn disable_account(pool: &MySqlPool, id: i64, reason: &str) -> Result<()> {
    tracing::info!(account = id, reason, "disabling account");
    let id_u: u64 = id.max(0) as u64;
    sqlx::query!(
        r#"UPDATE proxy_accounts SET enabled = 0, updated_at = NOW() WHERE id = ?"#,
        id_u,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(pairs: &[(&str, &str)]) -> MySqlConnectOptions {
        let owned: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        options_from_env(|k| owned.get(k).cloned())
    }

    #[test]
    fn defaults_match_compose_env_block() {
        // No env vars at all → docker-compose's panel env block has
        // DB_HOST=db, DB_PORT=3306; defaults must agree so a stripped
        // .env doesn't drift the rendered config off the compose
        // network's reachable host.
        let opts = options_from_env(|_| None);
        assert_eq!(opts.get_host(), "db");
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_database(), Some("cooltunnel"));
        assert_eq!(opts.get_username(), "cooltunnel");
    }

    #[test]
    fn slash_in_password_does_not_corrupt_port_or_host() {
        // Regression test for v0.0.25 hotfix.
        //
        // BEFORE: assemble_from_parts() formatted env vars into
        //   "mysql://cooltunnel:abc/def@db:3306/cooltunnel"
        // sqlx's URL parser then read the FIRST `/` as the path
        // separator, making the authority `cooltunnel:abc` — i.e.
        // host="cooltunnel", port="abc", which url::ParseError
        // surfaced as "invalid port number". Real-world impact:
        // install.sh's `openssl rand -base64 32` produces `/` in
        // ~30% of outputs, and v0.0.24 first-deploy on Debian 13
        // crashed both `caddyfile render` and `singbox render`
        // with a famously unhelpful error message.
        //
        // AFTER: the typed builder accepts the raw password byte-
        // for-byte; no URL escaping is involved on the env-var path.
        let opts = from(&[
            ("DB_HOST", "db"),
            ("DB_PORT", "3306"),
            ("DB_DATABASE", "cooltunnel"),
            ("DB_USERNAME", "cooltunnel"),
            // Realistic openssl-base64 sample with `/`, `+`, `=`,
            // every URL-meta char that used to break the URL parser.
            ("DB_PASSWORD", "abc/def+ghi:jkl@mno#pqr=stu?vwx"),
        ]);
        assert_eq!(opts.get_host(), "db");
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_database(), Some("cooltunnel"));
        assert_eq!(opts.get_username(), "cooltunnel");
    }

    #[test]
    fn malformed_db_port_falls_back_to_3306() {
        // A stray `\r` from a Windows-edited .env or an accidental
        // alphabetic value must not blow up the renderer; fall back
        // to the documented default rather than refusing to render
        // at all (rendering with the wrong port is better than
        // halting Caddy + sing-box bring-up).
        let opts = from(&[("DB_PORT", "not-a-number"), ("DB_HOST", "db")]);
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_host(), "db");
    }

    #[test]
    fn url_path_still_works_for_explicit_database_url() {
        // When the operator explicitly sets DATABASE_URL (e.g. for
        // out-of-stack tooling) we still feed it through
        // MySqlConnectOptions::from_str. Regression guard: that
        // path must keep parsing a well-formed URL with no surprises.
        let url = "mysql://cooltunnel:hex0123@db:3306/cooltunnel";
        let opts = MySqlConnectOptions::from_str(url).unwrap();
        assert_eq!(opts.get_host(), "db");
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_database(), Some("cooltunnel"));
        assert_eq!(opts.get_username(), "cooltunnel");
    }
}
