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
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use std::env;
use std::time::Duration;

pub async fn connect(database_url: &Option<String>) -> Result<MySqlPool> {
    let url = database_url
        .clone()
        .or_else(|| env::var("DATABASE_URL").ok())
        .unwrap_or_else(assemble_from_parts);

    let pool = MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&url)
        .await?;
    Ok(pool)
}

fn assemble_from_parts() -> String {
    let host = env::var("DB_HOST").unwrap_or_else(|_| "db".into());
    let port = env::var("DB_PORT").unwrap_or_else(|_| "3306".into());
    let db = env::var("DB_DATABASE").unwrap_or_else(|_| "cooltunnel".into());
    let user = env::var("DB_USERNAME").unwrap_or_else(|_| "cooltunnel".into());
    let pass = env::var("DB_PASSWORD").unwrap_or_default();
    format!("mysql://{user}:{pass}@{host}:{port}/{db}")
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
            admin_basic_auth_user,
            admin_basic_auth_hash,
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
        admin_basic_auth_user: row.admin_basic_auth_user,
        admin_basic_auth_hash: row.admin_basic_auth_hash,
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
