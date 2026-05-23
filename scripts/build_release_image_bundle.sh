#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Build release Docker image bundles locally.
#
# Maintainer flow:
#   1. Build ct-server-core and singbox-core Linux assets.
#   2. Run this script on a Docker host with enough CPU/RAM.
#   3. Upload cool-tunnel-server-images-linux-*.tar.gz to the release.
#
# VPS installs then download one verified bundle and `docker load` it,
# avoiding Rust, Bun, Go/xcaddy, Composer, PHP-extension builds, and
# Docker Hub pulls on low-resource machines.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${OUT_DIR:-release-assets}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64}"
CORE_IMAGE="${CT_CORE_IMAGE:-cool-tunnel-server-core:latest}"
SINGBOX_CORE_IMAGE="${CT_SINGBOX_CORE_IMAGE:-cool-tunnel-server-singbox-core:latest}"
CT_CADDY_BUILDER_IMAGE="${CT_CADDY_BUILDER_IMAGE:-caddy:2.11.3-builder}"
CT_CADDY_RUNTIME_IMAGE="${CT_CADDY_RUNTIME_IMAGE:-caddy:2.11.3-alpine}"
CT_GOPROXY="${CT_GOPROXY:-https://proxy.golang.org,direct}"
CT_GOSUMDB="${CT_GOSUMDB:-sum.golang.org}"
CT_ALPINE_RUNTIME_IMAGE="${CT_ALPINE_RUNTIME_IMAGE:-alpine:3.21}"
CT_FRANKENPHP_IMAGE="${CT_FRANKENPHP_IMAGE:-dunglas/frankenphp:1-php8.4-alpine}"
CT_REDIS_IMAGE="${CT_REDIS_IMAGE:-redis:7.4.8-alpine}"
CT_MARIADB_IMAGE="${CT_MARIADB_IMAGE:-mariadb:11.8.6}"
CT_ALPINE_REPOSITORY_BASE="${CT_ALPINE_REPOSITORY_BASE:-}"
CT_PHP_EXT_BUILD_JOBS="${CT_PHP_EXT_BUILD_JOBS:-1}"
UPSTREAM_IMAGES=(
    "mariadb:11.8.6"
    "redis:7.4.8-alpine"
)
IMAGES=(
    "$CORE_IMAGE"
    "$SINGBOX_CORE_IMAGE"
    "cool-tunnel-server-caddy:latest"
    "cool-tunnel-server-singbox:latest"
    "cool-tunnel-server-panel:latest"
    "${UPSTREAM_IMAGES[@]}"
)

mkdir -p "$OUT_DIR"

require_file() {
    local path="$1"
    if [[ ! -f "$path" ]]; then
        echo "missing required file: $path" >&2
        echo "run ./scripts/build_release_core_assets.sh and ./scripts/build_release_singbox_core_assets.sh first" >&2
        exit 1
    fi
}

host_arch() {
    local arch
    arch="$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)"
    case "$arch" in
        amd64|x86_64) echo "amd64" ;;
        arm64|aarch64) echo "arm64" ;;
        *) echo "$arch" ;;
    esac
}

platform_arch() {
    case "$1" in
        linux/amd64) echo "amd64" ;;
        linux/arm64) echo "arm64" ;;
        *) echo "unknown" ;;
    esac
}

require_native_builder() {
    local platform="$1"
    local wanted actual
    wanted="$(platform_arch "$platform")"
    actual="$(host_arch)"

    if [[ "$wanted" = "unknown" ]]; then
        echo "unsupported platform: $platform" >&2
        return 2
    fi

    if [[ "$actual" != "$wanted" && "${CT_ALLOW_EMULATED_RELEASE_BUILD:-0}" != "1" ]]; then
        cat >&2 <<EOF
refusing emulated release image build: requested ${platform}, Docker host is ${actual}

Release bundles must be built on a native Linux builder for the target
architecture. The panel image compiles FrankenPHP/PHP extensions, and
QEMU emulation has produced autoconf/m4 crashes for amd64-on-arm64.

Use:
  - linux/amd64 bundle: native x86_64/amd64 Linux Docker host
  - linux/arm64 bundle: native arm64/aarch64 Linux Docker host

For non-release debugging only, set CT_ALLOW_EMULATED_RELEASE_BUILD=1.
EOF
        return 1
    fi
}

build_carrier() {
    local platform="$1"
    local suffix="$2"
    local kind="$3"
    local dockerfile="$4"
    local binary="$5"
    local image="$6"
    local ctx=".runtime/release-image-bundle/${suffix}/${kind}"

    rm -rf "$ctx"
    mkdir -p "$ctx"
    cp "$binary" "$ctx/$kind"
    chmod 0755 "$ctx/$kind"

    docker buildx build \
        --platform "$platform" \
        --provenance=false \
        --load \
        -f "$dockerfile" \
        -t "$image" \
        "$ctx"
}

pull_and_tag() {
    local platform="$1"
    local source="$2"
    local target="$3"

    docker pull --platform "$platform" "$source"
    if [[ "$source" != "$target" ]]; then
        docker tag "$source" "$target"
    fi
}

build_one() {
    local platform="$1"
    local suffix asset
    require_native_builder "$platform"

    case "$platform" in
        linux/amd64) suffix="linux-x64" ;;
        linux/arm64) suffix="linux-arm64" ;;
        *)
            echo "unsupported platform: $platform" >&2
            return 2
            ;;
    esac

    require_file "${OUT_DIR}/ct-server-core-${suffix}"
    require_file "${OUT_DIR}/singbox-core-${suffix}"

    echo "==> preparing prebuilt carrier images (${platform})"
    build_carrier "$platform" "$suffix" "ct-server-core" \
        docker/core/prebuilt.Dockerfile \
        "${OUT_DIR}/ct-server-core-${suffix}" \
        "$CORE_IMAGE"
    build_carrier "$platform" "$suffix" "singbox-core" \
        docker/singbox-core/prebuilt.Dockerfile \
        "${OUT_DIR}/singbox-core-${suffix}" \
        "$SINGBOX_CORE_IMAGE"

    echo "==> building runtime images (${platform})"
    DOCKER_DEFAULT_PLATFORM="$platform" \
    CT_CADDY_BUILDER_IMAGE="$CT_CADDY_BUILDER_IMAGE" \
    CT_CADDY_RUNTIME_IMAGE="$CT_CADDY_RUNTIME_IMAGE" \
    CT_GOPROXY="$CT_GOPROXY" \
    CT_GOSUMDB="$CT_GOSUMDB" \
    CT_ALPINE_RUNTIME_IMAGE="$CT_ALPINE_RUNTIME_IMAGE" \
    CT_FRANKENPHP_IMAGE="$CT_FRANKENPHP_IMAGE" \
    CT_REDIS_IMAGE="$CT_REDIS_IMAGE" \
    CT_ALPINE_REPOSITORY_BASE="$CT_ALPINE_REPOSITORY_BASE" \
    CT_PHP_EXT_BUILD_JOBS="$CT_PHP_EXT_BUILD_JOBS" \
        docker compose build caddy singbox panel

    echo "==> pulling runtime base service images (${platform})"
    pull_and_tag "$platform" "$CT_MARIADB_IMAGE" "mariadb:11.8.6"
    pull_and_tag "$platform" "$CT_REDIS_IMAGE" "redis:7.4.8-alpine"

    asset="${OUT_DIR}/cool-tunnel-server-images-${suffix}.tar.gz"
    rm -f "$asset"
    echo "==> saving ${asset}"
    docker save "${IMAGES[@]}" | gzip -n > "$asset"
    chmod 0644 "$asset"
    ls -lh "$asset"
    sha256sum "$asset"
}

for platform in $PLATFORMS; do
    build_one "$platform"
done

(
    cd "$OUT_DIR"
    find . -maxdepth 1 -type f -name 'cool-tunnel-server-images-*.tar.gz' -print0 \
        | sort -z \
        | xargs -0 sha256sum \
        | sed 's#  ./#  #' \
        > SHA256SUMS.images
)

echo "==> wrote ${OUT_DIR}/SHA256SUMS.images"
