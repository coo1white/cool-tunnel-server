// Quota + expiry enforcer. Disables proxy_accounts whose:
//   - expires_at  is in the past, OR
//   - quota_bytes is non-null and used_bytes >= quota_bytes
//
// If any account changed state, re-render the Caddyfile and reload
// Caddy so basic_auth lines come into effect immediately.

use crate::{admin, singbox, db, Result};
use chrono::Utc;
use sqlx::Row;

pub async fn enforce(
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
) -> Result<()> {
    let pool = db::connect(database_url).await?;

    // Find accounts to disable.
    let to_disable = sqlx::query(
        r"
        SELECT id, username,
               (expires_at IS NOT NULL AND expires_at <= NOW())          AS is_expired,
               (quota_bytes IS NOT NULL AND used_bytes >= quota_bytes)   AS over_quota
        FROM proxy_accounts
        WHERE enabled = 1
          AND (
                (expires_at IS NOT NULL AND expires_at <= NOW())
                OR
                (quota_bytes IS NOT NULL AND used_bytes >= quota_bytes)
              )
        ",
    )
    .fetch_all(&pool)
    .await?;

    let mut disabled = 0_usize;
    for row in to_disable {
        let id: i64 = row.try_get("id")?;
        let username: String = row.try_get("username")?;
        let is_expired: i32 = row.try_get("is_expired")?;
        let over_quota: i32 = row.try_get("over_quota")?;
        let reason = match (is_expired != 0, over_quota != 0) {
            (true, _) => "expired",
            (_, true) => "over_quota",
            _ => "unknown",
        };
        tracing::info!(account = %username, reason, "disabling at {}", Utc::now());
        db::disable_account(&pool, id, reason).await?;
        disabled += 1;
    }

    let mut reloaded = false;
    if disabled > 0 {
        // Render + reload. If render says "unchanged" we still reload
        // — disabling an account always changes basic_auth lines.
        singbox::render(database_url, template, output, false, false).await?;
        if let Err(e) = admin::reload_caddyfile_text(admin_socket, output).await {
            tracing::warn!(error = %e, "reload after quota enforcement failed");
        } else {
            reloaded = true;
        }
    }

    println!(
        r#"{{"disabled": {disabled}, "reload_triggered": {reloaded}}}"#,
    );
    Ok(())
}
