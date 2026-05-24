#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Bun admin panel entrypoint.
set -euo pipefail

cd /opt/cool-tunnel/operator

mkdir -p /tmp/cool-tunnel /data/admin /data/config /run/cool-tunnel
rm -f /tmp/cool-tunnel/entrypoint-complete

chmod 0700 /data/admin /run/cool-tunnel 2>/dev/null || true

if [ -z "${BETTER_AUTH_SECRET:-}" ] && [ -n "${AUTH_SECRET:-}" ]; then
    export BETTER_AUTH_SECRET="$AUTH_SECRET"
fi

if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
    echo "[entrypoint] FATAL: BETTER_AUTH_SECRET is empty; run ct update or set it in .env" >&2
    exit 1
fi

bun run src/index.ts admin migrate
bun run src/index.ts render caddyfile || echo "[entrypoint] WARN: initial Caddyfile render failed" >&2
bun run src/index.ts render singbox || echo "[entrypoint] WARN: initial singbox render failed" >&2

: >/tmp/cool-tunnel/entrypoint-complete

exec "$@"
