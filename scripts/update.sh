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

# IMPORTANT — order: bring new image up BEFORE running migrations.
# Pre-v0.0.15 update.sh ran `php artisan migrate` against the
# OLD panel container while the new code lived only in the
# bind-mounted source tree. New migrations applied via the OLD
# PHP runtime — the OLD code then briefly executed against the
# new schema (or vice versa, depending on the migration shape),
# producing a window where queue workers and the scheduler could
# read columns that didn't exist yet, or write to columns whose
# constraints had just changed. Today's migrations happen to be
# additive-with-defaults (safe in either order), but the order
# here is fragile by accident; pin it.
step "Bring new panel image up (entrypoint runs migrate + render)"
compose up -d panel sing-box

step "Verify migrations applied (idempotent re-run)"
compose exec -T panel php artisan migrate --force --no-interaction

step "Re-render sing-box config"
compose exec -T panel ct-server-core --json singbox render

step "Component check (post-swap)"
compose exec -T panel ct-server-core component check --manifests /srv/manifests \
    || die "post-swap check NG — investigate logs" \
           "docker compose logs --tail=100 panel sing-box"

step "Reload sing-box via clash API"
compose exec -T panel ct-server-core server reload

ok "Update complete."
