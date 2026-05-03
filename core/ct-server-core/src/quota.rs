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
    // UPDATE below. Compile-time-checked SQL via sqlx::query!.
    //
    // The `!` after `is_expired` / `over_quota` in the column
    // alias forces sqlx to treat the value as non-nullable. The
    // expressions are `(IS NOT NULL AND <comparison>)` — they
    // short-circuit to 0 when the column is NULL, so the result
    // is always 0 or 1, never NULL. sqlx can't prove this from
    // the SQL alone (MySQL boolean expressions COULD return
    // NULL in general), so we tell it explicitly.
    let to_disable = sqlx::query!(
        r#"
        SELECT id, username,
               (expires_at IS NOT NULL AND expires_at <= NOW())          AS `is_expired!: i32`,
               (quota_bytes IS NOT NULL AND used_bytes >= quota_bytes)   AS `over_quota!: i32`
        FROM proxy_accounts
        WHERE enabled = 1
          AND (
                (expires_at IS NOT NULL AND expires_at <= NOW())
                OR
                (quota_bytes IS NOT NULL AND used_bytes >= quota_bytes)
              )
        FOR UPDATE
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut disabled = 0_usize;
    for row in &to_disable {
        // proxy_accounts.id is BIGINT UNSIGNED → u64 from macro.
        let is_expired = row.is_expired != 0;
        let over_quota = row.over_quota != 0;
        let reason = match (is_expired, over_quota) {
            (true, _) => "expired",
            (_, true) => "over_quota",
            _ => "unknown",
        };
        tracing::info!(account = %row.username, reason, "disabling at {}", Utc::now());
        sqlx::query!(
            r#"UPDATE proxy_accounts SET enabled = 0, updated_at = NOW() WHERE id = ?"#,
            row.id,
        )
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
