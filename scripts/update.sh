#!/usr/bin/env bash
# update.sh — pull a new release, rebuild, run component check, swap in.
#
# Safe to run on a live server. We bring up the new images alongside
# the old ones, run the OK/NG check, and only swap traffic over if
# everything reports OK. On NG we leave the old images running.

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
die()  { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

[[ -f .env ]] || die ".env missing"

bold "==> git pull"
git pull --ff-only || die "git pull failed (uncommitted changes?)"

bold "==> Rebuild ct-server-core (Rust)"
docker compose --profile build-only build core-builder

bold "==> Rebuild sing-box + panel"
docker compose build sing-box panel

bold "==> Run migrations (idempotent)"
docker compose exec -T panel php artisan migrate --force --no-interaction

bold "==> Re-render sing-box config"
docker compose exec -T panel ct-server-core --json singbox render

bold "==> Component check (post-build, pre-swap)"
if ! docker compose exec -T panel ct-server-core component check --manifests /srv/manifests; then
    die "component check reported NG — aborting swap. Old images still running."
fi

bold "==> Bringing new images up"
docker compose up -d panel sing-box

bold "==> Component check (post-swap)"
docker compose exec -T panel ct-server-core component check --manifests /srv/manifests \
    || die "post-swap check NG — investigate logs"

bold "==> Reload sing-box via clash API"
docker compose exec -T panel ct-server-core server reload

bold "Update complete."
