#!/usr/bin/env bash
# backup.sh — snapshot db + .env + Caddy ACME state into one tarball.
#
# Drops a timestamped file in ./backups/. ACME state lives in the
# caddy_data volume (post-v0.0.4 — Caddy is the ACME side, sing-box
# reads cert + key files Caddy wrote). Without this, every fresh
# deploy burns Let's Encrypt rate-limit budget on re-issue.

set -euo pipefail
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
compose exec -T db mariadb-dump \
        --single-transaction \
        --quick \
        --routines \
        --triggers \
        -u root \
        -p"${DB_ROOT_PASSWORD}" \
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
docker run --rm \
    -v cool-tunnel-server_caddy_data:/data:ro \
    -v "$PWD/tmp":/out \
    alpine \
    sh -c 'cd /data && tar czf /out/caddy_data.tgz .'
if [[ "$caddy_was_running" == true ]]; then
    compose start caddy >/dev/null
fi
ok "caddy_data.tgz written"

step "Bundle into ${out}"
tar -czf "$out" \
    -C tmp db.sql caddy_data.tgz \
    -C .. .env manifests sing-box/config.json.tpl caddy/Caddyfile.tpl
rm -rf tmp
# shellcheck disable=SC2012  # ls -lh's compact output is exactly what we want here
ok "wrote $(ls -lh "$out" | awk '{print $5,$NF}')"
