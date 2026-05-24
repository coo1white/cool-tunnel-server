# SPDX-License-Identifier: AGPL-3.0-only
#
# Panel image — Bun/Hono/Better Auth admin runtime.

ARG CT_CORE_IMAGE=cool-tunnel-server-core:latest
ARG CT_SINGBOX_CORE_IMAGE=cool-tunnel-server-singbox-core:latest
ARG CT_BUN_IMAGE=oven/bun:1.3.14-alpine
ARG CT_ALPINE_REPOSITORY_BASE=

FROM ${CT_CORE_IMAGE} AS ct-core-stage
FROM ${CT_SINGBOX_CORE_IMAGE} AS singbox-core-stage

FROM ${CT_BUN_IMAGE}
ARG CT_ALPINE_REPOSITORY_BASE=
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production

RUN if [ -n "${CT_ALPINE_REPOSITORY_BASE}" ]; then \
        sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${CT_ALPINE_REPOSITORY_BASE}#g" /etc/apk/repositories; \
    fi \
    && apk add --no-cache \
        bash \
        curl \
        jq \
        mariadb-client \
        supervisor \
        tzdata \
    && rm -rf /var/cache/apk/*

COPY --from=ct-core-stage /usr/local/bin/ct-server-core /usr/local/bin/ct-server-core
COPY --from=singbox-core-stage /usr/local/bin/singbox-core /usr/local/bin/singbox-core
RUN chmod +x /usr/local/bin/ct-server-core /usr/local/bin/singbox-core \
    && /usr/local/bin/ct-server-core --version || true \
    && /usr/local/bin/singbox-core version || true

WORKDIR /opt/cool-tunnel/operator
COPY operator/package.json operator/bun.lock operator/tsconfig.json ./
COPY operator/src ./src
COPY operator/build.ts ./
RUN bun install --frozen-lockfile --production

COPY docker/panel/entrypoint.sh    /usr/local/bin/entrypoint.sh
COPY docker/panel/supervisord.conf /etc/supervisord.conf
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9000/up >/dev/null || exit 1

ENTRYPOINT ["entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf", "-n"]
