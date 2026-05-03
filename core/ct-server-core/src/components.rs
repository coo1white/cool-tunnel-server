// Component verifier — server side.
//
// Reads a directory of *.upstream.json manifests, runs each
// component's verify command, prints a `ComponentStatusV1` for each.
//
// Mirrors the macOS client's NaiveBinaryResolver pattern: pin the
// expected version + hash, verify before trusting, refuse to use a
// component that fails its check.

use crate::Result;
use ct_protocol::{ComponentKindV1, ComponentManifestV1, ComponentStateV1, ComponentStatusV1};
use std::path::Path;
use tokio::fs;
use tokio::process::Command;

pub async fn list(manifests_dir: &str) -> Result<Vec<ComponentManifestV1>> {
    let mut out = Vec::new();
    let mut rd = fs::read_dir(manifests_dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path).await?;
        match serde_json::from_str::<ComponentManifestV1>(&raw) {
            Ok(m) => out.push(m),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping bad manifest");
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn check_all(manifests_dir: &str) -> Result<Vec<ComponentStatusV1>> {
    let manifests = list(manifests_dir).await?;
    let mut out = Vec::with_capacity(manifests.len());
    for m in manifests {
        out.push(check_one(&m).await);
    }
    Ok(out)
}

pub async fn check_one(m: &ComponentManifestV1) -> ComponentStatusV1 {
    let (state, message, installed) = match m.kind {
        ComponentKindV1::Binary | ComponentKindV1::ContainerImage => verify_via_command(m).await,
        ComponentKindV1::RustCrate | ComponentKindV1::PhpPackage => {
            // For workspace crates / Composer packages we trust the
            // lockfile to enforce versions. Mark OK with the pin
            // version as the installed version.
            (
                ComponentStateV1::Ok,
                "trusted by lockfile".into(),
                Some(m.version.clone()),
            )
        }
    };

    ComponentStatusV1 {
        name: m.name.clone(),
        installed_version: installed,
        pinned_version: m.version.clone(),
        state,
        message,
    }
}

async fn verify_via_command(m: &ComponentManifestV1) -> (ComponentStateV1, String, Option<String>) {
    let Some(spec) = m.verify.as_ref() else {
        return (
            ComponentStateV1::Unknown,
            "no verify spec in manifest".into(),
            None,
        );
    };

    let Some(prog) = spec.command.first() else {
        return (
            ComponentStateV1::Unknown,
            "verify spec has no command".into(),
            None,
        );
    };

    let args: Vec<&str> = spec.command.iter().skip(1).map(String::as_str).collect();

    let output = match Command::new(prog).args(&args).output().await {
        Ok(o) => o,
        Err(e) => {
            return (
                ComponentStateV1::Missing,
                format!("could not exec {prog}: {e}"),
                None,
            );
        }
    };

    if spec.expect_zero_exit && !output.status.success() {
        return (
            ComponentStateV1::VerifyFailed,
            format!("non-zero exit ({:?})", output.status.code()),
            None,
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let installed = first_line(&stdout).map(str::to_owned);

    if let Some(needle) = spec.expect_stdout_contains.as_deref() {
        if !stdout.contains(needle) {
            return (
                ComponentStateV1::VerifyFailed,
                format!("expected stdout to contain {needle:?}, got {stdout:?}"),
                installed,
            );
        }
    }

    // Soft version match: if installed first line equals pinned
    // version, OK. Otherwise VersionMismatch (still functional, but
    // not what the operator pinned). Conservative — better to flag
    // than silently accept drift.
    let state = match installed.as_deref() {
        Some(line) if line.contains(&m.version) => ComponentStateV1::Ok,
        Some(_) => ComponentStateV1::VersionMismatch,
        None => ComponentStateV1::Ok, // verify passed; no version line we can compare
    };

    let message = match state {
        ComponentStateV1::Ok => "verified".into(),
        ComponentStateV1::VersionMismatch => format!(
            "installed version line {:?} does not match pinned {:?}",
            installed.as_deref().unwrap_or(""),
            &m.version,
        ),
        _ => "ok".into(),
    };

    (state, message, installed)
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().next().map(str::trim)
}

pub async fn print_check(manifests_dir: &str, json: bool) -> Result<()> {
    let statuses = check_all(manifests_dir).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&statuses)?);
    } else {
        for s in &statuses {
            println!(
                "{:>3}  {:<24}  pinned={:<24}  installed={:<24}  {}",
                s.state.ok_or_ng(),
                s.name,
                s.pinned_version,
                s.installed_version.as_deref().unwrap_or("—"),
                s.message,
            );
        }
    }
    Ok(())
}

/// Convenience: load a single manifest from a path. Reserved for the
/// future component-update flow (download → load → verify → swap).
#[allow(dead_code)]
pub async fn load_one(path: impl AsRef<Path>) -> Result<ComponentManifestV1> {
    let raw = fs::read_to_string(path.as_ref()).await?;
    Ok(serde_json::from_str(&raw)?)
}

/// Default manifest directory. Reserved for the same future flow.
#[allow(dead_code)]
pub fn default_manifests_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(
        std::env::var("CT_MANIFESTS_DIR").unwrap_or_else(|_| "/srv/manifests".into()),
    )
}
