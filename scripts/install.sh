#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# scripts/install.sh — thin shim.
#
# The canonical first-time-bootstrap workflow lives in
# operator/install.ts. This shim is the curl|bash / bootstrap.sh
# entry point that picks the right runtime:
#
#   1. Compiled ct-operator binary (operator/bin/) — preferred
#      on production VPSes; self-contained, no Bun runtime needed.
#   2. `bun run operator/install.ts` — fallback for development
#      workstations or boxes where the binary hasn't been fetched yet.
#
# Same surface, two runtimes. `./ct install` routes here.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

case "$(uname -m)" in
    x86_64)        arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *)
        echo "install.sh: unsupported arch $(uname -m); the ct-operator binary is published for x64/arm64 only." >&2
        echo "  workaround: install bun (https://bun.sh) and re-run." >&2
        exit 2
        ;;
esac
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
bin="operator/bin/ct-operator-${os}-${arch}"

deployed_version="$(grep -E "^\s*'version'\s*=>" panel/config/cool-tunnel.php 2>/dev/null \
    | head -1 | sed -E "s/.*'([0-9.]+)'.*/\1/" || true)"
installed_version=""
if [[ -x "$bin" ]]; then
    installed_version="$("$bin" version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
fi

if [[ "${CT_SKIP_OPERATOR_BOOTSTRAP:-}" != "1" ]]; then
    if [[ ! -x "$bin" || -z "$installed_version" || "$installed_version" != "$deployed_version" ]]; then
        ./scripts/fetch_operator_binary.sh || true
    fi
fi

if [[ -x "$bin" ]]; then
    exec "$bin" install "$@"
fi

if command -v bun >/dev/null 2>&1; then
    exec bun run operator/install.ts "$@"
fi

# Neither path available. The most actionable suggestion is to
# fetch the operator binary (bootstrap.sh runs this for fresh VPSes;
# it's idempotent on a re-run).
echo "install.sh: no ct-operator binary at $bin and no bun on PATH" >&2
echo "" >&2
echo "Fetch the binary first (idempotent; signed-release verified):" >&2
echo "    ./scripts/fetch_operator_binary.sh" >&2
echo "" >&2
echo "Or install bun for the dev fallback path:" >&2
echo "    curl -fsSL https://bun.sh/install | bash" >&2
exit 1
