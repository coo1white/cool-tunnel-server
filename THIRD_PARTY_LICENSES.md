# Third-Party Licences

This file lists the third-party components the v0.5.2
cool-tunnel-server stack builds, runs, or links against. Original code
in this repository is AGPL-3.0-only, Copyright (C) 2026 coolwhite LLC;
see [LICENSE](./LICENSE). Upstream components keep their own licences,
and those notices must be preserved in redistribution.

## Current Runtime Components

| Component | Upstream | Licence |
| --- | --- | --- |
| Caddy with caddy-l4 | https://github.com/caddyserver/caddy | Apache-2.0 |
| sing-box | https://github.com/SagerNet/sing-box | GPL-3.0 |
| Bun | https://github.com/oven-sh/bun | MIT |
| Next.js | https://github.com/vercel/next.js | MIT |
| React | https://github.com/facebook/react | MIT |
| Hono | https://github.com/honojs/hono | MIT |
| Better Auth | https://github.com/better-auth/better-auth | MIT |
| TypeScript | https://github.com/microsoft/TypeScript | Apache-2.0 |
| SQLite | https://sqlite.org | Public domain |

The active v0.5.2 runtime has no PHP, Laravel, Filament, MariaDB,
Redis, Composer, or public signup service. Those components existed in
v0.5.1 and earlier and are retained only in documentation for upgrade
and migration context.

## Rust Crates

Full transitive graph: [core/Cargo.lock](./core/Cargo.lock). Direct
runtime dependencies include tokio, serde, serde_json, sqlx, hyper,
hyper-util, http-body-util, bytes, hyperlocal, reqwest, redis, aes-gcm,
base64, chrono, tracing, tracing-subscriber, sha2, hex, hmac, clap, and
futures-core. These are predominantly MIT, Apache-2.0, or dual
MIT/Apache-2.0; consult crates.io and the lockfile for the complete
component graph.

## TypeScript Packages

The canonical package graph is [pnpm-lock.yaml](./pnpm-lock.yaml). The
active workspaces are:

- [apps/web](./apps/web): Next.js, React, lucide-react.
- [apps/api](./apps/api): Hono, Better Auth, Bun runtime APIs.
- [packages/shared](./packages/shared), [packages/db](./packages/db),
  [packages/security](./packages/security), and
  [packages/config](./packages/config): shared types, validation,
  SQLite helpers, redaction, and config parsing.
- [operator](./operator) and [singbox-core](./singbox-core): Bun-built
  command-line/runtime tools.

## Docker Base Images

| Image | Component | Licence Notes |
| --- | --- | --- |
| `caddy:2.11.3-builder` / `caddy:2.11.3-alpine` | Caddy build/runtime | Apache-2.0 plus Alpine packages |
| `oven/bun:1.3.14-alpine` | admin API/web build/runtime | MIT plus Alpine packages |
| `rust:1.88.0-alpine` | Rust core build env | MIT/Apache-2.0 plus Alpine packages |
| `alpine:3.20` / `alpine:3.21` | carrier/runtime stages | Alpine licence collection |

The Alpine licence collection is the packaged set of notices preserved
inside the image under the distro documentation paths.

## GPL/AGPL Boundary

sing-box is GPL-3.0 and is bundled as a separate process/image. The
project's own code is AGPL-3.0-only. If you modify sing-box, distribute
your modified sing-box source under GPL-3.0. If you operate a modified
cool-tunnel-server as a network service, AGPL section 13 requires you
to make the modified source code available to those users.

## Verifying Compliance

Before redistributing release images, run the release SBOM flow and
inspect the image licence directories:

```sh
make sbom
docker exec ct-caddy ls -la /usr/share/doc/ 2>/dev/null || true
docker exec ct-admin-api find / -iname 'LICENSE*' -o -iname 'COPYRIGHT*' 2>/dev/null | head -20
docker exec ct-admin-web find / -iname 'LICENSE*' -o -iname 'COPYRIGHT*' 2>/dev/null | head -20
docker exec ct-singbox sing-box version
```

If a redistributed component is missing from this list, open a private
issue so the notice can be corrected before the next release.
