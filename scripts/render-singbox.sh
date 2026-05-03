#!/usr/bin/env bash
# render-singbox.sh — one-shot render of the sing-box config from
# the panel database, executed inside the panel container. Pass
# --if-changed to skip the rewrite when nothing has moved (cert
# mtime + DB rows hash unchanged).
#
# Equivalent to:
#   docker compose exec panel ct-server-core --json singbox render

set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T panel ct-server-core --json singbox render "$@"
