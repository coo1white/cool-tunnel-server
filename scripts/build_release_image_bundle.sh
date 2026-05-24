#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Build release Docker image bundles locally.
#
# Maintainer flow:
#   1. Build ct-server-core and singbox-core Linux assets.
#   2. Run this script on a Docker host with enough CPU/RAM.
#   3. Upload cool-tunnel-server-images-*.bom.json plus the
#      cool-tunnel-server-image-linux-* component parts to the release.
#
# Emergency/repack flow:
#   CT_REPACK_LOADED_IMAGES=1 PLATFORMS=linux/amd64 ./scripts/build_release_image_bundle.sh
#   verifies that the runtime images are already loaded locally, then
#   writes only the BOM/sliced archives. This is useful when the base
#   images were built in a prior clean run and only tiny baked runtime
#   files were patched locally; it intentionally skips all network pulls
#   and image builds.
#
# VPS installs then download a verified image BOM and load each
# component one at a time. This avoids Rust, Bun, Go/xcaddy, and
# Docker Hub pulls on low-resource machines
# without requiring one giant archive to fit on disk.

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
CT_BUN_IMAGE="${CT_BUN_IMAGE:-oven/bun:1.3.14-alpine}"
CT_REDIS_IMAGE="${CT_REDIS_IMAGE:-redis:7.4.8-alpine}"
CT_MARIADB_IMAGE="${CT_MARIADB_IMAGE:-mariadb:11.8.6}"
CT_ALPINE_REPOSITORY_BASE="${CT_ALPINE_REPOSITORY_BASE:-}"
CT_BUILD_FULL_IMAGE_BUNDLE="${CT_BUILD_FULL_IMAGE_BUNDLE:-0}"
CT_IMAGE_BOM_PART_SIZE_MB="${CT_IMAGE_BOM_PART_SIZE_MB:-95}"
RUNTIME_IMAGES=(
    "cool-tunnel-server-caddy:latest"
    "cool-tunnel-server-singbox:latest"
    "cool-tunnel-server-panel:latest"
    "mariadb:11.8.6"
    "redis:7.4.8-alpine"
)
IMAGE_COMPONENTS=(
    "caddy|cool-tunnel-server-caddy:latest"
    "singbox|cool-tunnel-server-singbox:latest"
    "panel|cool-tunnel-server-panel:latest"
    "mariadb|mariadb:11.8.6"
    "redis|redis:7.4.8-alpine"
)
GENERATED_IMAGE_ASSETS=()

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
architecture. The panel image packages the Bun/Hono admin server, and
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

json_string() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
}

asset_sha() {
    sha256sum "$1" | awk '{print $1}'
}

asset_size() {
    wc -c < "$1" | tr -d ' '
}

write_image_bom() {
    local platform="$1"
    local suffix="$2"
    local bom="${OUT_DIR}/cool-tunnel-server-images-${suffix}.bom.json"
    local version part_bytes first_image

    version=$(grep -E '^\s*"version"\s*:' operator/package.json 2>/dev/null \
        | head -1 \
        | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)
    if [[ -z "$version" ]]; then
        echo "cannot determine version from operator/package.json" >&2
        return 1
    fi

    part_bytes=$((CT_IMAGE_BOM_PART_SIZE_MB * 1024 * 1024))
    rm -f \
        "${OUT_DIR}/cool-tunnel-server-image-${suffix}-"*.tar.gz \
        "${OUT_DIR}/cool-tunnel-server-image-${suffix}-"*.tar.gz.part-* \
        "$bom"

    {
        printf '{\n'
        printf '  "kind": "cool-tunnel-server-image-bom",\n'
        printf '  "schema_version": 1,\n'
        printf '  "version": '
        json_string "$version"
        printf ',\n'
        printf '  "release_tag": '
        json_string "v${version}"
        printf ',\n'
        printf '  "platform": '
        json_string "$platform"
        printf ',\n'
        printf '  "part_size_bytes": %s,\n' "$part_bytes"
        printf '  "images": [\n'
    } > "$bom"

    first_image=1
    for component in "${IMAGE_COMPONENTS[@]}"; do
        local name ref archive archive_name archive_sha archive_bytes parts first_part
        name="${component%%|*}"
        ref="${component#*|}"
        archive="${OUT_DIR}/cool-tunnel-server-image-${suffix}-${name}.tar.gz"
        archive_name="$(basename "$archive")"

        echo "==> saving component ${archive_name} (${ref})"
        docker save "$ref" | gzip -n > "$archive"
        chmod 0644 "$archive"
        archive_sha="$(asset_sha "$archive")"
        archive_bytes="$(asset_size "$archive")"

        parts=("$archive")
        if (( archive_bytes > part_bytes )); then
            echo "==> splitting ${archive_name} into <= ${CT_IMAGE_BOM_PART_SIZE_MB} MiB parts"
            split -b "${CT_IMAGE_BOM_PART_SIZE_MB}m" -d -a 3 "$archive" "${archive}.part-"
            rm -f "$archive"
            mapfile -t parts < <(find "$OUT_DIR" -maxdepth 1 -type f -name "${archive_name}.part-*" | sort)
        fi

        if (( first_image == 0 )); then
            printf ',\n' >> "$bom"
        fi
        first_image=0

        {
            printf '    {\n'
            printf '      "name": '
            json_string "$name"
            printf ',\n'
            printf '      "docker_ref": '
            json_string "$ref"
            printf ',\n'
            printf '      "archive_sha256": '
            json_string "$archive_sha"
            printf ',\n'
            printf '      "archive_size_bytes": %s,\n' "$archive_bytes"
            printf '      "parts": [\n'
        } >> "$bom"

        first_part=1
        for part in "${parts[@]}"; do
            local part_name part_sha part_bytes_actual
            part_name="$(basename "$part")"
            part_sha="$(asset_sha "$part")"
            part_bytes_actual="$(asset_size "$part")"
            GENERATED_IMAGE_ASSETS+=("$part")

            if (( first_part == 0 )); then
                printf ',\n' >> "$bom"
            fi
            first_part=0

            {
                printf '        {\n'
                printf '          "filename": '
                json_string "$part_name"
                printf ',\n'
                printf '          "sha256": '
                json_string "$part_sha"
                printf ',\n'
                printf '          "size_bytes": %s\n' "$part_bytes_actual"
                printf '        }'
            } >> "$bom"
        done

        {
            printf '\n'
            printf '      ]\n'
            printf '    }'
        } >> "$bom"
    done

    {
        printf '\n'
        printf '  ]\n'
        printf '}\n'
    } >> "$bom"
    chmod 0644 "$bom"
    GENERATED_IMAGE_ASSETS+=("$bom")
    echo "==> wrote ${bom}"
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

    if [[ "${CT_REPACK_LOADED_IMAGES:-0}" == "1" ]]; then
        echo "==> repacking already-loaded runtime images (${platform})"
        for image in "${RUNTIME_IMAGES[@]}"; do
            if ! docker image inspect "$image" >/dev/null 2>&1; then
                echo "missing loaded runtime image: $image" >&2
                return 1
            fi
        done
        write_image_bom "$platform" "$suffix"
        return 0
    fi

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
    CT_BUN_IMAGE="$CT_BUN_IMAGE" \
    CT_REDIS_IMAGE="$CT_REDIS_IMAGE" \
    CT_ALPINE_REPOSITORY_BASE="$CT_ALPINE_REPOSITORY_BASE" \
        docker compose build caddy singbox panel

    echo "==> pulling runtime base service images (${platform})"
    pull_and_tag "$platform" "$CT_MARIADB_IMAGE" "mariadb:11.8.6"
    pull_and_tag "$platform" "$CT_REDIS_IMAGE" "redis:7.4.8-alpine"

    write_image_bom "$platform" "$suffix"

    if [[ "$CT_BUILD_FULL_IMAGE_BUNDLE" == "1" ]]; then
        asset="${OUT_DIR}/cool-tunnel-server-images-${suffix}.tar.gz"
        rm -f "$asset"
        echo "==> saving legacy full bundle ${asset}"
        docker save "${RUNTIME_IMAGES[@]}" | gzip -n > "$asset"
        chmod 0644 "$asset"
        ls -lh "$asset"
        sha256sum "$asset"
        GENERATED_IMAGE_ASSETS+=("$asset")
    fi
}

for platform in $PLATFORMS; do
    build_one "$platform"
done

(
    if [[ ${#GENERATED_IMAGE_ASSETS[@]} -eq 0 ]]; then
        : > "${OUT_DIR}/SHA256SUMS.images"
    else
        sha256sum "${GENERATED_IMAGE_ASSETS[@]}" \
            | sed "s#  ${OUT_DIR}/#  #" \
            > "${OUT_DIR}/SHA256SUMS.images"
    fi
)

echo "==> wrote ${OUT_DIR}/SHA256SUMS.images"
