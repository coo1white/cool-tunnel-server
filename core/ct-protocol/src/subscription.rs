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
// Signature: HMAC-SHA-256 of the canonical JSON body with the
// `signature` field set to null. The server splices the resulting
// hex digest back into the same field. Clients verify by setting
// `signature` to null, re-serialising in canonical form, and
// checking the HMAC matches the spliced value. No custom HTTP
// headers — the response looks like any other authenticated JSON
// API on the wire (anti-fingerprinting). v0.0.8 and earlier used
// `X-CT-Signature` / `X-CT-Protocol` response headers; those are
// gone — clients targeting v0.0.9+ MUST read the body field.

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

    /// Free-form operator note ("hot-spare server in Tokyo").
    /// Optional; surfaced in client UI when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,

    /// HMAC-SHA-256 of the canonical JSON body with this field set
    /// to None / null. Hex-encoded. None on outbound when the
    /// server is constructing the body to sign; populated when
    /// serving. Clients re-verify by clearing this back to None
    /// and re-canonicalising.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
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
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
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
                // NaiveProxy is HTTP/2-only; manifests always advertise
                // false (advertising true would lead clients to attempt
                // QUIC, fail, fall back — a fingerprintable network
                // pattern). See SubscriptionController docstring.
                http3: false,
                fake_site_slug: Some("minimal-blog".into()),
            },
            issued_at: 0,
            expires_at: 0,
            note: None,
            signature: Some("0011223344".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        let m2: SubscriptionManifestV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(m, m2);
    }

    #[test]
    fn signature_field_is_skipped_when_none() {
        let m = SubscriptionManifestV1 {
            version: 1,
            server: "p.example".into(),
            profiles: alloc::vec![],
            capabilities: ServerCapabilitiesV1 {
                anti_tracking: alloc::vec![],
                http3: false,
                fake_site_slug: None,
            },
            issued_at: 0,
            expires_at: 0,
            note: None,
            signature: None,
        };
        let s = serde_json::to_string(&m).unwrap();
        // signature: None must NOT appear in the JSON — clients
        // canonicalise by setting signature to None before
        // re-serialising, so the field's absence is the contract.
        assert!(!s.contains("signature"), "signature should be omitted when None: {s}");
    }
}
