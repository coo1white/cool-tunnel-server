// JSON wire types for the panel ↔ ct-server-core daemon channel.
//
// Same shape as the macOS client's Request/Response/Event split, so
// future cross-platform clients can reuse the dispatch idiom.
//
// Transport on the server is a unix socket (`/run/cool-tunnel/core.sock`);
// transport in clients is platform-specific (stdio for macOS, JNI bridge
// for Android, IPC for Windows). The framing is one JSON object per line,
// no length prefix.

use alloc::string::String;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireRequestV1 {
    /// Re-render Caddyfile from the current DB state. Returns the
    /// new SHA-256 (or null if unchanged).
    RenderCaddyfile,
    /// POST the rendered Caddyfile to Caddy's admin API.
    ReloadCaddy,
    /// Pull metrics + roll deltas into `traffic_logs`.
    CollectTraffic,
    /// Disable accounts past quota / expiry; re-render + reload if
    /// any changes.
    EnforceQuota,
    /// Active anti-tracking probe. Returns which mitigations the
    /// outside actually sees.
    ProbeAntiTracking,
    /// Health check — every dependency reachable?
    Health,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireResponseV1 {
    Ok,
    CaddyfileRendered {
        hash: Option<String>,
        bytes: usize,
        accounts: usize,
    },
    CaddyReloaded {
        duration_ms: u64,
    },
    TrafficCollected {
        rows: usize,
        total_bytes: u64,
    },
    QuotaEnforced {
        disabled: usize,
        reload_triggered: bool,
    },
    AntiTrackingProbe {
        hide_ip_effective: bool,
        hide_via_effective: bool,
        probe_resistance_effective: bool,
    },
    HealthOk,
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireEventV1 {
    /// A reload landed; the panel can refresh its "last reloaded"
    /// timestamp without polling.
    CaddyReloaded { hash: String },
    /// An account hit its quota and was disabled.
    AccountDisabled {
        id: i64,
        username: String,
        reason: String,
    },
    /// The daemon is shutting down (graceful).
    Shutdown,
}
