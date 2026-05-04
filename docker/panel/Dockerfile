# syntax=docker/dockerfile:1.7
#
# Panel image: PHP 8.3-fpm-alpine + Composer + Laravel 11 + Filament 3
# + the ct-server-core Rust binary (copied from the core builder
# stage). The Rust binary is the latency-sensitive engine the PHP
# services shell out to.
#
# We don't bake the application source here — the compose file bind-
# mounts ./panel into /var/www/html so edits are live in dev. The
# install.sh script runs composer install and the artisan key/migrate
# steps inside the running container on first boot.

ARG CT_CORE_IMAGE=cool-tunnel-server-core:latest
FROM ${CT_CORE_IMAGE} AS ct-core-stage

FROM php:8.3-fpm-alpine

ARG COMPOSER_VERSION=2.7.7

RUN apk add --no-cache \
        bash \
        curl \
        git \
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
        nginx \
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

# Bundle the upstream naive client binary so the anti-tracking probe
# (core/ct-server-core/src/probe.rs) can speak NaiveProxy's HTTP/2-
# with-padding extension. Vanilla reqwest is dropped at sing-box's
# `naive` inbound with "missing naive padding" (R4-3 in the
# 2026-05-04 audit); the upstream client speaks the padding
# correctly. Pinned to a specific release tag + tarball SHA-256;
# bumps are explicit, version-controlled events.
ARG NAIVE_VERSION=v148.0.7778.96-2
ARG NAIVE_SHA256=acd2359291d4248a12e8c1ce51a685562449a9cefe24b97f75929a48e348830f
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o naiveproxy.tar.xz \
        "https://github.com/klzgrad/naiveproxy/releases/download/${NAIVE_VERSION}/naiveproxy-${NAIVE_VERSION}-linux-x64.tar.xz"; \
    echo "${NAIVE_SHA256}  naiveproxy.tar.xz" | sha256sum -c -; \
    tar -xJf naiveproxy.tar.xz; \
    install -m 0755 "naiveproxy-${NAIVE_VERSION}-linux-x64/naive" /usr/local/bin/naive; \
    rm -rf naiveproxy.tar.xz "naiveproxy-${NAIVE_VERSION}-linux-x64"

# Drop in the ct-server-core binary the panel shells out to.
COPY --from=ct-core-stage /usr/local/bin/ct-server-core /usr/local/bin/ct-server-core
RUN chmod +x /usr/local/bin/ct-server-core \
    && /usr/local/bin/ct-server-core --version || true

# Lean opcache config — the panel is request/response, not a long-lived
# daemon, so we tune for fast warm-up.
COPY opcache.ini /usr/local/etc/php/conf.d/opcache.ini

# Anti-fingerprint hardening: turn off the `X-Powered-By: PHP/8.3.x`
# response header that the upstream php:8.3-fpm-alpine image ships
# with by default. Loaded as a separate conf.d drop-in for clarity.
COPY php-hardening.ini /usr/local/etc/php/conf.d/php-hardening.ini

# nginx fronts php-fpm; supervisord runs both inside the container so
# we present a single TCP endpoint (port 9000) to sing-box.
COPY nginx.conf       /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh    /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html

EXPOSE 9000

# Periodic liveness probe: hit Laravel's /up health endpoint via
# nginx on the local port. If Laravel boots and routes /up the
# container is healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9000/up >/dev/null \
        || exit 1

ENTRYPOINT ["entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf", "-n"]
