#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# render-caddyfile.sh — one-shot render of /etc/caddy/Caddyfile
# from the panel database, executed inside the panel container.
# v0.0.4+ Caddy is the ACME provider only; sing-box reads the
# resulting cert/key files from the shared caddy_data volume.
#
# Equivalent to:
#   docker compose exec panel ct-server-core --json caddyfile render

set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T panel ct-server-core --json caddyfile render "$@"
