// SubscriptionManifestV1 emitter — reads a single proxy_account +
// server_config from the DB and prints the JSON manifest that any
// platform's client can fetch via /api/v1/subscription.
//
// Signing: the panel takes the JSON we emit, computes an
// HMAC-SHA-256 over the canonical body (with `signature` set to
// null), splices the hex digest into the body's `signature`
// field, and serves the result. There are NO project-identifying
// custom HTTP headers on the response (anti-fingerprinting). We
// don't sign here — keeping signing in the panel keeps the secret
// out of the Rust process, which is good defense-in-depth.

use crate::{db, Error, Result};
use ct_protocol::{
    AntiTrackingFeature, ProfileV1, ServerCapabilitiesV1, SubscriptionManifestV1, PROTOCOL_VERSION,
};
use sqlx::MySqlPool;
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn emit(pool: &MySqlPool, account_id: i64) -> Result<()> {
    let cfg = db::server_config(pool).await?;

    // Note: we deliberately fetch even *disabled* accounts — the
    // operator might want to issue a manifest, then disable the
    // account, then re-enable later; the manifest is for the same
    // username so that's fine. The proxy itself enforces enabled-ness
    // via the sing-box config's `users` array — disabled accounts
    // are filtered out at render time in singbox::render().
    // proxy_accounts.id is BIGINT UNSIGNED — bind u64.
    let id_u: u64 = account_id.max(0) as u64;
    let row = sqlx::query!(
        r#"
        SELECT username, password_hash
        FROM proxy_accounts
        WHERE id = ?
        "#,
        id_u,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| Error::msg(format!("no proxy_account with id={account_id}")))?;

    let username = row.username;
    // We cannot include the cleartext password in the manifest —
    // we never stored it. The manifest carries the *bcrypt hash*
    // wrapped as a single-use token; the panel decorates this row
    // with a freshly-generated cleartext during the rotation flow.
    // For v0.0.1, we expect the panel to call this only inside a
    // rotation transaction so it has the cleartext on hand and can
    // splice it into the emitted JSON before signing. So this
    // command emits a *placeholder* password that the panel must
    // replace.
    let _ = row.password_hash; // unused for now; panel splices cleartext

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut features = Vec::new();
    if cfg.hide_ip {
        features.push(AntiTrackingFeature::HideIp);
    }
    if cfg.hide_via {
        features.push(AntiTrackingFeature::HideVia);
    }
    if cfg.probe_resistance {
        features.push(AntiTrackingFeature::ProbeResistance);
    }
    if !cfg.doh_resolver.is_empty() {
        features.push(AntiTrackingFeature::DohResolver);
    }
    // HTTP/3 is intentionally NOT advertised here regardless of
    // the DB toggle. NaiveProxy is HTTP/2-only at the protocol
    // level — sing-box's `naive` inbound does not serve QUIC.
    // Advertising true would lead clients to attempt HTTP/3, fail
    // (no UDP listener), and fall back — a recognisable network
    // fingerprint. The DB column survives for forward-compat in
    // case a future protocol pivot adds genuine QUIC support.

    let manifest = SubscriptionManifestV1 {
        version: PROTOCOL_VERSION,
        server: cfg.domain.clone(),
        profiles: vec![ProfileV1 {
            host: cfg.domain.clone(),
            port: 443,
            username: username.clone(),
            password: "{{CLEARTEXT_PLACEHOLDER}}".into(),
            label: Some(format!("{} ({username})", cfg.domain)),
        }],
        capabilities: ServerCapabilitiesV1 {
            anti_tracking: features,
            http3: false,
            fake_site_slug: None,
        },
        issued_at: now,
        expires_at: now + 60 * 60 * 24 * 30, // 30 days
        note: Some(
            "The password field is a placeholder — the panel must \
             splice in the cleartext before signing and serving."
                .into(),
        ),
        signature: None,
    };

    println!("{}", serde_json::to_string_pretty(&manifest)?);
    Ok(())
}
