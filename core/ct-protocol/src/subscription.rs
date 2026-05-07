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
        assert!(
            !s.contains("signature"),
            "signature should be omitted when None: {s}"
        );
    }

    // Round-11 data-integrity: the canonical the server signs MUST
    // round-trip through (deserialise → set signature=None →
    // re-serialise) without changing bytes. If those bytes differ,
    // every client that follows the documented verify-by-stripping-
    // signature flow rejects manifests this server emits — a silent
    // protocol break.
    //
    // The two traps we anchor here:
    //   (a) Optional fields with skip_if_none must NOT round-trip
    //       through `"key":null`. A server that emits `"note":null`
    //       in the canonical produces bytes the Rust client cannot
    //       reproduce on re-canonicalisation (the field disappears
    //       entirely on re-serialise → divergent bytes).
    //   (b) Field declaration order in the struct equals on-the-
    //       wire order. The server-side encoder (PHP, Go, etc.)
    //       must emit fields in this order or canonicals diverge.
    //
    // Both traps caught a real PHP-side bug; this test pins the
    // contract on the spec side so a future struct-field reorder
    // or skip_if_none removal is caught here too.
    #[test]
    fn canonical_roundtrips_under_signature_strip() {
        // A served manifest looks like: deserialise carries
        // signature: Some("..."). The verification flow clones,
        // sets signature to None, and re-serialises. Those bytes
        // must equal what the SERVER signed, byte-for-byte.
        let served = SubscriptionManifestV1 {
            version: 1,
            server: "proxy.example.com".into(),
            profiles: alloc::vec![ProfileV1 {
                host: "proxy.example.com".into(),
                port: 443,
                username: "alice".into(),
                password: "secret".into(),
                label: Some("proxy.example.com (alice)".into()),
            }],
            capabilities: ServerCapabilitiesV1 {
                anti_tracking: alloc::vec![AntiTrackingFeature::HideIp],
                http3: false,
                fake_site_slug: None, // omitted on the wire
            },
            issued_at: 1000,
            expires_at: 2000,
            note: None,                                   // omitted on the wire
            signature: Some("deadbeef".repeat(8).into()), // 64-hex-char placeholder
        };

        // Server-side: build the canonical the way the PHP
        // controller does — same struct with signature=None.
        let server_canonical_struct = SubscriptionManifestV1 {
            signature: None,
            ..served.clone()
        };
        let server_canonical = serde_json::to_string(&server_canonical_struct).unwrap();

        // Client-side: deserialise the served body, strip
        // signature, re-serialise.
        let served_json = serde_json::to_string(&served).unwrap();
        let mut from_wire: SubscriptionManifestV1 = serde_json::from_str(&served_json).unwrap();
        from_wire.signature = None;
        let client_canonical = serde_json::to_string(&from_wire).unwrap();

        assert_eq!(
            server_canonical, client_canonical,
            "canonical bytes diverge between server (build-with-signature-None) and \
             client (deserialise + signature=None + re-serialise) — every HMAC \
             verification will fail"
        );

        // Spot-check the absence of the dropped optional fields
        // (catches a future skip_if_none removal that would cause
        // null-leakage on the wire).
        assert!(
            !server_canonical.contains("\"note\""),
            "note must be omitted when None: {server_canonical}"
        );
        assert!(
            !server_canonical.contains("\"signature\""),
            "signature must be omitted when None: {server_canonical}"
        );
        assert!(
            !server_canonical.contains("\"fake_site_slug\""),
            "fake_site_slug must be omitted when None: {server_canonical}"
        );
    }

    // Field declaration order is part of the wire contract —
    // serde emits struct fields in declaration order. A reorder
    // here breaks every server that builds the canonical without
    // re-deriving from this struct (the PHP controller, for one,
    // hard-codes the order in its array literal). This test pins
    // the order so a careless edit fails CI.
    #[test]
    fn field_order_is_part_of_the_wire_contract() {
        let m = SubscriptionManifestV1 {
            version: 1,
            server: "s".into(),
            profiles: alloc::vec![],
            capabilities: ServerCapabilitiesV1 {
                anti_tracking: alloc::vec![],
                http3: false,
                fake_site_slug: None,
            },
            issued_at: 1,
            expires_at: 2,
            note: Some("n".into()),
            signature: Some("sig".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        // Find each key's position; keys must appear in the
        // exact order: version, server, profiles, capabilities,
        // issued_at, expires_at, note, signature.
        let order = [
            "\"version\"",
            "\"server\"",
            "\"profiles\"",
            "\"capabilities\"",
            "\"issued_at\"",
            "\"expires_at\"",
            "\"note\"",
            "\"signature\"",
        ];
        let mut last_pos = 0;
        for (i, key) in order.iter().enumerate() {
            let pos = s
                .find(key)
                .unwrap_or_else(|| panic!("expected key {key} in serialised manifest, got {s}"));
            assert!(
                pos >= last_pos,
                "field order violated at position {i} ({key}): full output = {s}"
            );
            last_pos = pos;
        }
    }
}
