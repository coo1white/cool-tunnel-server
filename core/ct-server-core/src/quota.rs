// SPDX-License-Identifier: AGPL-3.0-only
//! Expiry enforcer. Disables proxy_accounts whose expires_at is in
//! the past.
//!
//! Per-byte quota enforcement (used_bytes >= quota_bytes) is a v0.1
//! roadmap item: until metrics::collect emits per-user traffic counts
//! from sing-box, used_bytes never increments and any "over quota"
//! branch is dead code. (R3-2 + R4-4, docs/audits/2026-05-04T06-31-58Z.md.)
//! When per-user metrics land, re-introduce the
//! `(quota_bytes IS NOT NULL AND used_bytes >= quota_bytes)` predicate
//! here and the `over_quota` arm in the disable loop.
//!
//! If any account changed state, re-render the sing-box config and
//! hot-reload via the clash API so the new `users` array (with the
//! disabled accounts removed) takes effect immediately.
//!
//! Robustness: SELECT-the-candidates and the per-row UPDATEs run
//! inside a single transaction. Without that, an operator
//! re-enabling an account in the panel between our SELECT and the
//! matching UPDATE would have their re-enable silently overwritten
//! by our concurrent disable. The transaction is short (typically
//! 0-3 rows) so it doesn't hold locks for any perceivable time.

use crate::{admin, singbox, Result};
use chrono::Utc;
use sqlx::MySqlPool;

pub async fn enforce(
    pool: &MySqlPool,
    template: &str,
    output: &str,
    admin_url: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;

    // Find expired accounts to disable. SELECT ... FOR UPDATE locks
    // the matching rows so a concurrent panel save can't flip
    // `enabled` back on between our SELECT and the per-row UPDATE
    // below. Compile-time-checked SQL via sqlx::query!.
    let to_disable = sqlx::query!(
        r#"
        SELECT id, username
        FROM proxy_accounts
        WHERE enabled = 1
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        FOR UPDATE
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut disabled = 0_usize;
    for row in &to_disable {
        tracing::info!(account = %row.username, reason = "expired", "disabling at {}", Utc::now());
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
        singbox::render(pool, template, output, false, false).await?;
        let secret = singbox::current_clash_secret().await?;
        let admin_client = admin::ClashAdmin::new(admin_url, &secret);
        if let Err(e) = admin_client.reload(output).await {
            tracing::warn!(error = %e, "reload after quota enforcement failed");
        } else {
            reloaded = true;
        }
    }

    println!("{}", outcome_json(disabled, reloaded));
    Ok(())
}

/// Serialise the enforce-outcome to the JSON shape the PHP panel
/// reads (`panel/app/Console/Commands/QuotaEnforce.php:21-22`
/// reads `$out['disabled']` + `$out['reload_triggered']`). Pulled
/// out as a free function so the field names can be pinned by a
/// unit test without spinning up a DB. Round-17 chassis-cockpit
/// boundary.
fn outcome_json(disabled: usize, reloaded: bool) -> String {
    format!(r#"{{"disabled": {disabled}, "reload_triggered": {reloaded}}}"#)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn outcome_json_pins_php_visible_keys() {
        let s = outcome_json(2, true);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("disabled").is_some(), "panel reads `disabled`: {s}");
        assert!(
            v.get("reload_triggered").is_some(),
            "panel reads `reload_triggered`: {s}"
        );
        assert_eq!(v["disabled"], 2);
        assert_eq!(v["reload_triggered"], true);
    }

    #[test]
    fn outcome_json_zero_disabled_emits_false_for_reload() {
        // The (disabled=0, reloaded=false) branch is the common
        // happy path (no expiry hit this tick). Pin the wire
        // values so an accidental tristate (e.g. `Option<bool>`)
        // doesn't leak `null` to the panel.
        let s = outcome_json(0, false);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["disabled"], 0);
        assert_eq!(v["reload_triggered"], false);
    }
}
