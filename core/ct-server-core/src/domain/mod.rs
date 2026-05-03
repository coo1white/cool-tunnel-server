// Validated value types shared across modules.
//
// Mirrors the structure of the macOS client's `core/src/domain/`:
// constructor-validated structs whose invariants the rest of the
// codebase can rely on without re-checking.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: i64,
    pub domain: String,
    pub acme_email: String,
    pub acme_directory: String,
    pub hide_ip: bool,
    pub hide_via: bool,
    pub probe_resistance: bool,
    pub doh_resolver: String,
    pub http3_enabled: bool,
    pub admin_basic_auth_user: Option<String>,
    pub admin_basic_auth_hash: Option<String>,
    pub last_caddyfile_hash: Option<String>,
    pub last_rendered_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyAccount {
    pub id: i64,
    pub username: String,
    /// bcrypt hash — preserved for audit / legacy tooling. sing-box
    /// itself reads the cleartext field below.
    pub password_hash: String,
    /// Cleartext password, decrypted from the Laravel-encrypted DB
    /// column at db-read time. None for legacy rows that haven't
    /// been re-saved since the sing-box migration; the panel forces
    /// a regen on first save so this is a transitional state only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleartext_password: Option<String>,
    pub enabled: bool,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub expires_at: Option<DateTime<Utc>>,
}

impl ProxyAccount {
    /// Reject usernames that would break basic_auth syntax (whitespace,
    /// quotes, control chars). The panel pre-validates with `alphaDash`,
    /// but we re-check here so a malformed row in the DB can't take
    /// the proxy down. Method name dates back to the Caddyfile era;
    /// kept for historical continuity — applies to sing-box too.
    pub fn caddyfile_safe_username(&self) -> bool {
        !self.username.is_empty()
            && self.username.len() <= 64
            && self
                .username
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageDelta {
    pub uplink: i64,
    pub downlink: i64,
    pub connections: i64,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn account(name: &str) -> ProxyAccount {
        ProxyAccount {
            id: 1,
            username: name.into(),
            password_hash: "$2y$10$x".into(),
            cleartext_password: None,
            enabled: true,
            quota_bytes: None,
            used_bytes: 0,
            expires_at: None,
        }
    }

    #[test]
    fn safe_username_accepts_normal_alpha_digit_dash_dot_underscore() {
        for u in ["alice", "bob123", "user_name", "a-b", "a.b", "A.B_c-d.0"] {
            assert!(account(u).caddyfile_safe_username(), "{u} should be safe");
        }
    }

    #[test]
    fn safe_username_rejects_empty_or_oversize() {
        assert!(!account("").caddyfile_safe_username());
        // 65 chars > limit of 64
        let long: String = "a".repeat(65);
        assert!(!account(&long).caddyfile_safe_username());
    }

    #[test]
    fn safe_username_rejects_dangerous_chars() {
        for u in [
            "alice space",
            "alice\nb",
            "alice\tb",
            "alice@host",
            "alice/path",
            "alice'quote",
            "alice\"quote",
            "alice;rm",
            "alice$inject",
            "alice\\\\back",
        ] {
            assert!(
                !account(u).caddyfile_safe_username(),
                "{u} must be rejected"
            );
        }
    }

    #[test]
    fn safe_username_accepts_max_length() {
        let max: String = "a".repeat(64);
        assert!(account(&max).caddyfile_safe_username());
    }
}
