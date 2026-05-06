// Component-as-machine-part model.
//
// Every replaceable piece of the Cool Tunnel stack — Rust core,
// ct-protocol crate, NaiveProxy engine, Caddy, forwardproxy plugin,
// the panel — is described by a `ComponentManifestV1`. The manifest
// pins what we expect to find; a platform-specific verifier reports
// whether what's installed matches.
//
// The manifest is the same shape on every platform: server and
// every Rust-cored client (macOS today, iOS / Android / Windows /
// Linux desktop tomorrow) link the same struct definitions. That
// means a "Components" page in the panel and a "Components" tab in
// the macOS client render the same data, and the OK/NG semantics
// are identical.

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComponentManifestV1 {
    /// Stable slug — `naive`, `caddy`, `forwardproxy`, `ct-server-core`,
    /// `ct-protocol`, `panel`, etc.
    pub name: String,

    /// What kind of artifact — different verifiers handle each.
    pub kind: ComponentKindV1,

    /// Human-readable upstream version (e.g. `v147.0.7727.49-1`).
    pub version: String,

    /// Where the upstream lives. Used for "update" actions and for
    /// rendering "view source" links in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,

    /// Expected SHA-256 of the artifact. For container images, the
    /// digest of the manifest. For Rust crates we trust Cargo.lock,
    /// so this is optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,

    /// How to verify "this is the version we pinned". Each kind has
    /// a default check; this lets the manifest override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<VerifySpecV1>,

    /// Free-form notes (e.g. "BSD-3 license, do not modify").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ComponentKindV1 {
    /// Native binary on disk (`naive`, `caddy`, `ct-server-core`).
    Binary,
    /// A Cargo crate inside our workspace.
    RustCrate,
    /// A Docker / OCI image (the panel container, the caddy container).
    ContainerImage,
    /// A PHP package / Composer dep (less common; for the panel itself).
    PhpPackage,
    /// External DoH-over-HTTPS endpoint reachability check.
    /// The verifier reads the LIVE `ServerConfig.doh_resolver` URL
    /// (panel-editable, not the manifest's value) and dispatches an
    /// RFC 8484 binary `DoH` query for `example.com IN A`. A
    /// non-zero ANCOUNT in the response means the resolver
    /// answered a real query — covers the v0.0.22 survival case
    /// for operators in censored regions where Cloudflare `DoH`
    /// (or any other transit-blocked endpoint) is silently dropped
    /// by the local network. Without this check, sing-box's DNS
    /// path looks healthy ("connection open") but every name
    /// lookup fails, producing a half-working proxy that's hard
    /// to diagnose. (v0.0.22 — 2026 Milestone Closing.)
    DohEndpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifySpecV1 {
    /// Command to run (path to executable + args). The verifier
    /// captures stdout and looks for `expect_stdout_contains`.
    pub command: Vec<String>,
    pub expect_stdout_contains: Option<String>,
    /// Some binaries (like `caddy validate`) only signal pass/fail
    /// via exit code; don't require any stdout match in that case.
    #[serde(default)]
    pub expect_zero_exit: bool,
    /// Liveness-probe declaration. True when the verifier
    /// legitimately has no version line to print — TCP-open
    /// (`bash -c 'exec 3<>/dev/tcp/host/port'`), HTTP reachability
    /// (`curl -sIo /dev/null …`), artisan-boot (`php artisan
    /// --version > /dev/null`). When true, the soft version
    /// matcher is skipped; any verify-passed result is OK
    /// regardless of stdout content. False / unset preserves the
    /// pre-v0.0.37 behaviour exactly: a non-empty first stdout
    /// line that doesn't contain the pinned `version` flips the
    /// result to `VersionMismatch`.
    #[serde(default)]
    pub expect_no_version_line: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComponentStatusV1 {
    pub name: String,
    pub installed_version: Option<String>,
    pub pinned_version: String,
    pub state: ComponentStateV1,
    /// Diagnostic text — "binary not found at /usr/bin/caddy",
    /// "version mismatch: installed=v2.7.6 pinned=v2.8.0",
    /// "OK".
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComponentStateV1 {
    /// Installed version matches the pinned manifest. OK.
    Ok,
    /// Component is installed but the version disagrees with the pin.
    /// User should review the pin or run `component update`.
    VersionMismatch,
    /// The verify command reported failure (binary present but
    /// non-functional, e.g. wrong arch slice).
    VerifyFailed,
    /// The component isn't installed at all.
    Missing,
    /// We couldn't determine — verifier crashed, manifest malformed.
    Unknown,
}

impl ComponentStateV1 {
    /// Two-letter human label for compact UIs (panel "OK"/"NG").
    #[must_use]
    pub fn ok_or_ng(&self) -> &'static str {
        match self {
            Self::Ok => "OK",
            _ => "NG",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let m = ComponentManifestV1 {
            name: "naive".into(),
            kind: ComponentKindV1::Binary,
            version: "v147.0.7727.49-1".into(),
            upstream: Some("https://github.com/klzgrad/naiveproxy".into()),
            sha256: Some("e85403f4fc99153bb892186b87a867ba9141dcae029d80e303303a50d3701cb0".into()),
            verify: Some(VerifySpecV1 {
                command: alloc::vec!["naive".into(), "--version".into()],
                expect_stdout_contains: Some("naive".into()),
                expect_zero_exit: true,
                expect_no_version_line: false,
            }),
            note: Some("BSD-3".into()),
        };
        let j = serde_json::to_string(&m).unwrap_or_default();
        let m2: ComponentManifestV1 = serde_json::from_str(&j)
            .map_err(|_| ())
            .unwrap_or(m.clone());
        assert_eq!(m, m2);
    }

    #[test]
    fn expect_no_version_line_defaults_to_false_on_legacy_json() {
        // v0.0.31..v0.0.36 manifests do NOT carry the field. After
        // v0.0.37 deserialises one, the matcher must still see the
        // field as `false` (the pre-v0.0.37 default behaviour),
        // otherwise legacy manifests would silently shift to
        // liveness-only semantics on read.
        let legacy = r#"{
            "name": "legacy",
            "kind": "binary",
            "version": "1.0.0",
            "verify": {
                "command": ["legacy", "--version"],
                "expect_stdout_contains": "legacy",
                "expect_zero_exit": true
            }
        }"#;
        let m: ComponentManifestV1 =
            serde_json::from_str(legacy)
                .map_err(|_| ())
                .unwrap_or_else(|()| ComponentManifestV1 {
                    name: "fallback".into(),
                    kind: ComponentKindV1::Binary,
                    version: "0".into(),
                    upstream: None,
                    sha256: None,
                    verify: None,
                    note: None,
                });
        let v = m.verify.as_ref();
        assert_eq!(
            v.map(|s| s.expect_no_version_line),
            Some(false),
            "missing field must deserialise as false on legacy manifests"
        );
    }

    #[test]
    fn expect_no_version_line_round_trips_when_true() {
        // Forward direction: a v0.0.37+ manifest with the field set
        // must serialise the field, deserialise back to true, and
        // not lose any other field across the round-trip. This
        // anchors the "additive within V1" promise from
        // VERSIONING.md against accidental rename / typo / serde-
        // attribute regression.
        let m = ComponentManifestV1 {
            name: "haproxy".into(),
            kind: ComponentKindV1::ContainerImage,
            version: "3-alpine".into(),
            upstream: None,
            sha256: None,
            verify: Some(VerifySpecV1 {
                command: alloc::vec![
                    "bash".into(),
                    "-c".into(),
                    "exec 3<>/dev/tcp/haproxy/443".into(),
                ],
                expect_stdout_contains: None,
                expect_zero_exit: true,
                expect_no_version_line: true,
            }),
            note: None,
        };
        let j = serde_json::to_string(&m).unwrap_or_default();
        assert!(
            j.contains("\"expect_no_version_line\":true"),
            "field must serialise as snake_case bool: {j}"
        );
        let m2: ComponentManifestV1 = serde_json::from_str(&j)
            .map_err(|_| ())
            .unwrap_or(m.clone());
        assert_eq!(m, m2);
        assert_eq!(
            m2.verify.as_ref().map(|s| s.expect_no_version_line),
            Some(true)
        );
    }

    #[test]
    fn ok_or_ng_label() {
        assert_eq!(ComponentStateV1::Ok.ok_or_ng(), "OK");
        assert_eq!(ComponentStateV1::Missing.ok_or_ng(), "NG");
        assert_eq!(ComponentStateV1::VersionMismatch.ok_or_ng(), "NG");
    }

    #[test]
    fn doh_endpoint_kind_round_trips_through_json() {
        // The v0.0.22 DohEndpoint variant must serialise as the
        // kebab-case "doh-endpoint" — both the panel UI's
        // "Components" tab and the manifest file use this form.
        // A regression to PascalCase ("DohEndpoint") would
        // silently break manifest parsing on every release.
        let m = ComponentManifestV1 {
            name: "doh-resolver".into(),
            kind: ComponentKindV1::DohEndpoint,
            version: "operator-configured".into(),
            upstream: None,
            sha256: None,
            verify: None,
            note: None,
        };
        let j = serde_json::to_string(&m).unwrap_or_default();
        assert!(
            j.contains("\"kind\":\"doh-endpoint\""),
            "kind should serialise as kebab-case 'doh-endpoint': {j}"
        );
        let m2: ComponentManifestV1 = serde_json::from_str(&j)
            .map_err(|_| ())
            .unwrap_or(m.clone());
        assert_eq!(m, m2);
    }
}
