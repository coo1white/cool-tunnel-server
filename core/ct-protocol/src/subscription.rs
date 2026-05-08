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

    /// Unix timestamp the manifest was issued. The replay-resistance
    /// window is `FRESHNESS_WINDOW_SECONDS` (7 days) measured from
    /// this value; see `Self::check_freshness` for the canonical
    /// time-bounds check.
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

/// Outcome of `SubscriptionManifestV1::check_freshness`. Distinguishes
/// the three interesting reject reasons so a client can surface the
/// right error to the user (the operator-meaningful difference
/// between "your URL has been intercepted and replayed" and "your
/// app is offline and the manifest aged out").
///
/// Round-13 time-and-clock audit: pre-v0.0.59 the docstring on
/// `issued_at` claimed "Clients refuse manifests older than 7 days
/// as a freshness guard," but no implementation existed in the
/// crate. The first client to follow the spec would either invent
/// its own check (drift between implementations) or skip it
/// (defeats the freshness contract). This function is the single
/// source of truth for both bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreshnessCheck {
    /// `now < issued_at`. The manifest was created in the future
    /// relative to the client's clock — either the server clock
    /// jumped or the client's clock did. Clients should refuse
    /// rather than treat as "fresh by virtue of being recent."
    IssuedInFuture { issued_at: u64, now: u64 },
    /// `now > issued_at + 7 days`. The manifest is older than the
    /// freshness window even if it has not yet hit `expires_at`.
    /// This bounds replay attacks: a captured manifest is usable
    /// for at most 7 days regardless of the server-issued
    /// `expires_at`. Suggested client UX: re-fetch the
    /// subscription URL.
    StaleByIssuedAt { age_seconds: u64 },
    /// `now > expires_at`. The manifest reached its server-issued
    /// expiry. Clients should re-fetch.
    ExpiredByExpiresAt { expired_seconds_ago: u64 },
    /// Inside both bounds.
    Fresh,
}

impl SubscriptionManifestV1 {
    /// Replay-resistance window applied on top of `expires_at`. A
    /// captured manifest is rejected after this many seconds
    /// regardless of the server-issued expiry. Picked at the spec
    /// level so every client agrees. Round-13 time-and-clock audit.
    pub const FRESHNESS_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

    /// Time-bounds check. Pure function — caller passes the current
    /// time so this is testable and works in `no_std` (the crate
    /// is `#![no_std]`).
    ///
    /// Bounds:
    ///   - `issued_at <= now`               (no future-dated manifests)
    ///   - `now <= issued_at + 7 days`      (replay window)
    ///   - `now <= expires_at`              (server expiry)
    ///
    /// All three must hold; the function returns the FIRST violation
    /// it finds in that order, so a client can surface the most
    /// specific error.
    pub fn check_freshness(&self, now: u64) -> FreshnessCheck {
        if now < self.issued_at {
            return FreshnessCheck::IssuedInFuture {
                issued_at: self.issued_at,
                now,
            };
        }
        let age = now - self.issued_at;
        if age > Self::FRESHNESS_WINDOW_SECONDS {
            return FreshnessCheck::StaleByIssuedAt { age_seconds: age };
        }
        if now > self.expires_at {
            return FreshnessCheck::ExpiredByExpiresAt {
                expired_seconds_ago: now - self.expires_at,
            };
        }
        FreshnessCheck::Fresh
    }
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
            signature: Some("deadbeef".repeat(8)), // 64-hex-char placeholder
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

    fn manifest_with_times(issued_at: u64, expires_at: u64) -> SubscriptionManifestV1 {
        SubscriptionManifestV1 {
            version: 1,
            server: "s".into(),
            profiles: alloc::vec![],
            capabilities: ServerCapabilitiesV1 {
                anti_tracking: alloc::vec![],
                http3: false,
                fake_site_slug: None,
            },
            issued_at,
            expires_at,
            note: None,
            signature: None,
        }
    }

    // Round-13 time-and-clock: the freshness check the docstring
    // promised has to actually work. These tests pin the THREE
    // distinguishable failure modes plus the happy path, so the
    // first client implementer can rely on the contract.

    #[test]
    fn freshness_check_accepts_inside_window() {
        // Issued 1 hour ago, expires in 30 days. now is right now.
        let m = manifest_with_times(10_000, 10_000 + 30 * 24 * 60 * 60);
        let now = 10_000 + 60 * 60;
        assert_eq!(m.check_freshness(now), FreshnessCheck::Fresh);
    }

    #[test]
    fn freshness_check_rejects_future_dated_manifest() {
        // Server clock raced ahead, or client clock is behind.
        // issued_at > now must be a hard reject — otherwise an
        // attacker who can set issued_at into the future would get
        // a manifest that "ages" out of the freshness window only
        // FROM THE FUTURE, effectively immortalising it.
        let m = manifest_with_times(10_000, 10_000 + 30 * 24 * 60 * 60);
        let now = 9_500; // 500s before issued_at
        match m.check_freshness(now) {
            FreshnessCheck::IssuedInFuture { issued_at, now: n } => {
                assert_eq!(issued_at, 10_000);
                assert_eq!(n, 9_500);
            }
            other => panic!("expected IssuedInFuture, got {other:?}"),
        }
    }

    #[test]
    fn freshness_check_rejects_stale_by_issued_at() {
        // Manifest is 8 days old. Even though expires_at is 30 days
        // from issued_at, the replay-resistance window cuts in at
        // 7 days. This is the spec's anti-replay guarantee.
        let m = manifest_with_times(10_000, 10_000 + 30 * 24 * 60 * 60);
        let now = 10_000 + 8 * 24 * 60 * 60;
        match m.check_freshness(now) {
            FreshnessCheck::StaleByIssuedAt { age_seconds } => {
                assert_eq!(age_seconds, 8 * 24 * 60 * 60);
            }
            other => panic!("expected StaleByIssuedAt, got {other:?}"),
        }
    }

    #[test]
    fn freshness_check_rejects_at_exact_window_plus_one() {
        // Boundary: ON the 7-day mark is still fresh (the rule is
        // STRICTLY greater); one second past is stale. Pin this so
        // a future "use >= instead of >" change is caught.
        let m = manifest_with_times(0, 30 * 24 * 60 * 60);
        let on_window = SubscriptionManifestV1::FRESHNESS_WINDOW_SECONDS;
        assert_eq!(m.check_freshness(on_window), FreshnessCheck::Fresh);
        assert!(matches!(
            m.check_freshness(on_window + 1),
            FreshnessCheck::StaleByIssuedAt { age_seconds: _ }
        ));
    }

    #[test]
    fn freshness_check_rejects_expired_inside_freshness_window() {
        // Operator issued a SHORT-lived manifest (e.g. expires_at
        // 1 day from issued_at). At day 2 the manifest has expired
        // even though it is still inside the 7-day freshness
        // window. The expiry check fires SECOND in priority, so
        // the test confirms the order.
        let m = manifest_with_times(0, 24 * 60 * 60); // expires after 1 day
        let now = 2 * 24 * 60 * 60;
        match m.check_freshness(now) {
            FreshnessCheck::ExpiredByExpiresAt {
                expired_seconds_ago,
            } => {
                assert_eq!(expired_seconds_ago, 24 * 60 * 60);
            }
            other => panic!("expected ExpiredByExpiresAt, got {other:?}"),
        }
    }

    // Round-14 input-boundary: the cross-encoder canonical form
    // depends on PHP's `JSON_UNESCAPED_UNICODE` and Rust's
    // serde_json default emitting bytewise-identical UTF-8 for
    // non-ASCII input. Pre-this an audit verified empirically
    // they match — but a future serde_json default flip (e.g. an
    // `escape_non_ascii` flag becoming default-on) would silently
    // diverge canonicalisations: PHP emits `"héllo"` raw, Rust
    // emits `"héllo"` escaped → 13 bytes vs 17 bytes →
    // different HMAC → every Chinese/Japanese/Korean username
    // breaks verification. Pin the contract on the spec side.
    //
    // Equivalent PHP reference output (with the controller's flags
    // `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`) for the
    // same input:
    //
    //   $body = ['password' => 'héllo Zürich'];
    //   json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
    //   → {"password":"héllo Zürich"}
    //
    // If this test starts failing because serde_json changed
    // default behaviour, the PHP controller's encode flags need
    // a corresponding adjustment — not the test.
    #[test]
    fn unicode_passwords_round_trip_byte_identical_to_php_unescaped() {
        // A profile carrying a non-ASCII password — realistic for
        // operators who accept user-chosen passwords or who set
        // labels in their own language.
        let profile = ProfileV1 {
            host: "p.example".into(),
            port: 443,
            username: "alice".into(),
            password: "héllo Zürich".into(),
            label: Some("プロキシ".into()), // Japanese
        };
        let s = serde_json::to_string(&profile).unwrap();

        // Raw UTF-8 bytes for `héllo Zürich` and `プロキシ` must
        // be present without `\uXXXX` escapes.
        assert!(
            s.contains("héllo Zürich"),
            "expected raw UTF-8 password; got {s}"
        );
        assert!(s.contains("プロキシ"), "expected raw UTF-8 label; got {s}");
        assert!(
            !s.contains("\\u00e9"),
            "must NOT escape `é` to \\u00e9 — would diverge from PHP \
             JSON_UNESCAPED_UNICODE: {s}"
        );
        assert!(
            !s.contains("\\u30D7"),
            "must NOT escape `プ` to \\u30D7 — would diverge from PHP: {s}"
        );
    }

    // Forward-slash handling is the OTHER cross-encoder gotcha:
    // PHP defaults to escaping `/` to `\/`; we explicitly use
    // `JSON_UNESCAPED_SLASHES` to match Rust serde_json's default
    // (raw `/`). If a future serde_json flip ever escapes
    // forward-slashes by default, every URL-bearing label
    // (`https://...`) in the manifest would diverge.
    #[test]
    fn forward_slashes_emit_raw_not_escaped() {
        let profile = ProfileV1 {
            host: "p.example".into(),
            port: 443,
            username: "alice".into(),
            password: "p".into(),
            label: Some("https://docs.example.com/help".into()),
        };
        let s = serde_json::to_string(&profile).unwrap();
        assert!(
            s.contains("https://docs.example.com/help"),
            "expected raw `/`; got {s}"
        );
        assert!(
            !s.contains("\\/"),
            "must NOT escape `/` to `\\/` — would diverge from PHP \
             JSON_UNESCAPED_SLASHES: {s}"
        );
    }
}
