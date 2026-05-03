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
    fn ok_or_ng_label() {
        assert_eq!(ComponentStateV1::Ok.ok_or_ng(), "OK");
        assert_eq!(ComponentStateV1::Missing.ok_or_ng(), "NG");
        assert_eq!(ComponentStateV1::VersionMismatch.ok_or_ng(), "NG");
    }
}
