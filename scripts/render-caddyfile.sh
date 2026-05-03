#!/usr/bin/env bash
# Convenience wrapper that runs ct-server-core inside the panel
# container. Equivalent to `docker compose exec panel ct-server-core
# caddyfile render` but with the right --json plumbing.

set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T panel ct-server-core --json caddyfile render "$@"
