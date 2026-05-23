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

VERSION=$(grep -E "^\s*'version'\s*=>" panel/config/cool-tunnel.php 2>/dev/null \
    | head -1 \
    | sed -E "s/.*'([0-9.]+)'.*/\1/" || true)
if [[ -z "$VERSION" ]]; then
    echo "fetch_image_bundle: cannot determine version from panel/config/cool-tunnel.php" >&2
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

TARGET="cool-tunnel-server-images-${OS}-${ARCH}.tar.gz"
URL_BASE="https://github.com/coo1white/cool-tunnel-server/releases/download/v${VERSION}"
BUNDLE_DIR=".runtime/image-bundles"
BUNDLE="${BUNDLE_DIR}/${TARGET}"
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
EXPECTED=$(echo "$SUMS" | awk -v t="$TARGET" '$2 == t || $2 == "*"t {print $1; exit}')
if [[ -z "$EXPECTED" ]]; then
    echo "fetch_image_bundle: no entry for $TARGET in SHA256SUMS for v${VERSION}."
    exit 2
fi

if [[ -f "$BUNDLE" ]]; then
    ACTUAL=$(sha256sum "$BUNDLE" | awk '{print $1}')
    if [[ "$ACTUAL" == "$EXPECTED" ]]; then
        echo "fetch_image_bundle: ${TARGET} already downloaded for v${VERSION}."
    else
        rm -f "$BUNDLE"
    fi
fi

if [[ ! -f "$BUNDLE" ]]; then
    echo "fetch_image_bundle: downloading ${TARGET} for v${VERSION}..."
    NEW="${BUNDLE}.new"
    if ! curl_fetch -o "$NEW" "${URL_BASE}/${TARGET}"; then
        echo "fetch_image_bundle: download failed for ${URL_BASE}/${TARGET}" >&2
        rm -f "$NEW"
        exit 1
    fi
    ACTUAL=$(sha256sum "$NEW" | awk '{print $1}')
    if [[ "$ACTUAL" != "$EXPECTED" ]]; then
        echo "fetch_image_bundle: hash mismatch (got $ACTUAL, want $EXPECTED)" >&2
        rm -f "$NEW"
        exit 1
    fi
    mv -f "$NEW" "$BUNDLE"
    echo "fetch_image_bundle: downloaded ${TARGET}."
fi

echo "fetch_image_bundle: loading Docker images from ${TARGET}..."
if ! docker load -i "$BUNDLE"; then
    echo "fetch_image_bundle: docker load failed for ${BUNDLE}" >&2
    exit 1
fi

required=(
    cool-tunnel-server-core:latest
    cool-tunnel-server-singbox-core:latest
    cool-tunnel-server-caddy:latest
    cool-tunnel-server-singbox:latest
    cool-tunnel-server-panel:latest
    mariadb:11.8.6
    redis:7.4.8-alpine
)
for image in "${required[@]}"; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "fetch_image_bundle: image missing after load: $image" >&2
        exit 1
    fi
done

echo "fetch_image_bundle: prebuilt Docker images ready (${OS}-${ARCH})."
