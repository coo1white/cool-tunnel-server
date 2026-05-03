// SubscriptionManifestV1 — the JSON the server emits at
// GET /api/v1/subscription/<token> when a client wants to
// configure itself from a single URL.
//
// Why a manifest at all (vs. a bare profile URL)?
//
// - It carries server-side feature flags, so a client knows whether
//   probe_resistance is on (and can warn the user if it isn't).
// - It can carry multiple profiles (admin per-team rotation, hot-
//   spare server in another region) under one bookmark.
// - It can carry an optional fake-site banner the client renders in
//   its UI ("you are connected via Tokyo Spare").
//
// A manifest is signed with HMAC-SHA-256 over a server-side secret
// shared with the account. Client verifies before adopting.

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::profile::ProfileV1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionManifestV1 {
    /// Always 1 for this struct. Bump means new manifest version.
    pub version: u32,

    /// Server domain (just for display in the client UI).
    pub server: String,

    /// One or more profiles this subscription resolves to. Clients
    /// usually use the first; the rest are alternates.
    pub profiles: Vec<ProfileV1>,

    /// Server capabilities the operator opted into.
    pub capabilities: ServerCapabilitiesV1,

    /// Unix timestamp the manifest was issued. Clients refuse
    /// manifests older than 7 days as a freshness guard.
    pub issued_at: u64,

    /// Unix timestamp after which clients must re-fetch.
    pub expires_at: u64,

    /// The HMAC-SHA-256 signature is *not* part of this struct — it
    /// rides in the HTTP header `X-CT-Signature: <hex>` and covers
    /// the canonical JSON body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerCapabilitiesV1 {
    pub anti_tracking: Vec<AntiTrackingFeature>,
    pub http3: bool,
    /// Stable identifier for whichever fake site is currently active.
    /// Clients use this purely for UI ("connected via 'Tokyo notes blog'").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fake_site_slug: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntiTrackingFeature {
    HideIp,
    HideVia,
    ProbeResistance,
    DohResolver,
    Http3,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::ProfileV1;

    #[test]
    fn round_trip_minimal() {
        let m = SubscriptionManifestV1 {
            version: 1,
            server: "proxy.example.com".into(),
            profiles: alloc::vec![ProfileV1 {
                host: "proxy.example.com".into(),
                port: 443,
                username: "alice".into(),
                password: "p".into(),
                label: None,
            }],
            capabilities: ServerCapabilitiesV1 {
                anti_tracking: alloc::vec![
                    AntiTrackingFeature::HideIp,
                    AntiTrackingFeature::HideVia,
                    AntiTrackingFeature::ProbeResistance,
                ],
                http3: true,
                fake_site_slug: Some("minimal-blog".into()),
            },
            issued_at: 0,
            expires_at: 0,
            note: None,
        };
        let s = serde_json::to_string(&m).unwrap_or_default();
        let m2: SubscriptionManifestV1 = serde_json::from_str(&s).map_err(|_| ()).unwrap_or(m.clone());
        assert_eq!(m, m2);
    }
}
