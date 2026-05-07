#!/usr/bin/env bash
# entrypoint for the panel container — first-boot install + boot.
#
# Post-runtime-swap layout: nginx + php-fpm decommissioned. The
# previous version of this script generated a php-fpm pool config
# (PHP_FPM_PM_MODE / PHP_FPM_MAX_CHILDREN / etc.); FrankenPHP's
# Octane wrapper handles the worker pool internally and reads its
# tunables from the OCTANE_* env namespace (see .env.example +
# docker-compose.yml). Pool generation is gone; everything else
# (composer install, key:generate, migrate, seed, asset publish,
# cache builds, initial render) is unchanged.
set -euo pipefail

cd /var/www/html

# Make sure composer can write the home dir.
export COMPOSER_HOME=/tmp/composer
mkdir -p "$COMPOSER_HOME" storage/framework/{cache,sessions,views} storage/logs bootstrap/cache

# Hand storage/ + bootstrap/cache/ to www-data. The entrypoint runs
# as root (so we can write into bind-mounted volumes whose host
# ownership we don't control). Pre-swap: PHP-FPM workers ran as
# www-data per the FPM pool config and needed write access to
# Blade-compiled views + bootstrap cache. Post-swap: FrankenPHP's
# Octane process runs as the image's default user (root in
# dunglas/frankenphp:1-alpine), but we keep the chown for
# defensive consistency — Filament's published assets and any
# operator-side `docker compose exec panel ...` commands still
# expect www-data ownership for parity with prior deployments.
chown -R www-data:www-data storage bootstrap/cache 2>/dev/null || true
chmod -R 0775 storage bootstrap/cache 2>/dev/null || true

# ct-server-core daemon's unix-socket lives under /run/cool-tunnel.
# Pre-create with mode 0770 so supervisord's daemon program can bind.
mkdir -p /run/cool-tunnel && chmod 0770 /run/cool-tunnel || true

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
# letting any hook run blanket.
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

# Seed the singleton ServerConfig row + the default cover-site
# template. Both paths are idempotent (ServerConfig::current() is
# firstOrCreate on id=1, FakeWebsite::create runs only when
# count()===0), so this is safe to run on every boot — and required
# to run BEFORE the renderer below. Without this seed pass on first
# boot, the renderer crashes with "no rows returned by a query that
# expected to return at least one row" because server_configs.id=1
# doesn't exist yet, leaving Caddyfile empty and Caddy unable to
# fetch a TLS cert. install.sh also runs db:seed (after the
# migrate-status check) but that path would fail-open if the
# renderer needs the seed before install.sh gets a chance —
# duplicating it here closes the gap. (v0.0.27 hotfix.)
php artisan db:seed --force --no-interaction || true

php artisan filament:cache-components --no-interaction || true

# Publish Filament's CSS/JS assets to public/css/filament/ + public/
# js/filament/. Filament 3 ships these inside the package; the
# panel's Blade layout references them at /css/filament/... .
# Without this step the files don't exist on first boot and the
# panel renders as a wall of unstyled HTML. `filament:assets` is
# idempotent. (v0.0.29 hotfix.)
php artisan filament:assets --no-interaction || true

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
# previously ran its own `migrate` immediately after
# `vendor/autoload.php` appeared, which raced this entrypoint's
# migrate above and crashed with "Table 'cache' already exists".
# /tmp is tmpfs in this container, so the sentinel auto-clears on
# restart and the next first-boot run waits cleanly.
mkdir -p /tmp/cool-tunnel
: >/tmp/cool-tunnel/entrypoint-complete

exec "$@"
