#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# fetch_operator_binary.sh — fetch the matching ct-operator binary
# from the GitHub release for the deployed version.
#
# Called by bootstrap/update as a post-deploy step. A failed refresh
# leaves the existing binary in place; binary-only commands fail with a
# clear remediation if no operator binary is available.
# Can also be invoked directly: `make operator-fetch`.
#
# Idempotent. Opt out by exporting CT_SKIP_OPERATOR_FETCH=1.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if [[ "${CT_SKIP_OPERATOR_FETCH:-}" == "1" ]]; then
    echo "fetch_operator_binary: CT_SKIP_OPERATOR_FETCH=1 set, skipping."
    exit 0
fi

# Deployed version — panel config is the runtime source of truth
# (matches what `ct version` prints; see `make set-version`).
VERSION=$(grep -E "^\s*'version'\s*=>" panel/config/cool-tunnel.php 2>/dev/null \
    | head -1 \
    | sed -E "s/.*'([0-9.]+)'.*/\1/" || true)
if [[ -z "$VERSION" ]]; then
    echo "fetch_operator_binary: cannot determine version from panel/config/cool-tunnel.php" >&2
    exit 1
fi

# Host OS / arch. The operator binary is published for Linux only
# (linux-x64, linux-arm64); darwin-arm64 is shipped for dev machines
# but not auto-fetched on VPSes.
case "$(uname -s)" in
    Linux) OS=linux ;;
    *)
        echo "fetch_operator_binary: auto-fetch is linux-only (host: $(uname -s)). Skipping."
        exit 0
        ;;
esac
case "$(uname -m)" in
    x86_64)        ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *)
        echo "fetch_operator_binary: unsupported arch $(uname -m). Skipping."
        exit 0
        ;;
esac

TARGET="ct-operator-${OS}-${ARCH}"
URL_BASE="https://github.com/coo1white/cool-tunnel-server/releases/download/v${VERSION}"
BIN_DIR="operator/bin"
mkdir -p "$BIN_DIR"

curl_fetch() {
    curl -fsSL \
        --connect-timeout "${CT_FETCH_CONNECT_TIMEOUT:-10}" \
        --max-time "${CT_FETCH_MAX_TIME:-300}" \
        --retry "${CT_FETCH_RETRIES:-2}" \
        --retry-delay 2 \
        "$@"
}

# Fetch the manifest first. If the release doesn't exist yet (dev
# branch ahead of any tag, or a release that hasn't been cut), this is
# a no-op so a development checkout can keep running from source.
SUMS=$(curl_fetch "${URL_BASE}/SHA256SUMS" 2>/dev/null || true)
if [[ -z "$SUMS" ]]; then
    echo "fetch_operator_binary: no SHA256SUMS at ${URL_BASE} (release not published?). Skipping."
    exit 0
fi
EXPECTED=$(echo "$SUMS" | awk -v t="$TARGET" '$2 == t || $2 == "*"t {print $1; exit}')
if [[ -z "$EXPECTED" ]]; then
    echo "fetch_operator_binary: no entry for $TARGET in SHA256SUMS for v${VERSION}. Skipping."
    exit 0
fi

# Idempotency: skip if the existing binary already matches the
# manifest. A re-run on an up-to-date deploy is a no-op.
if [[ -x "${BIN_DIR}/${TARGET}" ]]; then
    ACTUAL=$(sha256sum "${BIN_DIR}/${TARGET}" | awk '{print $1}')
    if [[ "$ACTUAL" == "$EXPECTED" ]]; then
        echo "fetch_operator_binary: ${TARGET} already up to date for v${VERSION}."
        exit 0
    fi
fi

echo "fetch_operator_binary: downloading ${TARGET} for v${VERSION}..."
NEW="${BIN_DIR}/${TARGET}.new"
if ! curl_fetch -o "$NEW" "${URL_BASE}/${TARGET}"; then
    echo "fetch_operator_binary: download failed for ${URL_BASE}/${TARGET}" >&2
    rm -f "$NEW"
    exit 1
fi
ACTUAL=$(sha256sum "$NEW" | awk '{print $1}')
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "fetch_operator_binary: hash mismatch (got $ACTUAL, want $EXPECTED)" >&2
    rm -f "$NEW"
    exit 1
fi
if command -v gh >/dev/null 2>&1; then
    if ! gh attestation verify "$NEW" \
        --repo coo1white/cool-tunnel-server \
        --signer-workflow .github/workflows/operator-release.yml \
        >/dev/null; then
        echo "fetch_operator_binary: GitHub artifact attestation verification failed" >&2
        rm -f "$NEW"
        exit 1
    fi
    echo "fetch_operator_binary: verified GitHub artifact attestation."
else
    echo "fetch_operator_binary: gh not installed; verified SHA256 only (install gh for provenance checks)." >&2
fi
chmod +x "$NEW"
mv -f "$NEW" "${BIN_DIR}/${TARGET}"
echo "fetch_operator_binary: installed ${TARGET}."
