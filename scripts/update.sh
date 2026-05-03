#!/usr/bin/env bash
# update.sh — pull a new release, rebuild, run component check, swap in.
#
# Safe to run on a live server. We bring up the new images alongside
# the old ones, run the OK/NG check, and only swap traffic over if
# everything reports OK. On NG we leave the old images running.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

require_file .env "cp .env.example .env  &&  \$EDITOR .env"
require_docker

step "git pull (fast-forward only)"
git pull --ff-only \
    || die "git pull failed (uncommitted changes?)" \
           "stash or commit your local edits first"

step "Rebuild ct-server-core (Rust)"
compose --profile build-only build core-builder

step "Rebuild sing-box + panel"
compose build sing-box panel

step "Run migrations (idempotent)"
compose exec -T panel php artisan migrate --force --no-interaction

step "Re-render sing-box config"
compose exec -T panel ct-server-core --json singbox render

step "Component check (post-build, pre-swap)"
compose exec -T panel ct-server-core component check --manifests /srv/manifests \
    || die "component check reported NG — aborting swap. Old images still running." \
           "see docker compose logs panel sing-box"

step "Bringing new images up"
compose up -d panel sing-box

step "Component check (post-swap)"
compose exec -T panel ct-server-core component check --manifests /srv/manifests \
    || die "post-swap check NG — investigate logs" \
           "docker compose logs --tail=100 panel sing-box"

step "Reload sing-box via clash API"
compose exec -T panel ct-server-core server reload

ok "Update complete."
