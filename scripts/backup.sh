#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# backup.sh — snapshot db + .env + Caddy ACME state into one tarball.
#
# Drops a timestamped file in ./backups/. ACME state lives in the
# caddy_data volume (post-v0.0.4 — Caddy is the ACME side, sing-box
# reads cert + key files Caddy wrote). Without this, every fresh
# deploy burns Let's Encrypt rate-limit budget on re-issue.

set -euo pipefail

# umask 0077 — round-9 DR audit fix. Pre-fix the tarball
# inherited the operator's umask (commonly 0644 on Debian),
# leaving `cool-tunnel-${ts}.tar.gz` world-readable. The
# tarball contains `.env` (APP_KEY, DB_ROOT_PASSWORD,
# REDIS_PASSWORD, CT_CLASH_SECRET_SEED) AND the full DB dump
# (every encrypted password blob — useless without APP_KEY,
# but APP_KEY is RIGHT THERE in the same archive). On a
# multi-user host or a backup-staging server, anyone with
# read access to `backups/` recovers all tenant cleartext.
# 0077 makes new files mode 0600; the tarball + tmp/* land
# operator-only.
umask 0077

cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

require_file .env "cp .env.example .env  &&  \$EDITOR .env"
require_docker
load_env .env

ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
out="backups/cool-tunnel-${ts}.tar.gz"
mkdir -p backups tmp

step "Dump MariaDB (consistent snapshot)"
# Pre-v0.0.17 the password was passed via -p"${DB_ROOT_PASSWORD}"
# on the docker exec command line. The whole command — including
# the literal password — surfaces in `ps -ef` on the host (and on
# the container) for the duration of the dump. On a multi-tenant
# host or one with operator monitoring tooling, that's a real
# leakage path. Switch to MYSQL_PWD via env: the docker exec
# `--env` flag passes the password through environment, never
# touches argv. mariadb-dump auto-reads MYSQL_PWD when no -p is
# given. (v0.0.17 supply-chain hygiene.)
compose exec -T -e MYSQL_PWD="${DB_ROOT_PASSWORD}" db \
    mariadb-dump \
        --single-transaction \
        --quick \
        --routines \
        --triggers \
        -u root \
        "${DB_DATABASE:-cooltunnel}" \
    > tmp/db.sql
ok "db.sql written"

step "Snapshot caddy_data volume (ACME certificates + private keys)"
# Quiesce caddy first — pre-v0.0.15 we tarred the running volume
# and a cert renewal completing mid-tar would land a half-written
# *.crt or *.key in the archive. The 1-2 minute downtime on :80
# is acceptable for backup; the proxy traffic on :443 is
# unaffected (sing-box reads the cert from a different mount and
# keeps serving with the in-memory cert until next reload).
caddy_was_running=false
if compose ps -q caddy 2>/dev/null | grep -q .; then
    caddy_was_running=true
    compose stop caddy >/dev/null
fi
# Round-24: derive the project-prefixed volume name from
# docker-compose itself instead of hardcoding "cool-tunnel-
# server_caddy_data" — operators running parallel deployments
# at /opt/ct-prod/ and /opt/ct-staging/ get different project
# names, and the hardcode would target the wrong volume.
caddy_data_volume="$(compose_project_name)_caddy_data"
docker run --rm \
    -v "${caddy_data_volume}:/data:ro" \
    -v "$PWD/tmp":/out \
    alpine \
    sh -c 'cd /data && tar czf /out/caddy_data.tgz .'
if [[ "$caddy_was_running" == true ]]; then
    compose start caddy >/dev/null
fi
ok "caddy_data.tgz written (from volume ${caddy_data_volume})"

step "Bundle into ${out}"
# haproxy/haproxy.cfg.tpl added in round 9 — pre-fix backup
# missed it; restore would silently fall back to the post-
# update tree's template (which may have drifted from what
# was running in production at backup time). All three
# render-input templates (sing-box, caddy, haproxy) are now
# captured for byte-identical restore.
tar -czf "$out" \
    -C tmp db.sql caddy_data.tgz \
    -C .. .env manifests \
        sing-box/config.json.tpl \
        caddy/Caddyfile.tpl \
        haproxy/haproxy.cfg.tpl
chmod 0600 "$out"
rm -rf tmp
# shellcheck disable=SC2012  # ls -lh's compact output is exactly what we want here
ok "wrote $(ls -lh "$out" | awk '{print $5,$NF}') (mode 0600 — operator-only)"
