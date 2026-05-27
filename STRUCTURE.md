# Repository Structure

Current v0.5.2 map of the project. Use this when you need to find the
owner of a concern without walking the whole tree.

```text
cool-tunnel-server/
├── apps/
│   ├── web/                         Next.js admin frontend
│   └── api/                         Bun + Hono + Better Auth API
├── packages/
│   ├── shared/                      shared roles, schemas, API contracts
│   ├── db/                          SQLite schema, migrations, storage helpers
│   ├── security/                    redaction, auth guards, cookie helpers
│   └── config/                      environment parsing and validation
├── operator/                        Bun/TypeScript CLI behind ./ct
│   ├── src/tasks/                   install, update, doctor, backup, restore, admin
│   ├── src/util/                    compose/env/preflight helpers
│   └── tests/                       Bun unit tests
├── core/
│   └── ct-protocol/                 Rust shared wire/profile/subscription
│                                    crate; clients fetch it from the
│                                    server's published release tag
├── singbox-core/                    Bun/TypeScript sing-box manager
├── docker/
│   ├── admin-api/                   Hono API image
│   ├── admin-web/                   Next.js admin image
│   ├── caddy/                       Caddy with SNI routing
│   └── singbox/                     sing-box runtime
├── caddy/Caddyfile.tpl              public SNI splitter + admin proxy
├── manifests/                       component/version manifests
├── scripts/                         shell helpers and release plumbing
├── docs/                            operator, migration, and design docs
├── docker-compose.yml               caddy, singbox, admin-api, admin-web
├── Makefile                         local health and release gates
├── README.md                        product overview and doc map
├── GETTING_STARTED.md               shortest install walkthrough
└── STRUCTURE.md                     this file
```

## Runtime Shape

```text
browser
  |
  | https://PANEL_DOMAIN
  v
caddy
  |-- admin HTTP ------------------> admin-web (Next.js)
  |                                    |
  |                                    v
  |                                admin-api (Hono + Better Auth)
  |                                    |
  |                                    v
  |                                SQLite admin state
  |
  `-- proxy SNI ------------------> singbox

operator ./ct  --> Docker Compose, backups, migrations, render, doctor
admin-api      --> sing-box render actions through explicit boundaries
core           --> ct-protocol shared crate, published for clients
```

The main boundaries are deliberately boring:

- `apps/web` owns browser pages and talks only to `apps/api`.
- `apps/api` owns auth, sessions, authorization, admin APIs, audit, and
  SQLite-backed state through `packages/db`.
- `packages/shared`, `packages/config`, `packages/security`, and
  `packages/db` own reusable TypeScript contracts and helpers.
- `operator` owns host-level lifecycle commands exposed through `./ct`.
- `core` holds the `ct-protocol` shared Rust crate (wire/profile/
  subscription types). The server is its canonical source; clients fetch
  a matching version from the published release tag. It does not own web
  auth, browser sessions, or admin storage.
- `caddy` owns public `:80` and `:443`, ACME, query-stripping redirects,
  and SNI routing.
