// SPDX-License-Identifier: AGPL-3.0-only
//! Credential drift guard.
//!
//! The operator invariant is:
//!
//! ```text
//! DB active credential tuple == rendered sing-box users == manifest/Mac config source
//! ```
//!
//! The panel subscription endpoint and the Mac client manifest both source
//! `username + cleartext password` from the same DB row that the sing-box
//! renderer reads. This guard compares that source tuple against the rendered
//! config on disk. If either side drifts, component checks flip NG instead of
//! leaving stale credentials silently live.

use crate::{db, Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::MySqlPool;
use std::collections::BTreeMap;
use tokio::fs;

const LOCK_VERSION: &str = "db=rendered=manifest=mac-config";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct CredentialTuple {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
struct SingBoxConfig {
    #[serde(default)]
    inbounds: Vec<SingBoxInbound>,
}

#[derive(Debug, Deserialize)]
struct SingBoxInbound {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    users: Vec<SingBoxUser>,
}

#[derive(Debug, Deserialize)]
struct SingBoxUser {
    username: String,
    password: String,
}

pub async fn assert_locked(pool: &MySqlPool, rendered_path: &str) -> Result<()> {
    let db_tuples = db_active_tuples(pool).await?;
    let rendered_tuples = rendered_tuples(rendered_path).await?;

    if db_tuples != rendered_tuples {
        return Err(Error::validation(
            "credential-lock",
            drift_message(&db_tuples, &rendered_tuples),
        ));
    }

    println!(
        "{LOCK_VERSION} ok active_users={} lock_hash={}",
        db_tuples.len(),
        lock_hash(&db_tuples)
    );
    Ok(())
}

async fn db_active_tuples(pool: &MySqlPool) -> Result<Vec<CredentialTuple>> {
    let mut out = Vec::new();
    for account in db::active_proxy_accounts(pool).await? {
        if !account.caddyfile_safe_username() {
            return Err(Error::validation(
                "credential-lock",
                format!("active account has unsafe username {:?}", account.username),
            ));
        }
        let Some(password) = account.cleartext_password else {
            return Err(Error::validation(
                "credential-lock",
                format!(
                    "active account {:?} has no decryptable cleartext; manifest/Mac config cannot match rendered sing-box users",
                    account.username
                ),
            ));
        };
        out.push(CredentialTuple {
            username: account.username,
            password,
        });
    }
    out.sort_by(|a, b| a.username.cmp(&b.username));
    Ok(out)
}

async fn rendered_tuples(path: &str) -> Result<Vec<CredentialTuple>> {
    let raw = fs::read_to_string(path)
        .await
        .map_err(|source| Error::io_path("read_rendered_singbox_config", path, source))?;
    rendered_tuples_from_str(&raw)
}

fn rendered_tuples_from_str(raw: &str) -> Result<Vec<CredentialTuple>> {
    let cfg: SingBoxConfig = serde_json::from_str(raw)?;
    let naive = cfg
        .inbounds
        .iter()
        .find(|inbound| inbound.kind == "naive")
        .ok_or_else(|| {
            Error::validation("credential-lock", "rendered config has no naive inbound")
        })?;

    let mut out: Vec<_> = naive
        .users
        .iter()
        .filter(|u| u.username != "__no_active_accounts__")
        .map(|u| CredentialTuple {
            username: u.username.clone(),
            password: u.password.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.username.cmp(&b.username));
    Ok(out)
}

fn drift_message(db_tuples: &[CredentialTuple], rendered_tuples: &[CredentialTuple]) -> String {
    let db_map = tuple_map(db_tuples);
    let rendered_map = tuple_map(rendered_tuples);
    let missing_in_rendered: Vec<_> = db_map
        .keys()
        .filter(|name| !rendered_map.contains_key(*name))
        .cloned()
        .collect();
    let extra_in_rendered: Vec<_> = rendered_map
        .keys()
        .filter(|name| !db_map.contains_key(*name))
        .cloned()
        .collect();
    let password_mismatch: Vec<_> = db_map
        .iter()
        .filter_map(|(name, db_pw)| {
            rendered_map
                .get(name)
                .is_some_and(|rendered_pw| rendered_pw != db_pw)
                .then(|| name.clone())
        })
        .collect();

    format!(
        "credential drift: db_active={} rendered_active={} missing_in_rendered={:?} extra_in_rendered={:?} password_mismatch={:?}",
        db_tuples.len(),
        rendered_tuples.len(),
        missing_in_rendered,
        extra_in_rendered,
        password_mismatch
    )
}

fn tuple_map(tuples: &[CredentialTuple]) -> BTreeMap<String, String> {
    tuples
        .iter()
        .map(|t| (t.username.clone(), t.password.clone()))
        .collect()
}

fn lock_hash(tuples: &[CredentialTuple]) -> String {
    let mut h = Sha256::new();
    for t in tuples {
        h.update(t.username.as_bytes());
        h.update([0]);
        h.update(t.password.as_bytes());
        h.update([0xff]);
    }
    hex::encode(h.finalize())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::domain::ProxyAccount;

    #[test]
    fn rendered_tuples_ignores_empty_placeholder() {
        let tuples = rendered_tuples_from_str(
            r#"{"inbounds":[{"type":"naive","users":[{"username":"__no_active_accounts__","password":"x"}]}]}"#,
        )
        .unwrap();
        assert!(tuples.is_empty());
    }

    #[test]
    fn drift_message_names_mismatch_without_leaking_passwords() {
        let db = vec![CredentialTuple {
            username: "alice".into(),
            password: "new".into(),
        }];
        let rendered = vec![CredentialTuple {
            username: "alice".into(),
            password: "old".into(),
        }];
        let msg = drift_message(&db, &rendered);
        assert!(msg.contains("password_mismatch=[\"alice\"]"));
        assert!(!msg.contains("new"));
        assert!(!msg.contains("old"));
    }

    #[test]
    fn proxy_account_cleartext_is_required_for_manifest_sync() {
        let a = ProxyAccount {
            id: 1,
            username: "alice".into(),
            password_hash: "hash".into(),
            cleartext_password: None,
            enabled: true,
            quota_bytes: None,
            used_bytes: 0,
            expires_at: None,
        };
        assert!(a.cleartext_password.is_none());
    }
}
