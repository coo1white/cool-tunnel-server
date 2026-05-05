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
#
# Tunables (each can be overridden via container env / .env):
#   PHP_FPM_PM_MODE         dynamic | ondemand | static  (default: ondemand)
#   PHP_FPM_MAX_CHILDREN    upper bound on concurrent FPM workers (default: 4)
#   PHP_FPM_IDLE_TIMEOUT    seconds an idle worker survives before exit (default: 60s)
#   PHP_FPM_MAX_REQUESTS    requests per worker before respawn (default: 500)
#
# Defaults are tuned for a 1 vCPU / 1 GB VPS — pre-2026-05-05 the
# pool was `pm = dynamic` with `max_children = 16`, which on a tiny
# server was a 480-800 MiB worst-case (each FPM worker resident is
# ~30-50 MiB after Laravel + Filament are loaded). `ondemand` only
# spawns when a request arrives and lets workers exit on idle, so
# the steady-state cost drops to roughly one warm worker. Operators
# on bigger boxes raise the cap via env without re-rolling the image.
PM_MODE="${PHP_FPM_PM_MODE:-ondemand}"
PM_MAX_CHILDREN="${PHP_FPM_MAX_CHILDREN:-4}"
PM_IDLE_TIMEOUT="${PHP_FPM_IDLE_TIMEOUT:-60s}"
PM_MAX_REQUESTS="${PHP_FPM_MAX_REQUESTS:-500}"

cat >/usr/local/etc/php-fpm.d/zz-pool.conf <<POOL
[www]
user = www-data
group = www-data
listen = 127.0.0.1:9001
listen.allowed_clients = 127.0.0.1
pm = ${PM_MODE}
pm.max_children = ${PM_MAX_CHILDREN}
pm.process_idle_timeout = ${PM_IDLE_TIMEOUT}
pm.max_requests = ${PM_MAX_REQUESTS}
clear_env = no
catch_workers_output = yes
decorate_workers_output = no
POOL

# `dynamic` requires the start/min/max-spare trio; emit them only
# when the operator opted into that mode (otherwise php-fpm refuses
# to start with "pm.start_servers required" or similar).
if [ "${PM_MODE}" = "dynamic" ]; then
    cat >>/usr/local/etc/php-fpm.d/zz-pool.conf <<POOL
pm.start_servers = ${PHP_FPM_START_SERVERS:-2}
pm.min_spare_servers = ${PHP_FPM_MIN_SPARE:-1}
pm.max_spare_servers = ${PHP_FPM_MAX_SPARE:-3}
POOL
fi

# First-boot: pull dependencies if vendor/ is missing.
#
# Supply-chain hardening (v0.0.16): pass --no-scripts to composer.
# Without it, every transitive package's post-install /
# post-autoload-dump hook would execute as the panel user with
# full filesystem + DB access on every fresh container start. The
# project's own composer.json registers two known scripts via
# post-autoload-dump (`Illuminate\\Foundation\\ComposerScripts::
# postAutoloadDump` + `php artisan package:discover --ansi`); we
# explicitly invoke `package:discover` after install rather than
# letting any hook run blanket. ComposerScripts::postAutoloadDump
# is a Laravel-internal helper that matters only when the
# autoloader is generated WITHOUT --optimize-autoloader; we pass
# --optimize-autoloader so it isn't needed.
if [ ! -d vendor ]; then
    echo "[entrypoint] vendor/ missing — running composer install"
    composer install \
        --no-dev \
        --no-interaction \
        --prefer-dist \
        --optimize-autoloader \
        --no-scripts
    php artisan package:discover --ansi
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

# Seed the singleton ServerConfig row + the three cover-site templates.
# Both paths are idempotent (ServerConfig::current() is firstOrCreate
# on id=1, FakeWebsite::create runs only when count()===0), so this is
# safe to run on every boot — and required to run BEFORE the renderer
# below. Without this seed pass on first boot, the renderer crashes
# with "no rows returned by a query that expected to return at least
# one row" because server_configs.id=1 doesn't exist yet, leaving
# Caddyfile empty and Caddy unable to fetch a TLS cert. install.sh
# also runs db:seed (after the migrate-status check) but that path
# would fail-open if the renderer needs the seed before install.sh
# gets a chance — duplicating it here closes the gap. (v0.0.27 hotfix
# — first real-world Debian 13 deploy on a clean db_data volume hit
# this once the v0.0.26 race fix unblocked the renderer.)
php artisan db:seed --force --no-interaction || true

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

# Sentinel for install.sh — signals first-boot setup (composer +
# migrate + cache + render) is finished and it's safe to query
# state without racing the entrypoint. v0.0.26 race-fix: install.sh
# previously ran its own `migrate` immediately after `vendor/
# autoload.php` appeared, which raced this entrypoint's migrate
# above and crashed with "Table 'cache' already exists" when the
# install-side process saw migration #1 mid-transaction (cache
# table created, migrations row not yet inserted). /tmp is tmpfs
# in this container, so the sentinel auto-clears on restart and
# the next first-boot run waits cleanly.
mkdir -p /tmp/cool-tunnel
: >/tmp/cool-tunnel/entrypoint-complete

exec "$@"
