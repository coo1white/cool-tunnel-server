#!/usr/bin/env bash
# render-haproxy.sh — one-shot render of /usr/local/etc/haproxy/haproxy.cfg
# from the panel database + PANEL_DOMAIN env var, executed inside
# the panel container. Mirrors render-caddyfile.sh / render-singbox.sh.
#
# v0.0.33 R1-1 / R1-2 — haproxy is the SNI router on :443; this script
# is invoked by install.sh step 11 and on subsequent ServerConfig
# changes that touch the apex domain.
#
# Equivalent to:
#   docker compose exec panel ct-server-core --json haproxy render

set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T panel ct-server-core --json haproxy render "$@"
