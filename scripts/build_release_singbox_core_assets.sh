#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Build singbox-core Linux release assets locally.
#
# Maintainers run this on a workstation/VM before publishing a release.
# VPS installs then download and verify these assets instead of running
# Bun install/typecheck/compile inside Docker.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${OUT_DIR:-release-assets}"
BUN="${BUN:-bun}"
TARGETS="${TARGETS:-linux-x64 linux-arm64}"

mkdir -p "$OUT_DIR"

build_one() {
    local suffix="$1"
    local bun_target binary

    case "$suffix" in
        linux-x64)   bun_target="bun-linux-x64-baseline" ;;
        linux-arm64) bun_target="bun-linux-arm64" ;;
        *)
            echo "unsupported target: $suffix" >&2
            return 2
            ;;
    esac

    binary="${OUT_DIR}/singbox-core-${suffix}"
    rm -f "$binary"

    echo "==> building singbox-core-${suffix} (${bun_target})"
    (
        cd singbox-core
        "$BUN" install --frozen-lockfile
        "$BUN" run typecheck
        "$BUN" build --compile --target="$bun_target" \
            src/cli.ts \
            --outfile "../${binary}"
    )
    chmod 0755 "$binary"
    if command -v file >/dev/null 2>&1; then
        file "$binary"
    fi
    sha256sum "$binary"
}

for target in $TARGETS; do
    build_one "$target"
done

(
    cd "$OUT_DIR"
    find . -maxdepth 1 -type f -name 'singbox-core-*' -print0 \
        | sort -z \
        | xargs -0 sha256sum \
        | sed 's#  ./#  #' \
        > SHA256SUMS.singbox-core
)

echo "==> wrote ${OUT_DIR}/SHA256SUMS.singbox-core"
