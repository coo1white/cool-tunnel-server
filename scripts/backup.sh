#!/usr/bin/env bash
# backup.sh — snapshot db + .env + sing-box ACME data into one tarball.
#
# Drops a timestamped file in ./backups/. ACME state lives in the
# singbox_data volume; without it, every fresh deploy burns Let's
# Encrypt rate-limit budget.

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

step "Snapshot singbox_data volume (ACME state)"
docker run --rm \
    -v cool-tunnel-server_singbox_data:/data:ro \
    -v "$PWD/tmp":/out \
    alpine \
    sh -c 'cd /data && tar czf /out/singbox_data.tgz .'
ok "singbox_data.tgz written"

step "Bundle into ${out}"
tar -czf "$out" \
    -C tmp db.sql singbox_data.tgz \
    -C .. .env manifests sing-box/config.json.tpl
rm -rf tmp
# shellcheck disable=SC2012  # ls -lh's compact output is exactly what we want here
ok "wrote $(ls -lh "$out" | awk '{print $5,$NF}')"
