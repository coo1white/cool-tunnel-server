#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Build ct-server-core Linux release assets locally.
#
# Intended maintainer flow:
#   1. Build these assets on a local workstation/VM.
#   2. Upload them to the GitHub release.
#   3. Let GitHub CI/checks audit the commit and published checksums.
#
# This keeps low-resource VPS installs on the download/verify path
# instead of compiling Rust crates during `ct install` or `ct update`.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${OUT_DIR:-release-assets}"
BUILDER="${BUILDER:-}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64}"
CT_RUST_BASE_IMAGE="${CT_RUST_BASE_IMAGE:-rust:1.88.0-alpine}"
CT_ALPINE_BASE_IMAGE="${CT_ALPINE_BASE_IMAGE:-alpine:3.20}"
CT_ALPINE_REPOSITORY_BASE="${CT_ALPINE_REPOSITORY_BASE:-}"

mkdir -p "$OUT_DIR"

build_one() {
    local platform="$1"
    local suffix target_dir binary

    case "$platform" in
        linux/amd64) suffix="linux-x64" ;;
        linux/arm64) suffix="linux-arm64" ;;
        *)
            echo "unsupported platform: $platform" >&2
            return 2
            ;;
    esac

    target_dir="${OUT_DIR}/ct-server-core-${suffix}.rootfs"
    binary="${OUT_DIR}/ct-server-core-${suffix}"
    rm -rf "$target_dir" "$binary"

    echo "==> building ct-server-core-${suffix} (${platform})"
    local cmd=(docker buildx build
        --platform "$platform"
        --target runtime
        --provenance=false
        --build-arg "CT_RUST_BASE_IMAGE=${CT_RUST_BASE_IMAGE}"
        --build-arg "CT_ALPINE_BASE_IMAGE=${CT_ALPINE_BASE_IMAGE}"
        --build-arg "CT_ALPINE_REPOSITORY_BASE=${CT_ALPINE_REPOSITORY_BASE}"
        --output "type=local,dest=${target_dir}"
        -f docker/core/Dockerfile
        .)
    if [[ -n "$BUILDER" ]]; then
        cmd=(docker buildx build --builder "$BUILDER"
            --platform "$platform"
            --target runtime
            --provenance=false
            --build-arg "CT_RUST_BASE_IMAGE=${CT_RUST_BASE_IMAGE}"
            --build-arg "CT_ALPINE_BASE_IMAGE=${CT_ALPINE_BASE_IMAGE}"
            --build-arg "CT_ALPINE_REPOSITORY_BASE=${CT_ALPINE_REPOSITORY_BASE}"
            --output "type=local,dest=${target_dir}"
            -f docker/core/Dockerfile
            .)
    fi
    "${cmd[@]}"

    cp "${target_dir}/usr/local/bin/ct-server-core" "$binary"
    chmod 0755 "$binary"
    rm -rf "$target_dir"
    if command -v file >/dev/null 2>&1; then
        file "$binary"
    fi
    sha256sum "$binary"
}

for platform in $PLATFORMS; do
    build_one "$platform"
done

(
    cd "$OUT_DIR"
    sha256sum ct-server-core-* > SHA256SUMS.core
)

echo "==> wrote ${OUT_DIR}/SHA256SUMS.core"
