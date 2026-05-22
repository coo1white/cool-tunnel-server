#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# fetch_singbox_core_binary.sh — fetch the matching singbox-core release
# binary and wrap it as the local cool-tunnel-server-singbox-core image.
#
# Exit codes:
#   0  prebuilt singbox-core image is ready
#   1  integrity/download/docker failure; do not silently ignore
#   2  prebuilt asset unavailable or intentionally skipped

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if [[ "${CT_SKIP_SINGBOX_CORE_BINARY_FETCH:-}" == "1" ]]; then
    echo "fetch_singbox_core_binary: CT_SKIP_SINGBOX_CORE_BINARY_FETCH=1 set, skipping prebuilt singbox-core."
    exit 2
fi

VERSION=$(grep -E "^\s*'version'\s*=>" panel/config/cool-tunnel.php 2>/dev/null \
    | head -1 \
    | sed -E "s/.*'([0-9.]+)'.*/\1/" || true)
if [[ -z "$VERSION" ]]; then
    echo "fetch_singbox_core_binary: cannot determine version from panel/config/cool-tunnel.php" >&2
    exit 1
fi

case "$(uname -s)" in
    Linux) OS=linux ;;
    *)
        echo "fetch_singbox_core_binary: prebuilt singbox-core is linux-only (host: $(uname -s)). Skipping."
        exit 2
        ;;
esac
case "$(uname -m)" in
    x86_64)        ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *)
        echo "fetch_singbox_core_binary: unsupported arch $(uname -m). Skipping."
        exit 2
        ;;
esac

if ! command -v curl >/dev/null 2>&1; then
    echo "fetch_singbox_core_binary: curl is required to fetch release assets." >&2
    exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
    echo "fetch_singbox_core_binary: sha256sum is required to verify release assets." >&2
    exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
    echo "fetch_singbox_core_binary: docker is required to build the local singbox-core image." >&2
    exit 1
fi

TARGET="singbox-core-${OS}-${ARCH}"
URL_BASE="https://github.com/coo1white/cool-tunnel-server/releases/download/v${VERSION}"
BIN_DIR="singbox-core/bin"
RUNTIME_DIR=".runtime/singbox-core-prebuilt/${TARGET}"
IMAGE="${CT_SINGBOX_CORE_IMAGE:-cool-tunnel-server-singbox-core:latest}"
mkdir -p "$BIN_DIR" "$RUNTIME_DIR"

curl_fetch() {
    curl -fsSL \
        --connect-timeout "${CT_FETCH_CONNECT_TIMEOUT:-10}" \
        --max-time "${CT_FETCH_MAX_TIME:-300}" \
        --retry "${CT_FETCH_RETRIES:-2}" \
        --retry-delay 2 \
        "$@"
}

SUMS=$(curl_fetch "${URL_BASE}/SHA256SUMS" 2>/dev/null || true)
if [[ -z "$SUMS" ]]; then
    echo "fetch_singbox_core_binary: no SHA256SUMS at ${URL_BASE} (release not published?)."
    exit 2
fi
EXPECTED=$(echo "$SUMS" | awk -v t="$TARGET" '$2 == t || $2 == "*"t {print $1; exit}')
if [[ -z "$EXPECTED" ]]; then
    echo "fetch_singbox_core_binary: no entry for $TARGET in SHA256SUMS for v${VERSION}."
    exit 2
fi

if [[ -x "${BIN_DIR}/${TARGET}" ]]; then
    ACTUAL=$(sha256sum "${BIN_DIR}/${TARGET}" | awk '{print $1}')
    if [[ "$ACTUAL" == "$EXPECTED" ]]; then
        echo "fetch_singbox_core_binary: ${TARGET} already up to date for v${VERSION}."
    else
        rm -f "${BIN_DIR:?}/${TARGET}"
    fi
fi

if [[ ! -x "${BIN_DIR}/${TARGET}" ]]; then
    echo "fetch_singbox_core_binary: downloading ${TARGET} for v${VERSION}..."
    NEW="${BIN_DIR}/${TARGET}.new"
    if ! curl_fetch -o "$NEW" "${URL_BASE}/${TARGET}"; then
        echo "fetch_singbox_core_binary: download failed for ${URL_BASE}/${TARGET}" >&2
        rm -f "$NEW"
        exit 1
    fi
    ACTUAL=$(sha256sum "$NEW" | awk '{print $1}')
    if [[ "$ACTUAL" != "$EXPECTED" ]]; then
        echo "fetch_singbox_core_binary: hash mismatch (got $ACTUAL, want $EXPECTED)" >&2
        rm -f "$NEW"
        exit 1
    fi
    if command -v gh >/dev/null 2>&1; then
        if ! gh attestation verify "$NEW" \
            --repo coo1white/cool-tunnel-server \
            --signer-workflow .github/workflows/operator-release.yml \
            >/dev/null; then
            echo "fetch_singbox_core_binary: GitHub artifact attestation verification failed" >&2
            rm -f "$NEW"
            exit 1
        fi
        echo "fetch_singbox_core_binary: verified GitHub artifact attestation."
    else
        echo "fetch_singbox_core_binary: gh not installed; verified SHA256 only (install gh for provenance checks)." >&2
    fi
    chmod +x "$NEW"
    mv -f "$NEW" "${BIN_DIR}/${TARGET}"
    echo "fetch_singbox_core_binary: installed ${TARGET}."
fi

cp -f "${BIN_DIR}/${TARGET}" "${RUNTIME_DIR}/singbox-core"
chmod 0755 "${RUNTIME_DIR}/singbox-core"
echo "fetch_singbox_core_binary: building local ${IMAGE} wrapper image..."
if ! docker build \
    -f docker/singbox-core/prebuilt.Dockerfile \
    -t "$IMAGE" \
    "$RUNTIME_DIR"; then
    echo "fetch_singbox_core_binary: failed to build local ${IMAGE} wrapper image" >&2
    exit 1
fi

echo "fetch_singbox_core_binary: prebuilt singbox-core image ready (${IMAGE})."
