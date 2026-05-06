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
# Cargo is OPTIONAL — the host path is faster when it's available
# (laptop / dev box), but on a fresh VPS we run prepare inside a
# rust:1.86-alpine container so the operator doesn't need to
# install rustup just to refresh schema metadata. Only docker is
# strictly required.
require_cmd docker "apt install -y docker.io docker-compose-plugin"
require_file .env "cp .env.example .env  &&  \$EDITOR .env"

USE_CONTAINER=0
if ! command -v cargo >/dev/null 2>&1; then
    USE_CONTAINER=1
    ok "cargo not on host — will run prepare inside rust:1.86-alpine container"
elif ! command -v cargo-sqlx >/dev/null 2>&1; then
    step "Install sqlx-cli (0.8.x, mysql + rustls)"
    cargo install sqlx-cli --version '~0.8' --no-default-features \
        --features 'rustls,mysql' --locked
    ok "sqlx-cli present"
else
    ok "cargo + sqlx-cli on host"
fi

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
# `migrate --force` is a no-op when migrations are already applied
# (Laravel checks the migrations table). Idempotent.
compose exec -T panel php artisan migrate --force --no-interaction
ok "schema is current"

# ---------- Run sqlx prepare --------------------------------------

# DATABASE_URL the macros will use. Reconstructed from .env so
# secrets stay there. 127.0.0.1 + port-forward is the only path
# this script ever takes (the containerised path was scaffolded in
# v0.0.7 but never wired up — removed to clear SC2034).
HOST_DATABASE_URL="mysql://${DB_USERNAME}:${DB_PASSWORD}@127.0.0.1:3306/${DB_DATABASE}"

run_in_container() {
    # Build the project's own sqlx-prepare image (a stage of
    # docker/core/Dockerfile) — BuildKit reuses the cached
    # rust:1.86-alpine + alpine layers from previous core-builder
    # builds, so no fresh Docker Hub pull is needed (rate-limit-safe).
    # First run takes ~3-5 min on a 1-vCPU VPS to compile sqlx-cli;
    # subsequent runs land in seconds because the layer is cached.
    step "Build sqlx-prepare image (cached after first run)"
    compose --profile sqlx build sqlx-prepare

    step "cargo sqlx prepare (compose service)"
    compose --profile sqlx run --rm sqlx-prepare prepare --workspace
}

if [[ "$USE_CONTAINER" == 1 ]]; then
    run_in_container
elif (echo > "/dev/tcp/127.0.0.1/3306") 2>/dev/null; then
    step "cargo sqlx prepare (host)"
    DATABASE_URL="$HOST_DATABASE_URL" \
        cargo sqlx prepare --workspace --manifest-path core/Cargo.toml
else
    warn "MariaDB not reachable at 127.0.0.1:3306 from host"
    warn "(no port mapping) — falling through to containerised prepare"
    run_in_container
fi

# ---------- Diff report -------------------------------------------

step "Result"
# `git diff` only surfaces tracked changes; on FIRST prepare the
# .sqlx files are untracked (never been committed), so we have to
# check both: tracked-modifications AND new-untracked.
tracked_diff=0
git diff --quiet -- core/.sqlx 2>/dev/null || tracked_diff=1
untracked_count=$(git ls-files --others --exclude-standard -- core/.sqlx 2>/dev/null | wc -l)

if [[ "$tracked_diff" == 0 && "$untracked_count" == 0 ]]; then
    ok "core/.sqlx/ unchanged — schema and queries already in sync"
else
    ok "core/.sqlx/ regenerated"
    if [[ "$untracked_count" -gt 0 ]]; then
        printf "    new files: %d\n" "$untracked_count"
    fi
    git diff --stat -- core/.sqlx 2>/dev/null || true
    cat <<HINT
↳ commit the new metadata so future builds compile offline:

      git add core/.sqlx
      git commit -m "chore(sqlx): refresh offline metadata"
      git push origin main
HINT
fi
