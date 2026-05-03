// Quota + expiry enforcer. Disables proxy_accounts whose:
//   - expires_at  is in the past, OR
//   - quota_bytes is non-null and used_bytes >= quota_bytes
//
// If any account changed state, re-render the sing-box config and
// hot-reload via the clash API so the new `users` array (with the
// disabled accounts removed) takes effect immediately.
//
// Robustness: SELECT-the-candidates and the per-row UPDATEs run
// inside a single transaction. Without that, an operator
// re-enabling an account in the panel between our SELECT and the
// matching UPDATE would have their re-enable silently overwritten
// by our concurrent disable. The transaction is short (typically
// 0-3 rows) so it doesn't hold locks for any perceivable time.

use crate::{admin, db, singbox, Result};
use chrono::Utc;
use sqlx::Row;

pub async fn enforce(
    database_url: &Option<String>,
    template: &str,
    output: &str,
    admin_socket: &str,
) -> Result<()> {
    let pool = db::connect(database_url).await?;

    let mut tx = pool.begin().await?;

    // Find accounts to disable. SELECT ... FOR UPDATE locks the
    // matching rows so a concurrent panel save can't flip
    // `enabled` back on between our SELECT and the per-row
    // UPDATE below.
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
        FOR UPDATE
        ",
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut disabled = 0_usize;
    for row in &to_disable {
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
        sqlx::query(r"UPDATE proxy_accounts SET enabled = 0, updated_at = NOW() WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        disabled += 1;
    }

    tx.commit().await?;

    let mut reloaded = false;
    if disabled > 0 {
        // Render + reload outside the transaction — the rendered
        // config + the clash-API call don't share locks with the DB.
        // If render says "unchanged" we still reload; disabling an
        // account always changes the sing-box `users` array.
        singbox::render(database_url, template, output, false, false).await?;
        if let Err(e) = admin::reload(admin_socket, output).await {
            tracing::warn!(error = %e, "reload after quota enforcement failed");
        } else {
            reloaded = true;
        }
    }

    println!(r#"{{"disabled": {disabled}, "reload_triggered": {reloaded}}}"#,);
    Ok(())
}
