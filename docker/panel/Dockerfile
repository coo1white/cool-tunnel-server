# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# Panel image — FrankenPHP runtime swap (post-v0.0.57).
#
# Pre-swap: PHP 8.3-FPM + nginx + supervisord (5 programs). Each
# request booted Laravel from cold disk + opcache; classic FastCGI
# round-trip; no HTTP/2 or 3 native; nginx + FPM logged to disjoint
# files via FastCGI handoff.
#
# Post-swap: dunglas/frankenphp (Caddy + PHP in one process) +
# Laravel Octane in worker mode. Boot is paid ONCE per worker, not
# once per request — measured ~3-5x latency improvement on the
# Filament admin "Save → reload" path that was the original
# motivator. HTTP/2 + HTTP/3 are zero-config (HTTP/3 reach through
# the SSH-tunnel admin path is cosmetic — the panel is loopback-
# bound; UDP/QUIC doesn't tunnel through SSH's TCP forwarder. Real-
# world HTTP/3 benefit lands when the panel is fronted by a public
# TLS terminator, which is a v0.1 architectural item).
#
# Single-container goal: Caddy and PHP run in one process. nginx +
# php-fpm + their inter-process FastCGI socket are decommissioned.
# supervisord still manages the OTHER long-lived processes (octane,
# queue worker, scheduler, ct-server-core daemon) — FrankenPHP
# replaces only the web-tier, not the process supervisor.
#
# Filament UI code (panel/app/Filament/**) is UNTOUCHED by this
# swap. Filament 3 + Livewire 3 are Octane-compatible since
# Filament v3.0; Octane handles the per-request container reset
# that prevents inter-request state leakage.

ARG CT_CORE_IMAGE=cool-tunnel-server-core:latest
FROM ${CT_CORE_IMAGE} AS ct-core-stage

# dunglas/frankenphp ships PHP + Caddy + Composer in a single Alpine
# image. PHP 8.4 over the prior 8.3-fpm-alpine: laravel/octane v2.17
# (the version this swap pins) transitively depends on
# symfony/psr-http-message-bridge v8.0.8 which requires PHP ≥ 8.4.
# panel/composer.json's "php": "^8.2" constraint allows 8.4; bumping
# the runtime is the cleanest path versus version-pinning the
# transitive dep down.
FROM dunglas/frankenphp:1-php8.4-alpine

# Strip the FrankenPHP binary's file capabilities. The dunglas
# image ships the binary with `cap_net_bind_service+ep` so it
# can bind privileged ports (80/443) as a non-root user. Our
# panel container is constrained by `security_opt:
# no-new-privileges:true` (set globally via x-svc-hardening in
# docker-compose.yml), and the kernel REFUSES to exec any
# binary with file capabilities under that flag — supervisord
# fails with `couldn't exec /usr/local/bin/frankenphp: EPERM`.
# This container listens on :9000 (non-privileged) so the cap
# is unused; stripping it restores exec while preserving the
# hardening posture.
#
# Post-strip assert: if a future base-image bump moves the
# binary or changes its caps, `setcap -r` silently no-ops on a
# missing path, the EPERM resurfaces, and the operator sees
# the v0.0.58-class FATAL crash again. The `getcap` check
# below fails the build LOUDLY when caps remain, surfacing
# the regression at build time instead of at deploy time.
# (Round-6 ops audit follow-up.)
RUN setcap -r /usr/local/bin/frankenphp \
    && remaining=$(getcap /usr/local/bin/frankenphp || true) \
    && if [ -n "$remaining" ]; then \
           echo "::error:: setcap -r failed: caps remain: $remaining" >&2; \
           exit 1; \
       fi \
    && /usr/local/bin/frankenphp version

ARG COMPOSER_VERSION=2.7.7

# Composer is bundled in dunglas/frankenphp (under /usr/bin/composer
# in recent tags) but we install our pinned version explicitly to
# match the prior pin and avoid silent upgrades on base-image bumps.
RUN apk add --no-cache \
        bash \
        curl \
        git \
        gcompat \
        jq \
        libgcc \
        socat \
        unzip \
        xz \
        icu-dev \
        oniguruma-dev \
        libzip-dev \
        libpng-dev \
        libjpeg-turbo-dev \
        libwebp-dev \
        freetype-dev \
        mariadb-client \
        supervisor \
        tzdata \
    && docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp \
    && docker-php-ext-install -j"$(nproc)" \
        bcmath \
        gd \
        intl \
        mbstring \
        opcache \
        pcntl \
        pdo_mysql \
        zip \
    && curl -fsSL "https://github.com/composer/composer/releases/download/${COMPOSER_VERSION}/composer.phar" \
        -o /usr/local/bin/composer \
    && chmod +x /usr/local/bin/composer \
    && rm -rf /var/cache/apk/*

# v0.0.93 — install ext-redis (phpredis) via PECL so Symfony
# Messenger's Redis transport can consume the cool_tunnel:messenger
# stream. Laravel itself continues to use the pure-PHP Predis
# client (panel/config/database.php:'client'=>'predis') — the
# two clients share the same Redis instance but use independent
# connection pools and don't interfere.
#
# `$PHPIZE_DEPS` is the docker-php meta-package providing the
# headers and toolchain needed to compile PECL extensions; it's
# scoped to a `--virtual` group and deleted at the end of the
# step so it doesn't bloat the final image.
#
# v0.0.95 — PIN the phpredis version explicitly. The original
# v0.0.93 line was `pecl install --force redis` (no pin), which on
# the dunglas/frankenphp:1-php8.4-alpine image resolved to
# phpredis 5.3.0 — well below the >= 6.1 minimum required by
# symfony/redis-messenger v7.4.8 (which declares
# `conflict: ext-redis <6.1`). Result: the entrypoint's
# `composer install` saw the runtime ext-redis at 5.3.0, detected
# the conflict, exited non-zero, and `set -e` killed the
# entrypoint — supervisord never started, panel container went
# into a restart loop. CI didn't catch the regression because all
# four CI composer invocations carry `--ignore-platform-req=ext-redis`
# (the runners themselves have no ext-redis to detect against).
#
# Pin 6.3.0 (the latest stable as of 2025-11-06). Future bumps
# are explicit, version-controlled events — same posture as the
# composer / naiveproxy / redis-cli pins above. The matching
# platform override in `panel/composer.json` is bumped to
# `6.3.0` in lockstep so composer's solver agrees with the
# runtime, and the entrypoint now carries
# `--ignore-platform-req=ext-redis` as belt-and-braces.
RUN apk add --no-cache --virtual .ext-redis-build-deps $PHPIZE_DEPS \
    && pecl channel-update pecl.php.net \
    && pecl install --force redis-6.3.0 \
    && docker-php-ext-enable redis \
    && apk del .ext-redis-build-deps \
    && rm -rf /tmp/pear ~/.pearrc /var/cache/apk/*

# redis-cli for the Cycle 2 / 2 drift-detection probe (v0.0.40). The
# probe in manifests/redis.upstream.json::verify runs
# `redis-cli ... INFO Server | grep ^redis_version:` and the matcher
# asserts the pinned `version` is contained in that line. Multi-stage
# COPY from the same redis:7-alpine image the redis service uses —
# guaranteed protocol-version compatibility with the running server,
# ~2 MiB on disk vs. ~5 MiB for `apk add redis` (which would also
# pull redis-server, useless in this container).
COPY --from=redis:7.4.8-alpine /usr/local/bin/redis-cli /usr/local/bin/redis-cli

# Bundle the upstream naive client binary so the anti-tracking probe
# (core/ct-server-core/src/probe.rs) can speak NaiveProxy's HTTP/2-
# with-padding extension. Vanilla reqwest is dropped at sing-box's
# `naive` inbound with "missing naive padding" (R4-3 in the
# 2026-05-04 audit); the upstream client speaks the padding
# correctly. Pinned to a specific release tag + per-arch tarball
# SHA-256; bumps are explicit, version-controlled events.
ARG TARGETARCH
# v0.0.89: bumped from v148.0.7778.96-2 → -5. Upstream maintainer
# deleted the release assets for -2 after publication; production
# `make update` runs hit `curl: (22) error 404` until this bump.
# Same upstream binary (`naive --version` still prints
# `naive 148.0.7778.96`), only the rebuild suffix changed, so the
# manifest pin in manifests/naiveproxy-client.upstream.json stays
# `148.0.7778.96`. The `make manifest-lockstep` rule from v0.0.74
# already accepts the asset tag as `version` OR `version + suffix`,
# so no change there either.
ARG NAIVE_VERSION=v148.0.7778.96-5
ARG NAIVE_SHA256_AMD64=ca6958dcbbfb7b1b38c55a213dab6927ce3c1417d969b815657513b81fc7352d
# Round-18 supply-chain pin: arm64 hash for the same release tag
# as AMD64. Computed against the GitHub-hosted tarball; bytes-in →
# bytes-out, so the value is host-architecture-independent — the
# pin protects against the upstream CDN serving different bits at
# build time, which is the same threat model the AMD64 pin closes.
# Bumps must update both arches together (or only the one being
# bumped if upstream ever ships per-arch independently).
ARG NAIVE_SHA256_ARM64=88fb88340d70b763cdf66586e056d78cb0877b62899f3194abc30d41e5d18763
RUN set -eux; \
    cd /tmp; \
    case "${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}" in \
        amd64) NAIVE_ASSET_ARCH=linux-x64;   NAIVE_SHA256=${NAIVE_SHA256_AMD64} ;; \
        arm64) NAIVE_ASSET_ARCH=linux-arm64; NAIVE_SHA256=${NAIVE_SHA256_ARM64} ;; \
        *)     echo "unsupported TARGETARCH: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o naiveproxy.tar.xz \
        "https://github.com/klzgrad/naiveproxy/releases/download/${NAIVE_VERSION}/naiveproxy-${NAIVE_VERSION}-${NAIVE_ASSET_ARCH}.tar.xz"; \
    if [ -n "${NAIVE_SHA256}" ]; then \
        echo "${NAIVE_SHA256}  naiveproxy.tar.xz" | sha256sum -c -; \
    else \
        echo "" >&2; \
        echo "  ⚠️  WARN: NAIVE_SHA256 unset for ${NAIVE_ASSET_ARCH}." >&2; \
        echo "      Build proceeds without supply-chain verification of the" >&2; \
        echo "      naiveproxy-client tarball. Pin via --build-arg" >&2; \
        echo "      NAIVE_SHA256_$(echo ${TARGETARCH} | tr a-z A-Z)=<sha>" >&2; \
        echo "      after computing the hash on a trusted arm64 host." >&2; \
        echo "      See the head comment in docker/panel/Dockerfile." >&2; \
        echo "" >&2; \
    fi; \
    tar -xJf naiveproxy.tar.xz; \
    install -m 0755 "naiveproxy-${NAIVE_VERSION}-${NAIVE_ASSET_ARCH}/naive" /usr/local/bin/naive; \
    rm -rf naiveproxy.tar.xz "naiveproxy-${NAIVE_VERSION}-${NAIVE_ASSET_ARCH}"

# Drop in the ct-server-core binary the panel shells out to.
COPY --from=ct-core-stage /usr/local/bin/ct-server-core /usr/local/bin/ct-server-core
RUN chmod +x /usr/local/bin/ct-server-core \
    && /usr/local/bin/ct-server-core --version || true

# Lean opcache config — under FrankenPHP worker mode the OPcache
# warm window is amortised across the whole worker lifetime, not
# the request. Keeping the same tuning as pre-swap; future tuning
# is operator follow-up.
COPY opcache.ini /usr/local/etc/php/conf.d/opcache.ini

# Anti-fingerprint hardening: turn off `X-Powered-By: PHP/8.3.x`.
# FrankenPHP's response pipeline forwards PHP-emitted headers
# verbatim — same suppression discipline as the FPM era. The
# server-tier `Server: Caddy` header is suppressed in the
# Caddyfile (no equivalent at the PHP level).
COPY php-hardening.ini /usr/local/etc/php/conf.d/php-hardening.ini

# FrankenPHP serves Caddy + PHP in one process. The Caddyfile
# defines the listening port, document root, worker-mode binding,
# anti-fingerprint header suppression, and access-log behaviour
# (subscription token masking).
# Hotfix: bake the panel-internal Caddyfile at a NON-volume-mounted
# path. docker-compose.yml mounts `caddy_etc:/etc/caddy` into this
# container so `ct-server-core caddyfile render` (run by the panel)
# can write the rendered ACME Caddyfile that the dedicated `ct-caddy`
# container reads. That mount SHADOWS any file the Dockerfile bakes
# at /etc/caddy/, so the panel-internal FrankenPHP would load the
# ACME Caddyfile instead of its own — that file binds :80 and tries
# to ACME the operator's external domains; it does NOT listen on
# :9000 or hand requests to FrankenPHP's worker. Result: panel
# returns 502 from caddy:8444 → panel:9000.
#
# Fix: bake to /etc/caddy-panel/ (NOT volume-mounted), and point
# supervisord's frankenphp --config at the new path. The
# /etc/caddy/Caddyfile written by the panel's CaddyfileGenerator
# stays in place for the dedicated ct-caddy container; the panel's
# own Caddy reads its own file. Two configs, two paths, no
# overlap. (post-v0.0.58 hotfix.)
COPY Caddyfile        /etc/caddy-panel/Caddyfile
COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh    /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html

EXPOSE 9000

# Periodic liveness probe: hit Laravel's /up health endpoint via
# FrankenPHP on the local port. Same probe as the FPM era; only
# the server tier behind the URL changed.
#
# `start-period=120s` (was 30s pre-round-7-audit). The first-boot
# entrypoint runs `composer install --no-dev --optimize-autoloader`
# which takes 30-90s on a 1-vCPU box; before the install completes
# supervisord's frankenphp program isn't started, so the
# healthcheck flaps "unhealthy" for that whole window. 120s
# absorbs the slowest realistic first-boot path (full install
# from cold cache + the entrypoint's other artisan commands)
# while still surfacing actual brokenness within ~5 min on a
# steady-state restart. `restart: unless-stopped` doesn't
# restart on UNHEALTHY anyway — this is purely operator-facing
# (`docker compose ps panel` showing "unhealthy" mid-deploy
# panics no one).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9000/up >/dev/null \
        || exit 1

ENTRYPOINT ["entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf", "-n"]
