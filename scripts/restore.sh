#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# restore.sh — bring a fresh box up from a `backup.sh` tarball.
#
# Companion to scripts/backup.sh. Pre-v0.0.15 the project shipped a
# one-way backup with no documented restore path — operators with a
# tarball couldn't actually use it. This script is the documented
# recovery procedure: untar, restore .env + manifests + templates,
# bring up db + redis, mariadb-import the dump, restore the
# caddy_data volume from the tgz, then bring the rest of the stack
# up. Idempotent on a partial run — re-invocable.
#
# Usage:
#     ./scripts/restore.sh path/to/cool-tunnel-YYYY-MM-DDTHH-MM-SSZ.tar.gz

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

if [[ $# -ne 1 ]]; then
    die "usage: ./scripts/restore.sh <backup.tar.gz>" \
        "ls backups/"
fi

BACKUP_TGZ="$1"
require_file "$BACKUP_TGZ" "did you mean a file under backups/?"
require_docker

# Refuse to restore over a populated stack — too easy to nuke a live
# deployment by typing the wrong path. Operator must explicitly
# `docker compose down -v` first if they really mean to overwrite.
if compose ps -q 2>/dev/null | grep -q .; then
    die "stack is currently running — refusing to restore over it" \
        "docker compose down -v   # ⚠️  destroys the current stack"
fi

# ---------- Stage 1 — untar + restore source-tree state -----------

step "Stage backup tarball under tmp/restore"
rm -rf tmp/restore
mkdir -p tmp/restore
tar -xzf "$BACKUP_TGZ" -C tmp/restore
ls tmp/restore | head -10

step "Restore .env, manifests, templates"
# These files are in-tree and tracked, but the operator's edits
# (DOMAIN, *_PASSWORD, CT_CLASH_SECRET_SEED) live only in .env.
# Without these, sing-box won't render the same config and any
# previously-issued subscription tokens won't verify.
cp tmp/restore/.env .env
chmod 0600 .env
cp -r tmp/restore/manifests .
cp tmp/restore/sing-box/config.json.tpl sing-box/config.json.tpl 2>/dev/null || true
cp tmp/restore/caddy/Caddyfile.tpl     caddy/Caddyfile.tpl     2>/dev/null || true
# haproxy template captured by backup.sh as of round-9 DR audit;
# legacy backups (pre-round-9) lack it — `|| true` falls back to
# the in-tree post-update template, which is the correct
# behaviour for older backups.
cp tmp/restore/haproxy/haproxy.cfg.tpl haproxy/haproxy.cfg.tpl 2>/dev/null || true
ok ".env restored (mode 0600), manifests + templates in place"

# ---------- Stage 2 — bring up data layer first -------------------

load_env .env

step "Bring up db + redis (NOT panel/sing-box yet)"
compose up -d db redis
# shellcheck disable=SC2016
wait_for "MariaDB healthcheck" 30 2 \
    bash -c '[[ "$(docker inspect -f "{{.State.Health.Status}}" ct-db 2>/dev/null)" == "healthy" ]]'

# ---------- Stage 3 — import db.sql -------------------------------

step "Import db.sql into MariaDB"
# `mariadb` (the client) accepts the dump on stdin. Don't use
# --force — if the import fails, we want the operator to see the
# error and decide, not silently end up with a partially-restored
# DB. Idempotency: subsequent re-runs over an already-imported DB
# will fail with "table exists" — that's the correct signal that
# this stage already ran. Operator drops + re-creates the DB if
# they want to retry.
compose exec -T db sh -c "mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" \"\${MARIADB_DATABASE:-cooltunnel}\"" \
    < tmp/restore/db.sql \
    || die "db.sql import failed — see ct-db logs" \
           "docker compose logs --tail=50 db"
ok "db.sql imported"

# ---------- Stage 4 — restore caddy_data volume -------------------

step "Restore caddy_data volume from caddy_data.tgz"
# Round-24: derive the project-prefixed volume name from
# docker-compose itself (see backup.sh for the parallel-
# deployment rationale).
caddy_data_volume="$(compose_project_name)_caddy_data"
# Volume must already exist (compose up -d above created it
# via the panel/caddy services even though they're not running).
# If for some reason the volume isn't present, create explicitly.
docker volume inspect "$caddy_data_volume" >/dev/null 2>&1 \
    || docker volume create "$caddy_data_volume" >/dev/null
docker run --rm \
    -v "${caddy_data_volume}:/data" \
    -v "$PWD/tmp/restore":/in:ro \
    alpine \
    sh -c 'cd /data && tar xzf /in/caddy_data.tgz'
ok "caddy_data restored (ACME certs + private keys, into ${caddy_data_volume})"

# ---------- Stage 5 — bring up the rest of the stack --------------

step "Bring up panel + caddy + sing-box"
compose up -d panel
# shellcheck disable=SC2016
# Wait for the entrypoint-complete sentinel — same pattern
# install.sh uses (post-v0.0.26 race fix). Pre-fix this restore
# script polled for `vendor/autoload.php`, which appears as
# soon as composer install starts laying out files but BEFORE
# the entrypoint has run migrate / seed / config:cache / asset
# publish. A `compose exec panel ct-server-core component
# check` immediately after that early signal would race the
# in-flight migrate. Sentinel-based wait is the right
# contract: presence-of-sentinel == "this entrypoint run
# finished cleanly." (round-9 DR audit fix.)
wait_for "panel entrypoint sentinel" 90 5 \
    bash -c 'docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete'

compose up -d caddy sing-box
sleep 5

step "Component check"
component_check_strict /srv/manifests \
    || warn "some components NG — investigate before serving real users"

# ---------- Done --------------------------------------------------

rm -rf tmp/restore

cat <<EOF

${CT_BOLD}${CT_GREEN}Restore complete.${CT_RESET}

  Panel         https://${PANEL_DOMAIN:-?}/admin    (or via SSH-local-port-forward to 127.0.0.1:9000)
  Subscription  https://${PANEL_DOMAIN:-?}/api/v1/subscription/<token>

Next:
  1. Tail logs:    docker compose logs -f --tail=80
  2. Confirm proxy: ./scripts/late-night-comeback.sh
  3. Test subscription: curl one of the manifest URLs you had before

If the restored .env had a different CT_CLASH_SECRET_SEED than the
running stack expected (you ran restore mid-flight without first
\`compose down\`), bearer mismatches will show up as panel→sing-box
clash-API 401s — \`docker compose restart panel sing-box\` resolves it.
EOF
