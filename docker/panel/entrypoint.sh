#!/usr/bin/env bash
# entrypoint for the panel container — first-boot install + boot.
set -euo pipefail

cd /var/www/html

# Make sure composer can write the home dir.
export COMPOSER_HOME=/tmp/composer
mkdir -p "$COMPOSER_HOME" storage/framework/{cache,sessions,views} storage/logs bootstrap/cache
chmod -R 0775 storage bootstrap/cache 2>/dev/null || true

# ct-server-core daemon's unix-socket lives under /run/cool-tunnel.
# Pre-create with mode 0770 so supervisord's daemon program can bind.
mkdir -p /run/cool-tunnel && chmod 0770 /run/cool-tunnel || true

# php-fpm pool config: listen on a TCP port so nginx in the same
# container can talk to it without a unix socket race.
cat >/usr/local/etc/php-fpm.d/zz-pool.conf <<'POOL'
[www]
user = www-data
group = www-data
listen = 127.0.0.1:9001
listen.allowed_clients = 127.0.0.1
pm = dynamic
pm.max_children = 16
pm.start_servers = 4
pm.min_spare_servers = 2
pm.max_spare_servers = 6
clear_env = no
catch_workers_output = yes
decorate_workers_output = no
POOL

# First-boot: pull dependencies if vendor/ is missing.
if [ ! -d vendor ]; then
    echo "[entrypoint] vendor/ missing — running composer install"
    composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader
fi

# Generate APP_KEY if it isn't set.
if ! grep -q '^APP_KEY=base64:' .env 2>/dev/null; then
    echo "[entrypoint] APP_KEY missing — generating"
    php artisan key:generate --force
fi

# Wait for the database before migrating. We retry up to 60s.
for i in $(seq 1 30); do
    if php artisan db:show >/dev/null 2>&1; then
        break
    fi
    echo "[entrypoint] waiting for db ($i/30)…"
    sleep 2
done

php artisan migrate --force --no-interaction || true
php artisan filament:cache-components --no-interaction || true
php artisan config:cache  --no-interaction || true
php artisan route:cache   --no-interaction || true
php artisan view:cache    --no-interaction || true

# Render the initial Caddyfile + sing-box config from the DB so both
# servers have something to load on first boot. The CaddyfileGenerator
# writes to /etc/caddy (mounted from caddy_etc volume), the
# SingBoxConfigGenerator writes to /etc/sing-box (singbox_etc).
php artisan caddyfile:render --no-interaction || true
php artisan singbox:render   --no-interaction || true

exec "$@"
