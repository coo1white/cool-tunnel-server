#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# fetch_image_bundle.sh — fetch and load the matching prebuilt Docker
# image bundle for this release.
#
# Exit codes:
#   0  image bundle was loaded and required images are present
#   1  integrity/download/docker failure; do not silently ignore
#   2  bundle unavailable or intentionally skipped

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

VERSION=$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)
if [[ -z "$VERSION" ]]; then
    echo "fetch_image_bundle: cannot determine version from package.json" >&2
    exit 1
fi

case "$(uname -s)" in
    Linux) OS=linux ;;
    *)
        echo "fetch_image_bundle: prebuilt image bundles are linux-only (host: $(uname -s)). Skipping."
        exit 2
        ;;
esac
case "$(uname -m)" in
    x86_64)        ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *)
        echo "fetch_image_bundle: unsupported arch $(uname -m). Skipping."
        exit 2
        ;;
esac

for bin in curl sha256sum docker; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "fetch_image_bundle: $bin is required to fetch/load image bundles." >&2
        exit 1
    fi
done

BOM_TARGET="cool-tunnel-server-images-${OS}-${ARCH}.bom.json"
LEGACY_TARGET="cool-tunnel-server-images-${OS}-${ARCH}.tar.gz"
URL_BASE="${CT_RELEASE_URL_BASE:-https://github.com/coo1white/cool-tunnel-server/releases/download/v${VERSION}}"
BUNDLE_DIR="${CT_IMAGE_BUNDLE_DIR:-.runtime/image-bundles}"
BUNDLE_STREAM_TMPDIR="${CT_IMAGE_BUNDLE_STREAM_TMPDIR:-${TMPDIR:-/tmp}}"
mkdir -p "$BUNDLE_DIR"

curl_fetch() {
    curl -fsSL \
        --connect-timeout "${CT_FETCH_CONNECT_TIMEOUT:-10}" \
        --max-time "${CT_IMAGE_BUNDLE_FETCH_MAX_TIME:-1800}" \
        --retry "${CT_FETCH_RETRIES:-2}" \
        --retry-delay 2 \
        "$@"
}

SUMS=$(curl_fetch "${URL_BASE}/SHA256SUMS" 2>/dev/null || true)
if [[ -z "$SUMS" ]]; then
    echo "fetch_image_bundle: no SHA256SUMS at ${URL_BASE} (release not published?)."
    exit 2
fi
sha_for() {
    echo "$SUMS" | awk -v t="$1" '$2 == t || $2 == "*"t {print $1; exit}'
}

verify_file() {
    local file="$1"
    local expected="$2"
    local actual
    actual=$(sha256sum "$file" | awk '{print $1}')
    if [[ "$actual" != "$expected" ]]; then
        echo "fetch_image_bundle: hash mismatch for $(basename "$file") (got $actual, want $expected)" >&2
        return 1
    fi
}

json_get_string() {
    local file="$1"
    local key="$2"
    jq -r --arg key "$key" '.[$key] // empty' "$file"
}

download_verified() {
    local target="$1"
    local expected="$2"
    local dest="${BUNDLE_DIR}/${target}"

    if [[ -f "$dest" ]]; then
        if verify_file "$dest" "$expected"; then
            echo "fetch_image_bundle: ${target} already downloaded for v${VERSION}." >&2
            printf '%s\n' "$dest"
            return 0
        fi
        rm -f "$dest"
    fi

    echo "fetch_image_bundle: downloading ${target} for v${VERSION}..." >&2
    local new="${dest}.new"
    if ! curl_fetch -o "$new" "${URL_BASE}/${target}"; then
        echo "fetch_image_bundle: download failed for ${URL_BASE}/${target}" >&2
        rm -f "$new"
        return 1
    fi
    if ! verify_file "$new" "$expected"; then
        rm -f "$new"
        return 1
    fi
    mv -f "$new" "$dest"
    printf '%s\n' "$dest"
}

load_image_bom() {
    if ! command -v jq >/dev/null 2>&1; then
        echo "fetch_image_bundle: jq unavailable; falling back to legacy full bundle." >&2
        return 2
    fi

    local bom_expected
    bom_expected=$(sha_for "$BOM_TARGET")
    if [[ -z "$bom_expected" ]]; then
        return 2
    fi

    local bom
    bom=$(download_verified "$BOM_TARGET" "$bom_expected") || return 1

    local kind platform
    kind=$(json_get_string "$bom" kind)
    platform=$(json_get_string "$bom" platform)
    if [[ "$kind" != "cool-tunnel-server-image-bom" || "$platform" != "${OS}/${ARCH/x64/amd64}" ]]; then
        echo "fetch_image_bundle: invalid image BOM metadata in $(basename "$bom")" >&2
        return 1
    fi

    local image_count
    image_count=$(jq '.images | length' "$bom")
    echo "fetch_image_bundle: loading ${image_count} image component(s) from BOM..."
    for idx in $(seq 0 $((image_count - 1))); do
        local name archive_sha part_count stream_dir fifo sha_file stream_rc docker_rc actual_archive_sha
        name=$(jq -r --argjson idx "$idx" '.images[$idx].name' "$bom")
        archive_sha=$(jq -r --argjson idx "$idx" '.images[$idx].archive_sha256' "$bom")
        part_count=$(jq -r --argjson idx "$idx" '.images[$idx].parts | length' "$bom")
        echo "fetch_image_bundle: component ${name} (${part_count} part(s))"

        stream_dir=$(mktemp -d "${BUNDLE_STREAM_TMPDIR%/}/ct-image-bundle.${name}.XXXXXX")
        fifo="${stream_dir}/docker-load.fifo"
        sha_file="${stream_dir}/archive.sha256"
        mkfifo "$fifo"
        docker load < "$fifo" &
        docker_pid=$!

        stream_rc=0
        (
            set -e
            for pidx in $(seq 0 $((part_count - 1))); do
                part_name=$(jq -r --argjson idx "$idx" --argjson pidx "$pidx" '.images[$idx].parts[$pidx].filename' "$bom")
                part_expected=$(jq -r --argjson idx "$idx" --argjson pidx "$pidx" '.images[$idx].parts[$pidx].sha256' "$bom")
                part_path=$(download_verified "$part_name" "$part_expected")
                cat "$part_path"
                if [[ "${CT_KEEP_IMAGE_BUNDLE_PARTS:-0}" != "1" ]]; then
                    rm -f "$part_path"
                fi
            done
        ) | tee "$fifo" | sha256sum | awk '{print $1}' > "$sha_file" || stream_rc=$?
        wait "$docker_pid" || docker_rc=$?
        docker_rc="${docker_rc:-0}"
        rm -f "$fifo"

        if [[ "$stream_rc" -ne 0 ]]; then
            echo "fetch_image_bundle: failed while streaming component ${name}" >&2
            rm -rf "$stream_dir"
            return 1
        fi
        if [[ "$docker_rc" -ne 0 ]]; then
            echo "fetch_image_bundle: docker load failed for component ${name}" >&2
            rm -rf "$stream_dir"
            return 1
        fi

        actual_archive_sha=$(cat "$sha_file")
        rm -rf "$stream_dir"
        if [[ "$actual_archive_sha" != "$archive_sha" ]]; then
            echo "fetch_image_bundle: reassembled archive hash mismatch for ${name} (got ${actual_archive_sha}, want ${archive_sha})" >&2
            return 1
        fi
    done

    echo "fetch_image_bundle: image BOM loaded (${OS}-${ARCH})."
    return 0
}

load_legacy_bundle() {
    local expected bundle
    expected=$(sha_for "$LEGACY_TARGET")
    if [[ -z "$expected" ]]; then
        echo "fetch_image_bundle: no BOM or legacy bundle entry for ${OS}-${ARCH} in SHA256SUMS for v${VERSION}."
        return 2
    fi
    bundle=$(download_verified "$LEGACY_TARGET" "$expected") || return 1
    echo "fetch_image_bundle: loading Docker images from ${LEGACY_TARGET}..."
    if ! docker load -i "$bundle"; then
        echo "fetch_image_bundle: docker load failed for ${bundle}" >&2
        return 1
    fi
    echo "fetch_image_bundle: legacy full bundle loaded (${OS}-${ARCH})."
}

load_image_bom
rc=$?
if [[ "$rc" -ne 0 ]]; then
    if [[ "$rc" -eq 2 ]]; then
        load_legacy_bundle || exit $?
    else
        exit "$rc"
    fi
fi

required=(
    cool-tunnel-server-caddy:latest
    cool-tunnel-server-singbox:latest
    cool-tunnel-server-admin-api:latest
    cool-tunnel-server-admin-web:latest
)
for image in "${required[@]}"; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "fetch_image_bundle: image missing after load: $image" >&2
        exit 1
    fi
done

echo "fetch_image_bundle: prebuilt Docker images ready (${OS}-${ARCH})."
