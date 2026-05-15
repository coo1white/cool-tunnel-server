#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# sbom.sh — produce CycloneDX SBOMs for everything that goes into a
# release artefact. Output lands in `sbom/`. Each release uploads
# these to GitHub.
#
# Tools used:
#   - cargo-cyclonedx for the Rust workspace
#   - cyclonedx/cdxgen for the Composer panel and Docker images
#
# Both are auto-installed if missing. The script is idempotent:
# re-running just regenerates the files.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

require_cmd jq "apt install -y jq"

mkdir -p sbom

# ---------- Cargo workspace --------------------------------------

step "Generating Rust SBOM (cargo-cyclonedx)"
if ! command -v cargo-cyclonedx >/dev/null 2>&1; then
    warn "cargo-cyclonedx not on PATH; installing into ~/.cargo/bin"
    cargo install --locked cargo-cyclonedx
fi
( cd core && cargo cyclonedx --format json --override-filename ../sbom/cargo )
ok "wrote sbom/cargo.cdx.json"

# ---------- Composer panel ---------------------------------------

step "Generating PHP SBOM (cdxgen)"
# Run cdxgen via `bunx` so we don't carry a global `npm install -g`
# dependency on hosts that already have Bun (which the operator/ CLI
# build needs). Falls back to `cdxgen` on PATH or `npx` if Bun isn't
# present — keeps the script useful on minimal-tooling boxes.
cdxgen_cmd=()
if command -v cdxgen >/dev/null 2>&1; then
    cdxgen_cmd=(cdxgen)
elif command -v bunx >/dev/null 2>&1; then
    cdxgen_cmd=(bunx --bun @cyclonedx/cdxgen)
elif command -v npx >/dev/null 2>&1; then
    cdxgen_cmd=(npx --yes @cyclonedx/cdxgen)
else
    warn "no cdxgen / bunx / npx on PATH; skipping PHP SBOM"
fi

if [ ${#cdxgen_cmd[@]} -gt 0 ]; then
    ( cd panel && "${cdxgen_cmd[@]}" -t php -o ../sbom/composer.cdx.json --spec-version 1.5 --no-recurse )
    ok "wrote sbom/composer.cdx.json"
fi

# ---------- Docker images (only if docker is available) ----------

if command -v docker >/dev/null 2>&1 && [ ${#cdxgen_cmd[@]} -gt 0 ]; then
    step "Generating Docker SBOMs (cdxgen)"
    for image in cool-tunnel-server-caddy cool-tunnel-server-singbox \
                 cool-tunnel-server-panel cool-tunnel-server-core; do
        if ! docker image inspect "$image:latest" >/dev/null 2>&1; then
            warn "skipping $image (image not built locally)"
            continue
        fi
        if "${cdxgen_cmd[@]}" -t docker -o "sbom/${image}.cdx.json" --spec-version 1.5 \
                "$image:latest" >/dev/null 2>&1; then
            ok "wrote sbom/${image}.cdx.json"
        else
            warn "cdxgen failed on $image"
        fi
    done
elif ! command -v docker >/dev/null 2>&1; then
    warn "docker not on PATH; skipping image SBOMs"
fi

# ---------- Combined manifest ------------------------------------

step "Composing release-level SBOM"
ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
version=$(grep -m1 '^version' core/Cargo.toml | cut -d'"' -f2)
out="sbom/cool-tunnel-server-v${version}-sbom.cdx.json"

# Merge by listing component refs from each per-tool SBOM. cdxgen
# itself doesn't have a "merge" mode that's reliably stable across
# versions, so we publish them side-by-side and just emit a tiny
# index file that points at the constituents.
jq -n --arg ts "$ts" --arg v "$version" '
{
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: ("urn:uuid:" + $ts),
    version: 1,
    metadata: {
        timestamp: $ts,
        component: {
            type: "application",
            "bom-ref": "cool-tunnel-server",
            name: "cool-tunnel-server",
            version: $v
        },
        tools: [{
            vendor: "cool-tunnel-server",
            name: "scripts/sbom.sh",
            version: "0.0.5"
        }]
    },
    components: [],
    "x-references": [
        "cargo.cdx.json",
        "composer.cdx.json",
        "cool-tunnel-server-core.cdx.json",
        "cool-tunnel-server-caddy.cdx.json",
        "cool-tunnel-server-singbox.cdx.json",
        "cool-tunnel-server-panel.cdx.json"
    ]
}' > "$out"
ok "wrote $out"

ok "SBOM generation complete. Files under sbom/:"
ls -lh sbom/ | head -20
