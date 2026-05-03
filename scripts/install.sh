#!/usr/bin/env bash
# install.sh — first-time bootstrap for Cool Tunnel Server.
#
# Run from the repo root after editing .env. Idempotent: safe to
# re-run if anything fails halfway.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
warn() { printf "\033[33m%s\033[0m\n" "$*" >&2; }
die()  { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

# ---- Pre-flight ---------------------------------------------------
[[ -f .env ]] || die ".env not found — copy .env.example to .env first"
command -v docker >/dev/null || die "docker not on PATH"
docker compose version >/dev/null 2>&1 \
    || die "docker compose v2 not available — see docs/installation-debian.md"

# Source .env so we can sanity-check required values.
# shellcheck disable=SC1091
set -a; . .env; set +a

[[ "${DOMAIN:-}"     != "" && "${DOMAIN:-}" != "proxy.example.com" ]] \
    || warn "DOMAIN looks like the placeholder; ACME will fail"
[[ "${ACME_EMAIL:-}" != "" && "${ACME_EMAIL:-}" != "admin@example.com" ]] \
    || warn "ACME_EMAIL looks like the placeholder"
[[ "${DB_PASSWORD:-}"      != "" && "${DB_PASSWORD:-}"      != "change-me-please" ]] \
    || die "DB_PASSWORD is unset / unchanged from the template"
[[ "${REDIS_PASSWORD:-}"   != "" && "${REDIS_PASSWORD:-}"   != "change-me-also"   ]] \
    || die "REDIS_PASSWORD is unset / unchanged from the template"

# ---- Build images -------------------------------------------------
bold "==> Building ct-server-core (Rust)"
docker compose --profile build-only build core-builder

bold "==> Building caddy (xcaddy + forwardproxy@naive)"
docker compose build caddy

bold "==> Building panel (PHP-FPM + Composer + ct-server-core binary)"
docker compose build panel

# ---- Bring up data layer -----------------------------------------
bold "==> Starting db + redis"
docker compose up -d db redis

# Wait for DB healthcheck to go green.
bold "==> Waiting for db healthcheck"
for i in $(seq 1 30); do
    state=$(docker inspect -f '{{.State.Health.Status}}' ct-db 2>/dev/null || echo starting)
    [[ "$state" == "healthy" ]] && break
    sleep 2
    [[ $i -eq 30 ]] && die "db never became healthy"
done

# ---- Bring up panel + run migrations -----------------------------
bold "==> Starting panel"
docker compose up -d panel

# The panel entrypoint runs composer install + migrate, but it's
# best-effort and may race with first-boot timing. Re-run explicitly.
bold "==> Running migrations"
docker compose exec -T panel php artisan migrate --force --no-interaction
docker compose exec -T panel php artisan db:seed --force --no-interaction || true

# ---- Render the initial Caddyfile -------------------------------
bold "==> Rendering initial Caddyfile (no proxy accounts yet)"
docker compose exec -T panel ct-server-core --json caddyfile render || true

# ---- Bring up caddy ----------------------------------------------
bold "==> Starting caddy (ACME will issue certs in the background)"
docker compose up -d caddy

# ---- Create first Filament admin --------------------------------
bold "==> Creating first Filament admin user"
docker compose exec panel php artisan make:filament-user

# ---- OK/NG check -------------------------------------------------
bold "==> Component check"
docker compose exec -T panel ct-server-core component check --manifests /srv/manifests || true

cat <<EOF

$(bold "Cool Tunnel Server is up.")

Panel:        https://${DOMAIN}/admin
Subscription: https://${DOMAIN}/api/v1/subscription/<token>  (issued from the panel)

Watch ACME finish:   docker compose logs -f --tail=80 caddy
Recheck components:  docker compose exec panel ct-server-core component check --manifests /srv/manifests
Run a probe:         docker compose exec panel ct-server-core probe anti-tracking --via "https://<user>:<pass>@${DOMAIN}:443"

Read docs/components.md for how to swap a part. Read Disclaimer.md
before letting anyone else use it.
EOF
