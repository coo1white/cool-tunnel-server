// Component verifier — server side.
//
// Reads a directory of *.upstream.json manifests, runs each
// component's verify command, prints a `ComponentStatusV1` for each.
//
// Mirrors the macOS client's NaiveBinaryResolver pattern: pin the
// expected version + hash, verify before trusting, refuse to use a
// component that fails its check.

use crate::util::doh;
use crate::{db, Result};
use ct_protocol::{
    ComponentKindV1, ComponentManifestV1, ComponentStateV1, ComponentStatusV1, VerifySpecV1,
};
use sqlx::MySqlPool;
use std::path::Path;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Manifest files are small (every shipping one is < 2 KiB). 64 KiB
/// is generous and bounds the worst case if a rogue file is dropped
/// into the manifests directory — without this, a 10 GiB file would
/// be slurped into RAM before json-parse fails.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// Cap on number of manifests in the directory. The shipping count
/// is 5; 256 is generous and bounds the worst case if the directory
/// is ever pointed at the wrong place (e.g. `/srv` instead of
/// `/srv/manifests`) and starts walking unrelated files.
const MAX_MANIFESTS: usize = 256;

pub async fn list(manifests_dir: &str) -> Result<Vec<ComponentManifestV1>> {
    let mut out = Vec::new();
    let mut rd = fs::read_dir(manifests_dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        if out.len() >= MAX_MANIFESTS {
            tracing::warn!(
                limit = MAX_MANIFESTS,
                "manifest count limit reached; skipping remaining files"
            );
            break;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let meta = fs::metadata(&path).await?;
        if meta.len() > MAX_MANIFEST_BYTES {
            tracing::warn!(
                path = %path.display(),
                size = meta.len(),
                limit = MAX_MANIFEST_BYTES,
                "manifest exceeds size limit; skipping"
            );
            continue;
        }
        // Bounded read: the metadata size check above already
        // capped the file, but we use take() defensively in case
        // the file grew between metadata and read.
        let f = fs::File::open(&path).await?;
        let mut buf = String::with_capacity(meta.len() as usize);
        f.take(MAX_MANIFEST_BYTES).read_to_string(&mut buf).await?;
        match serde_json::from_str::<ComponentManifestV1>(&buf) {
            Ok(m) => out.push(m),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping bad manifest");
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn check_all(manifests_dir: &str, pool: &MySqlPool) -> Result<Vec<ComponentStatusV1>> {
    let manifests = list(manifests_dir).await?;
    let mut out = Vec::with_capacity(manifests.len());
    for m in manifests {
        out.push(check_one(&m, pool).await);
    }
    Ok(out)
}

pub async fn check_one(m: &ComponentManifestV1, pool: &MySqlPool) -> ComponentStatusV1 {
    let (state, message, installed) = match m.kind {
        ComponentKindV1::Binary | ComponentKindV1::ContainerImage => verify_via_command(m).await,
        ComponentKindV1::DohEndpoint => verify_via_doh(pool).await,
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

    // Bounded by a 15s timeout. The verify command is supposed to
    // be a fast `--version`-style check; if it hangs longer than
    // that, treat it as VerifyFailed so a hung verifier doesn't
    // wedge the entire OK/NG pass.
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        Command::new(prog).args(&args).output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return (
                ComponentStateV1::Missing,
                format!("could not exec {prog}: {e}"),
                None,
            );
        }
        Err(_) => {
            return (
                ComponentStateV1::VerifyFailed,
                format!("`{prog}` did not respond within 15s"),
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
    classify_verify(spec, m, &stdout)
}

/// Pure post-execution classifier — extracted so the matcher's
/// `Ok` / `VersionMismatch` / `VerifyFailed` decision is unit-
/// testable without spawning a process. Called by
/// [`verify_via_command`] after the exit-code gate has passed.
fn classify_verify(
    spec: &VerifySpecV1,
    m: &ComponentManifestV1,
    stdout: &str,
) -> (ComponentStateV1, String, Option<String>) {
    let installed = first_line(stdout).map(str::to_owned);

    if let Some(needle) = spec.expect_stdout_contains.as_deref() {
        if !stdout.contains(needle) {
            return (
                ComponentStateV1::VerifyFailed,
                format!("expected stdout to contain {needle:?}, got {stdout:?}"),
                installed,
            );
        }
    }

    // Liveness-probe opt-in (v0.0.37). When the manifest declares
    // `expect_no_version_line: true`, the verifier has no version
    // string to assert — the soft version matcher is intentionally
    // skipped, regardless of whether stdout happens to be empty or
    // not. This is what restores the matcher's drift-detection
    // semantics for components that DO print a version line: the
    // permissive `None => Ok` corner case is no longer the only
    // way to land on OK, so silenced probes can keep their stdout
    // shape without occupying it by accident.
    if spec.expect_no_version_line {
        return (
            ComponentStateV1::Ok,
            "verified (liveness)".into(),
            installed,
        );
    }

    // Soft version match: if installed first line contains the
    // pinned version, OK. Otherwise VersionMismatch (still
    // functional, but not what the operator pinned). Conservative
    // — better to flag than silently accept drift.
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

/// Live-reachability check for the operator's chosen DoH resolver.
///
/// Reads the operator's live DoH endpoint (panel-editable, not the
/// install-time `.env`) and asks it to resolve `example.com IN A`.
/// IANA-managed names always have A records, so a 0-answer response
/// signals a captive portal / poisoner between us and the resolver
/// rather than an upstream NXDOMAIN. The wire-format query and the
/// HTTP round trip live in `util::doh::resolve_a` so this verifier
/// and the `canary` self-probe share one implementation.
async fn verify_via_doh(pool: &MySqlPool) -> (ComponentStateV1, String, Option<String>) {
    let cfg = match db::server_config(pool).await {
        Ok(c) => c,
        Err(e) => {
            return (
                ComponentStateV1::Unknown,
                format!("ServerConfig row missing: {e}"),
                None,
            );
        }
    };
    let doh_url = cfg.doh_resolver;
    if doh_url.is_empty() {
        return (
            ComponentStateV1::Missing,
            "ServerConfig.doh_resolver is empty".into(),
            None,
        );
    }

    match doh::resolve_a("example.com", &doh_url).await {
        Ok(ancount) => (
            ComponentStateV1::Ok,
            format!("DoH reachable, {ancount} answer record(s)"),
            Some(doh_url),
        ),
        Err(reason) => (ComponentStateV1::VerifyFailed, reason, Some(doh_url)),
    }
}

pub async fn print_check(manifests_dir: &str, pool: &MySqlPool, json: bool) -> Result<()> {
    let statuses = check_all(manifests_dir, pool).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str) -> ComponentManifestV1 {
        ComponentManifestV1 {
            name: "test".into(),
            kind: ComponentKindV1::ContainerImage,
            version: version.into(),
            upstream: None,
            sha256: None,
            verify: None,
            note: None,
        }
    }

    fn spec(expect_no_version_line: bool) -> VerifySpecV1 {
        VerifySpecV1 {
            command: vec!["true".into()],
            expect_stdout_contains: None,
            expect_zero_exit: true,
            expect_no_version_line,
        }
    }

    #[test]
    fn classify_legacy_matching_version_is_ok() {
        // Pre-v0.0.37 happy path: probe prints a version line
        // containing the pinned string. Result: Ok.
        let (state, _, installed) = classify_verify(
            &spec(false),
            &manifest("1.10.7"),
            "sing-box version 1.10.7\n",
        );
        assert_eq!(state, ComponentStateV1::Ok);
        assert_eq!(installed.as_deref(), Some("sing-box version 1.10.7"));
    }

    #[test]
    fn classify_legacy_non_matching_version_is_mismatch() {
        // Pre-v0.0.37 drift detection: probe prints SOMETHING but
        // it doesn't contain the pinned version. Must flip to
        // VersionMismatch — this is the soft-version-match arm
        // that v0.0.34 fell into and v0.0.35 sidestepped.
        let (state, _, _) = classify_verify(
            &spec(false),
            &manifest("1.10.7"),
            "sing-box version 1.10.6\n",
        );
        assert_eq!(state, ComponentStateV1::VersionMismatch);
    }

    #[test]
    fn classify_legacy_silent_stdout_is_ok() {
        // Pre-v0.0.37 corner case: empty stdout falls through to
        // the `None => Ok` arm. v0.0.35's six silenced manifests
        // ride this path. The behaviour is preserved verbatim so
        // legacy manifests that don't set the new field continue
        // to work bit-for-bit.
        let (state, _, installed) = classify_verify(&spec(false), &manifest("1.10.7"), "");
        assert_eq!(state, ComponentStateV1::Ok);
        assert_eq!(installed, None);
    }

    #[test]
    fn classify_liveness_skips_version_match_with_non_matching_stdout() {
        // The actual v0.0.37 fix: when expect_no_version_line is
        // true, even stdout that would otherwise trip the soft
        // version matcher resolves to Ok. This is what lets a
        // future probe restore informational output (e.g. "connected"
        // from a TCP open or a Caddy `Server:` header) without
        // re-introducing the v0.0.34 false-positive
        // VersionMismatch flips for the silenced six.
        let (state, msg, installed) =
            classify_verify(&spec(true), &manifest("3-alpine"), "connected\n");
        assert_eq!(state, ComponentStateV1::Ok);
        assert_eq!(msg, "verified (liveness)");
        assert_eq!(installed.as_deref(), Some("connected"));
    }

    #[test]
    fn classify_liveness_with_silent_stdout_is_ok() {
        // Today's silenced-probe shape (post-v0.0.35): empty
        // stdout, expect_no_version_line: true. Must be Ok and
        // must take the liveness branch (carries the "verified
        // (liveness)" diagnostic, which is the only operator-side
        // signal that this component was opted out of drift
        // detection on purpose).
        let (state, msg, _) = classify_verify(&spec(true), &manifest("7-alpine"), "");
        assert_eq!(state, ComponentStateV1::Ok);
        assert_eq!(msg, "verified (liveness)");
    }

    #[test]
    fn classify_liveness_still_honours_expect_stdout_contains() {
        // Defence in depth: expect_no_version_line and
        // expect_stdout_contains are independent gates. If a
        // manifest declares both (unusual but legal), the stdout
        // assertion still runs FIRST. A liveness probe with a
        // mandatory needle that doesn't match must VerifyFail,
        // not silently OK.
        let mut s = spec(true);
        s.expect_stdout_contains = Some("required-banner".into());
        let (state, _, _) = classify_verify(&s, &manifest("1.0"), "wrong banner\n");
        assert_eq!(state, ComponentStateV1::VerifyFailed);
    }
}
