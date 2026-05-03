#!/usr/bin/env bash
# backup.sh — snapshot db + .env + caddy_data into one tarball.
#
# Drops a timestamped file in ./backups/. ACME state lives in the
# caddy_data volume; without it, every fresh deploy burns a Let's
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

# --- caddy_data volume → tar ---------------------------------------
echo "==> Snapshotting caddy_data"
docker run --rm \
    -v cool-tunnel-server_caddy_data:/data:ro \
    -v "$PWD/tmp":/out alpine \
    sh -c 'cd /data && tar czf /out/caddy_data.tgz .'

# --- bundle ---------------------------------------------------------
echo "==> Bundling into ${out}"
tar -czf "$out" \
    -C tmp db.sql caddy_data.tgz \
    -C .. .env manifests caddy/Caddyfile.tpl

rm -rf tmp
echo "==> ${out}"
ls -lh "$out"
