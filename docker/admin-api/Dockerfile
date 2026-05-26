# SPDX-License-Identifier: AGPL-3.0-only

ARG CT_BUN_IMAGE=oven/bun:1.3.14-alpine
ARG CT_SINGBOX_CORE_IMAGE=cool-tunnel-server-singbox-core:latest
FROM ${CT_SINGBOX_CORE_IMAGE} AS singbox-core-stage

FROM ${CT_BUN_IMAGE} AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apk add --no-cache nodejs npm \
    && npm install -g pnpm@11.1.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @cool-tunnel/api typecheck \
    && pnpm --filter @cool-tunnel/api build

FROM ${CT_BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CT_ADMIN_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api ./apps/api
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=singbox-core-stage /usr/local/bin/singbox-core /usr/local/bin/singbox-core
EXPOSE 9000
CMD ["bun", "run", "apps/api/src/server.ts"]
