// Shared SQLx pool and DB queries.
//
// The panel writes to the same MariaDB. We re-read on every operation
// — no caching at this layer — because the panel's UI assumes a
// strong-consistency view. The pool is small (4 conns) since the core
// runs alongside a single panel container; the panel itself uses a
// separate larger pool.

use crate::domain::{ProxyAccount, ServerConfig};
use crate::Result;
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::Row;
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
    let row = sqlx::query(
        r"
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
        ",
    )
    .fetch_one(pool)
    .await?;

    // NOTE on the u64 → i64 cast: Laravel's `$table->id()` migration
    // creates `BIGINT UNSIGNED AUTO_INCREMENT`. sqlx is strict about
    // the type match at decode time and rejects an i64 try_get on an
    // unsigned column ("Rust type i64 (as SQL type BIGINT) is not
    // compatible with SQL type BIGINT UNSIGNED"). We read u64 and
    // cast — primary-key IDs in Laravel will never reach 2^63 in any
    // realistic workload, so the cast is lossless. Same pattern
    // for the rest of the BIGINT UNSIGNED columns below.
    Ok(ServerConfig {
        id: row.try_get::<u64, _>("id")? as i64,
        domain: row.try_get("domain")?,
        acme_email: row.try_get("acme_email")?,
        acme_directory: row.try_get("acme_directory")?,
        hide_ip: row.try_get::<i8, _>("anti_tracking_hide_ip")? != 0,
        hide_via: row.try_get::<i8, _>("anti_tracking_hide_via")? != 0,
        probe_resistance: row.try_get::<i8, _>("anti_tracking_probe_resistance")? != 0,
        doh_resolver: row.try_get("anti_tracking_doh_resolver")?,
        http3_enabled: row.try_get::<i8, _>("http3_enabled")? != 0,
        admin_basic_auth_user: row.try_get("admin_basic_auth_user").ok(),
        admin_basic_auth_hash: row.try_get("admin_basic_auth_hash").ok(),
        last_caddyfile_hash: row.try_get("last_caddyfile_hash").ok(),
        last_rendered_at: row.try_get::<Option<DateTime<Utc>>, _>("last_rendered_at")?,
    })
}

pub async fn active_proxy_accounts(pool: &MySqlPool) -> Result<Vec<ProxyAccount>> {
    let rows = sqlx::query(
        r"
        SELECT id, username, password_hash, password_cleartext_encrypted,
               enabled, quota_bytes, used_bytes, expires_at
        FROM proxy_accounts
        WHERE enabled = 1
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (quota_bytes IS NULL OR used_bytes < quota_bytes)
        ORDER BY username
        ",
    )
    .fetch_all(pool)
    .await?;

    let app_key = std::env::var("APP_KEY").ok();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        // password_cleartext_encrypted is allowed to be NULL (pre-
        // migration rows or rows the operator never re-saved). We
        // log on type mismatch / decode error rather than silently
        // skipping — a schema migration that changed the column
        // type to e.g. BLOB without updating this code would be
        // visible in logs instead of resulting in every user being
        // locked out with "could not decrypt".
        let encrypted: Option<String> = match r.try_get("password_cleartext_encrypted") {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "password_cleartext_encrypted column type mismatch");
                None
            }
        };
        let cleartext = encrypted.and_then(|enc| {
            match crate::laravel_crypt::decrypt(&enc, app_key.as_deref().unwrap_or("")) {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!(error = %e, "could not decrypt cleartext for account");
                    None
                }
            }
        });
        // quota_bytes / used_bytes are BIGINT UNSIGNED in the
        // Laravel migration; expires_at is nullable timestamp. Read
        // unsigned-int columns as u64 and cast (see note in
        // server_config above on why the cast is safe). We
        // distinguish "column NULL" (legitimate, means unlimited /
        // never-expire) from "column missing or wrong type"
        // (schema regression — fail loudly instead of silently
        // unlimited-quota every account).
        let quota_bytes = match r.try_get::<Option<u64>, _>("quota_bytes") {
            Ok(v) => v.map(|n| n as i64),
            Err(e) => {
                return Err(crate::Error::msg(format!(
                    "proxy_accounts.quota_bytes read failed (schema regression?): {e}"
                )));
            }
        };
        let used_bytes = match r.try_get::<u64, _>("used_bytes") {
            Ok(v) => v as i64,
            Err(e) => {
                return Err(crate::Error::msg(format!(
                    "proxy_accounts.used_bytes read failed (schema regression?): {e}"
                )));
            }
        };
        let expires_at = match r.try_get::<Option<DateTime<Utc>>, _>("expires_at") {
            Ok(v) => v,
            Err(e) => {
                return Err(crate::Error::msg(format!(
                    "proxy_accounts.expires_at read failed (schema regression?): {e}"
                )));
            }
        };
        out.push(ProxyAccount {
            id: r.try_get::<u64, _>("id")? as i64,
            username: r.try_get("username")?,
            password_hash: r.try_get("password_hash")?,
            cleartext_password: cleartext,
            enabled: r.try_get::<i8, _>("enabled")? != 0,
            quota_bytes,
            used_bytes,
            expires_at,
        });
    }
    Ok(out)
}

pub async fn record_caddyfile_hash(pool: &MySqlPool, hash: &str) -> Result<()> {
    sqlx::query(
        r"
        UPDATE server_configs
        SET last_caddyfile_hash = ?, last_rendered_at = NOW()
        WHERE id = 1
        ",
    )
    .bind(hash)
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
    // Schema columns are UNSIGNED — bind as u64/u32 to match.
    // Internal callers pass i64; clamp negatives to 0 (they would
    // be a metric-source bug anyway) and cast for the bind.
    let res = sqlx::query(
        r"
        INSERT INTO traffic_logs
            (proxy_account_id, day, uplink_bytes, downlink_bytes, connections, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
            uplink_bytes   = VALUES(uplink_bytes),
            downlink_bytes = VALUES(downlink_bytes),
            connections    = GREATEST(connections, VALUES(connections)),
            updated_at     = NOW()
        ",
    )
    .bind(proxy_account_id.max(0) as u64)
    .bind(day)
    .bind(uplink.max(0) as u64)
    .bind(downlink.max(0) as u64)
    .bind(connections.max(0) as u32)
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
    // proxy_accounts.id and used_bytes are BIGINT UNSIGNED — bind
    // as u64. The delta is bounded by MAX_USED_BYTES_DELTA above
    // so the cast can't truncate.
    sqlx::query(
        r"
        UPDATE proxy_accounts
        SET used_bytes = used_bytes + ?, last_seen_at = NOW(), updated_at = NOW()
        WHERE id = ?
        ",
    )
    .bind(delta as u64)
    .bind(proxy_account_id.max(0) as u64)
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
    // id column is BIGINT UNSIGNED — bind u64.
    sqlx::query(r"UPDATE proxy_accounts SET enabled = 0, updated_at = NOW() WHERE id = ?")
        .bind(id.max(0) as u64)
        .execute(pool)
        .await?;
    Ok(())
}
