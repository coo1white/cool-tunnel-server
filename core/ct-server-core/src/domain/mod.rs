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
    pub password_hash: String,
    pub enabled: bool,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub expires_at: Option<DateTime<Utc>>,
}

impl ProxyAccount {
    /// Reject usernames that would break Caddyfile syntax (whitespace,
    /// quotes, control chars). The panel pre-validates with `alphaDash`,
    /// but we re-check here so a malformed row in the DB can't take
    /// Caddy down.
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
