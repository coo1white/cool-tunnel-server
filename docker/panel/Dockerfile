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

# redis-cli for the Cycle 2 / 2 drift-detection probe (v0.0.40). The
# probe in manifests/redis.upstream.json::verify runs
# `redis-cli ... INFO Server | grep ^redis_version:` and the matcher
# asserts the pinned `version` is contained in that line. Multi-stage
# COPY from the same redis:7-alpine image the redis service uses —
# guaranteed protocol-version compatibility with the running server,
# ~2 MiB on disk vs. ~5 MiB for `apk add redis` (which would also
# pull redis-server, useless in this container). Same idiom the file
# already uses for ct-server-core (line ~110-130 below).
COPY --from=redis:7-alpine /usr/local/bin/redis-cli /usr/local/bin/redis-cli

# Bundle the upstream naive client binary so the anti-tracking probe
# (core/ct-server-core/src/probe.rs) can speak NaiveProxy's HTTP/2-
# with-padding extension. Vanilla reqwest is dropped at sing-box's
# `naive` inbound with "missing naive padding" (R4-3 in the
# 2026-05-04 audit); the upstream client speaks the padding
# correctly. Pinned to a specific release tag + per-arch tarball
# SHA-256; bumps are explicit, version-controlled events.
#
# v0.0.17: arm64 support. Pre-fix the URL was hardcoded to
# `naiveproxy-${VERSION}-linux-x64.tar.xz`, which fails to
# download on arm64 hosts (Apple Silicon Lima, AWS Graviton,
# RPi-class Debian) — a regression of the v0.0.13 core/Dockerfile
# arm64 fix on a separate Dockerfile. BuildKit auto-populates
# TARGETARCH; we case-switch to the matching upstream asset name
# and the matching SHA-256.
ARG TARGETARCH
ARG NAIVE_VERSION=v148.0.7778.96-2
# AMD64 SHA-256 is hand-verified and pinned. Bumps are explicit,
# version-controlled events.
ARG NAIVE_SHA256_AMD64=acd2359291d4248a12e8c1ce51a685562449a9cefe24b97f75929a48e348830f
# ARM64 SHA-256: upstream klzgrad/naiveproxy does NOT publish a
# SHA256SUMS file with its releases, and v0.0.17 ships without a
# hand-pinned arm64 hash. Default empty = build proceeds but skips
# verification with a loud warning (see below). Operators on arm64
# who care about supply-chain integrity should:
#
#   1. Build the panel image once on arm64.
#   2. `docker run --rm cool-tunnel-server-panel sha256sum /usr/local/bin/naive`
#      to capture the hash they actually got.
#   3. Cross-check by computing the hash on a SECOND arm64 host
#      (a different VPS provider, a personal laptop, GitHub
#      Actions arm64 runner) — same hash on independent machines
#      means it's not a single-host MitM.
#   4. Either pass `--build-arg NAIVE_SHA256_ARM64=<hash>` on
#      every build, or update this file's default and PR it
#      upstream so the next release pins it.
#
# v0.0.18 will land a project-pinned arm64 hash once we have an
# arm64 build host wired into CI. This is an interim shape — arm64
# builds work AND the operator sees a clear "your build is less
# verified than amd64" signal, instead of either (a) silently
# downloading the wrong-arch binary like pre-v0.0.17 did, or (b)
# failing the build with no path forward.
ARG NAIVE_SHA256_ARM64=
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
