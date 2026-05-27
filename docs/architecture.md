# Cool Tunnel Server Architecture

Cool Tunnel Server is an open-source self-hosted proxy server built as a
four-service Docker Compose stack. Caddy handles ACME and SNI routing,
sing-box runs the VLESS + Reality proxy path, `admin-web` serves the
Next.js dashboard, and `admin-api` runs the Bun/Hono API with Better
Auth, RBAC, SQLite storage, subscription output, and render action
boundaries.

The live deployment has these services:

| Service | Role |
| --- | --- |
| `caddy` | Public `:80`/`:443` front door. Handles ACME for `PANEL_DOMAIN` and uses `mholt/caddy-l4` to split TLS by SNI. |
| `singbox` | VLESS + Reality proxy engine. Reads `/data/config/singbox.json` and is supervised by `singbox-core`. |
| `admin-api` | Hono/Bun API, Better Auth, SQLite store, subscription endpoint, audit log, and render/doctor action boundary. |
| `admin-web` | Next.js admin dashboard. Talks to `admin-api` over the internal Compose network. |

## Front Door

```text
:80
  caddy
    ACME HTTP-01 for PANEL_DOMAIN
    HTTP -> HTTPS redirects

:443
  caddy layer4 SNI splitter
    SNI == PANEL_DOMAIN -> 127.0.0.1:8443 -> admin-web:3000
    any other SNI       -> ct-singbox:443 -> VLESS + Reality
```

Caddy does not decrypt proxy traffic. Reality TLS terminates inside
sing-box on the proxy path. The admin path terminates in Caddy's inner
HTTPS listener and reverse-proxies to `admin-web:3000`.

## Monorepo Shape

| Path | Role |
| --- | --- |
| `apps/web` | Next.js admin dashboard and server actions. |
| `apps/api` | Hono API, Better Auth integration, subscription route, and render action boundary. |
| `packages/shared` | Shared TypeScript types, roles, permissions, release constants, and defaults. |
| `packages/db` | SQLite schema, migrations, repositories, and optional `legacy_*` staging-table import for v0.5.1 data. |
| `packages/security` | Password hashing, token hashing, validation, and redaction helpers. |
| `packages/config` | Runtime env parsing and admin API config. |
| `operator` | TypeScript `ct` CLI for install, update, doctor, backup, restore, render, and admin recovery. |
| `singbox-core` | TypeScript sing-box renderer, installer, and supervisor. |
| `core` | Rust `ct-protocol`, the shared wire/profile/subscription crate clients fetch from the server's published release tag. |

## Render And Reload

- `admin-api` writes sing-box input from SQLite state.
- `singbox-core render-server` renders `/data/config/singbox.json`.
- `ct-singbox` watches that file and respawns sing-box when it changes.
- `admin-api` renders `/etc/caddy/Caddyfile` from SQLite state through the core boundary.
- `ct update` reloads Caddy from the host-side operator.

There is no clash API or HAProxy reload path in the current runtime.

## Component Manifests

Every replaceable runtime part is pinned under
`manifests/*.upstream.json` or the matching deployment source
(`docker-compose.yml`, Dockerfiles, package manifests, Cargo, or
`singbox-core/singbox.upstream.json`). `ct doctor` and the admin API
status summary are the supported operator health gates.

## Client Contract

Clients consume the subscription manifest from:

```text
https://<PANEL_DOMAIN>/api/v1/subscription/<token>
```

The manifest carries the server host, port, VLESS UUID, Reality public
key, short IDs, and the sing-box version pin. The shared Rust protocol
crate defines the manifest schema so server and clients agree on the
wire format.

## v0.5.1 To v0.5.2 Migration

v0.5.2 replaces the PHP/Laravel control plane with the Better-T-Stack
monorepo. The active runtime has no MariaDB, Redis, Composer, or PHP
worker process. The new control-plane database is SQLite at
`./data/admin/admin.sqlite` on the host, bind-mounted into admin-api as
`/data/admin/admin.sqlite`.

Automatic migration covers the new SQLite schema and any explicit
`legacy_users`, `legacy_proxy_accounts`, and `legacy_server_configs`
staging tables that a maintainer has already placed in the SQLite DB
before `ct admin migrate` runs.

The staging import preserves:

- admin users, emails, usernames, roles, status, password hashes, and
  password-change flags when present;
- proxy account usernames, UUIDs, previous UUID grace, subscription
  secrets, labels, enabled state, local-port defaults, enabled
  protocols, expiry, and timestamps;
- server settings such as domain, panel domain, ACME email/directory,
  anti-tracking flags, DoH resolver, Reality keypair, Reality
  destination, short IDs, and last render metadata.

Maintainer action is still required for live v0.5.1 deployments:
export the old database into the documented `legacy_*` staging tables,
preserve `.env`, `caddy_data`, backups, and Reality secrets, run
`ct admin migrate`, then run `ct update` and `ct doctor`. The migration
does not automatically connect to or dump the retired MariaDB service,
does not carry Redis queue/cache/session state, and does not preserve
old framework internals that no longer exist in the v0.5.2 runtime.
