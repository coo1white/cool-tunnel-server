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

# Drop in the ct-server-core binary the panel shells out to.
COPY --from=ct-core-stage /usr/local/bin/ct-server-core /usr/local/bin/ct-server-core
RUN chmod +x /usr/local/bin/ct-server-core \
    && /usr/local/bin/ct-server-core --version || true

# Lean opcache config — the panel is request/response, not a long-lived
# daemon, so we tune for fast warm-up.
COPY opcache.ini /usr/local/etc/php/conf.d/opcache.ini

# nginx fronts php-fpm; supervisord runs both inside the container so
# we present a single TCP endpoint (port 9000) to caddy.
COPY nginx.conf       /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh    /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html

EXPOSE 9000

ENTRYPOINT ["entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf", "-n"]
