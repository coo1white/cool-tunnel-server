#!/usr/bin/env bash
# backup.sh — snapshot db + .env + singbox_data into one tarball.
#
# Drops a timestamped file in ./backups/. ACME state lives in the
# singbox_data volume; without it, every fresh deploy burns a Let's
# Encrypt rate-limit.

set -euo pipefail
cd "$(dirname "$0")/.."

ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
out="backups/cool-tunnel-${ts}.tar.gz"
mkdir -p backups tmp

# --- DB dump --------------------------------------------------------
echo "==> Dumping MariaDB"
docker compose exec -T db mariadb-dump \
        --single-transaction \
        --quick \
        --routines \
        --triggers \
        -u root \
        -p"${DB_ROOT_PASSWORD:-$(grep ^DB_ROOT_PASSWORD .env | cut -d= -f2-)}" \
        "${DB_DATABASE:-cooltunnel}" \
    > tmp/db.sql

# --- singbox_data volume → tar ---------------------------------------
echo "==> Snapshotting singbox_data"
docker run --rm \
    -v cool-tunnel-server_singbox_data:/data:ro \
    -v "$PWD/tmp":/out alpine \
    sh -c 'cd /data && tar czf /out/singbox_data.tgz .'

# --- bundle ---------------------------------------------------------
echo "==> Bundling into ${out}"
tar -czf "$out" \
    -C tmp db.sql singbox_data.tgz \
    -C .. .env manifests sing-box/config.json.tpl

rm -rf tmp
echo "==> ${out}"
ls -lh "$out"
