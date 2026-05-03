// Shared SQLx pool and DB queries.
//
// The panel writes to the same MariaDB. We re-read on every operation
// — no caching at this layer — because the panel's UI assumes a
// strong-consistency view. The pool is small (4 conns) since the core
// runs alongside a single panel container; the panel itself uses a
// separate larger pool.

use crate::Result;
use crate::domain::{ProxyAccount, ServerConfig};
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

    Ok(ServerConfig {
        id: row.try_get::<i64, _>("id")?,
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
        SELECT id, username, password_hash, enabled, quota_bytes, used_bytes,
               expires_at
        FROM proxy_accounts
        WHERE enabled = 1
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (quota_bytes IS NULL OR used_bytes < quota_bytes)
        ORDER BY username
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(ProxyAccount {
            id: r.try_get::<i64, _>("id")?,
            username: r.try_get("username")?,
            password_hash: r.try_get("password_hash")?,
            enabled: r.try_get::<i8, _>("enabled")? != 0,
            quota_bytes: r.try_get("quota_bytes").ok(),
            used_bytes: r.try_get::<i64, _>("used_bytes").unwrap_or(0),
            expires_at: r.try_get::<Option<DateTime<Utc>>, _>("expires_at").unwrap_or(None),
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
    .bind(proxy_account_id)
    .bind(day)
    .bind(uplink)
    .bind(downlink)
    .bind(connections)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() as i64)
}

pub async fn add_used_bytes(pool: &MySqlPool, proxy_account_id: i64, delta: i64) -> Result<()> {
    sqlx::query(
        r"
        UPDATE proxy_accounts
        SET used_bytes = used_bytes + ?, last_seen_at = NOW(), updated_at = NOW()
        WHERE id = ?
        ",
    )
    .bind(delta)
    .bind(proxy_account_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn disable_account(pool: &MySqlPool, id: i64, reason: &str) -> Result<()> {
    tracing::info!(account = id, reason, "disabling account");
    sqlx::query(
        r"UPDATE proxy_accounts SET enabled = 0, updated_at = NOW() WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}
