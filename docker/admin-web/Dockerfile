# SPDX-License-Identifier: AGPL-3.0-only

ARG CT_BUN_IMAGE=oven/bun:1.3.14-alpine
FROM ${CT_BUN_IMAGE} AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apk add --no-cache nodejs npm \
    && npm install -g pnpm@11.1.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared
# Next.js bakes rewrites() destinations into routes-manifest.json at
# BUILD time, so CT_API_INTERNAL_ORIGIN must be present here, not only
# at runtime. Without it the /up and /api/* proxies freeze to the dev
# fallback (http://127.0.0.1:9000) and fail with ECONNREFUSED inside the
# container, even though compose sets the var at runtime. The value is
# the compose service address; override via build-arg for other topos.
ARG CT_API_INTERNAL_ORIGIN=http://admin-api:9000
ENV CT_API_INTERNAL_ORIGIN=${CT_API_INTERNAL_ORIGIN}
RUN pnpm --filter @cool-tunnel/web typecheck \
    && pnpm --filter @cool-tunnel/web build

FROM ${CT_BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web ./apps/web
COPY --from=deps /app/packages/shared ./packages/shared
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/web", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
