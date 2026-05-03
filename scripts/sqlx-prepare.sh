#!/usr/bin/env bash
# sqlx-prepare.sh — regenerate core/.sqlx/ query metadata from the
# live schema.
#
# When to run:
#   - After any change to panel/database/migrations/*.php
#   - After any change to a `sqlx::query!()` / `query_as!()` call
#   - On first checkout if .sqlx/ is missing
#
# What it does:
#   1. Brings up the project's MariaDB container
#   2. Runs Laravel migrations against it
#   3. Sets DATABASE_URL pointing at it
#   4. Installs sqlx-cli locally if missing
#   5. Runs `cargo sqlx prepare` to write core/.sqlx/*.json
#   6. Reports the diff so the operator can git-add/commit
#
# This script is idempotent: re-running on an already-prepared
# tree is a fast no-op when nothing changed.
#
# Robustness: bounded by `set -euo pipefail`, every step prints
# its intent before running, every external command has a clear
# failure path with a "↳ try:" hint.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

# ---------- Pre-flight ---------------------------------------------

step "Pre-flight: tooling"
require_cmd cargo  "https://rustup.rs/  (then: rustup default 1.86)"
require_cmd docker "apt install -y docker.io docker-compose-plugin"
require_file .env "cp .env.example .env  &&  \$EDITOR .env"

# Install sqlx-cli the first time. We pin to 0.8 to match the sqlx
# crate version in core/ct-server-core/Cargo.toml; mismatched majors
# can produce metadata the runtime macro rejects.
if ! command -v cargo-sqlx >/dev/null 2>&1; then
    step "Install sqlx-cli (0.8.x, mysql + native-tls)"
    cargo install sqlx-cli --version '~0.8' --no-default-features \
        --features 'rustls,mysql' --locked
fi
ok "sqlx-cli present"

# ---------- Bring DB up + migrate ---------------------------------

load_env .env

step "Bring up MariaDB (db service)"
compose up -d db
ok "db container starting"

# shellcheck disable=SC2016
wait_for "MariaDB healthcheck" 30 2 \
    bash -c '[[ "$(docker inspect -f "{{.State.Health.Status}}" ct-db 2>/dev/null)" == "healthy" ]]'

step "Bring up panel + run Laravel migrations"
compose up -d panel
# shellcheck disable=SC2016
wait_for "panel vendor/autoload.php" 60 5 \
    bash -c 'docker compose exec -T panel test -f /var/www/html/vendor/autoload.php'
compose exec -T panel php artisan migrate --force --no-interaction
ok "schema is current"

# ---------- Run sqlx prepare --------------------------------------

# Build the DATABASE_URL the macros will use. This URL is local-only
# (the prepare runs on the operator's machine; nothing leaves the
# host) and is reconstructed from .env so secrets stay there.
db_host=${DB_HOST_PUBLIC:-127.0.0.1}
db_port=${DB_PORT_PUBLIC:-3306}
DATABASE_URL="mysql://${DB_USERNAME}:${DB_PASSWORD}@${db_host}:${db_port}/${DB_DATABASE}"

# If the db port isn't host-mapped, fall back to running sqlx prepare
# inside an ephemeral container that's on the same network.
if ! (echo > "/dev/tcp/${db_host}/${db_port}") 2>/dev/null; then
    warn "MariaDB not reachable at ${db_host}:${db_port} from the host;"
    warn "running prepare inside an ephemeral container on ct-data network"

    step "cargo sqlx prepare (containerised)"
    docker run --rm \
        --network cool-tunnel-server_ct-data \
        -v "$PWD/core:/work" \
        -e DATABASE_URL="mysql://${DB_USERNAME}:${DB_PASSWORD}@db:3306/${DB_DATABASE}" \
        -w /work \
        rust:1.86-alpine \
        sh -c 'apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static \
               && cargo install sqlx-cli --version "~0.8" --no-default-features \
                                          --features "rustls,mysql" --locked \
               && cargo sqlx prepare --workspace'
else
    step "cargo sqlx prepare (host)"
    DATABASE_URL="$DATABASE_URL" cargo sqlx prepare --workspace --manifest-path core/Cargo.toml
fi

# ---------- Diff report -------------------------------------------

step "Result"
if git diff --quiet -- core/.sqlx 2>/dev/null; then
    ok "core/.sqlx/ unchanged — schema and queries already in sync"
else
    ok "core/.sqlx/ regenerated"
    git diff --stat -- core/.sqlx 2>/dev/null || true
    cat <<HINT
↳ commit the new metadata so future builds compile offline:

      git add core/.sqlx
      git commit -m "chore(sqlx): refresh offline metadata"
      git push origin main
HINT
fi
