// SPDX-License-Identifier: AGPL-3.0-only
//! Validated value types shared across modules.
//!
//! Mirrors the structure of the macOS client's `core/src/domain/`:
//! constructor-validated structs whose invariants the rest of the
//! codebase can rely on without re-checking.
//!
//! v0.4.0 — the v0.3.x ProxyAccount and UsageDelta types were
//! deleted alongside the modules that constructed them
//! (`db::active_proxy_accounts` + `metrics::collect`, both retired
//! when sing-box VLESS+Reality replaced the clash-API-bearing naive
//! stack). The panel-side equivalent of ProxyAccount lives in
//! `panel/app/Models/ProxyAccount.php`; per-user accounting moves
//! to operator-side instrumentation.

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
    pub last_caddyfile_hash: Option<String>,
    pub last_rendered_at: Option<DateTime<Utc>>,
}
