# Cool Tunnel Server Architecture

Cool Tunnel Server is a self-hosted proxy server built as a Docker Compose stack. Caddy handles ACME and SNI routing, sing-box runs the VLESS + Reality proxy path, Bun/Hono serves the admin panel, Better Auth owns accounts and sessions, SQLite stores admin/account state by default, and Rust remains the trusted internal core engine.

| Service | Role |
| --- | --- |
| `caddy` | Public `:80`/`:443` front door. Handles ACME for `PANEL_DOMAIN` and uses `mholt/caddy-l4` to split TLS by SNI. |
| `singbox` | VLESS + Reality proxy engine. Reads `/data/config/singbox.json` and is supervised by `singbox-core`. |
| `panel` | Bun/Hono/Better Auth admin UI, SQLite auth/admin DB, operator actions, and the Rust core daemon. |
| `db` | MariaDB only for retained core runtime data that still requires it. |
| `redis` | Runtime cache/compatibility service where retained functionality still needs it. |

## Front Door

```text
:80
  caddy
    ACME HTTP-01 for PANEL_DOMAIN
    HTTP -> HTTPS redirects

:443
  caddy layer4 SNI splitter
    SNI == PANEL_DOMAIN -> 127.0.0.1:8443 -> panel:9000
    any other SNI       -> ct-singbox:443 -> VLESS + Reality
```

Caddy does not decrypt proxy traffic. Reality TLS terminates inside sing-box on the proxy path. The panel path terminates in Caddy's inner HTTPS listener and reverse-proxies to the Bun admin server on `panel:9000`.

## Admin/Auth

- Better Auth provides email/password auth, password hashing, sessions, and rate limiting.
- Login rate limiting keys on `X-Forwarded-For` set by the Caddy panel proxy. Do not publish the panel container port directly.
- Sessions use httpOnly cookies with SameSite=Lax and Secure cookies in production.
- Public signup is disabled unless config explicitly enables it.
- First owner creation uses `ct admin bootstrap`, an expiring one-time token, and no default password.
- Roles are intentionally simple: owner, admin, operator, viewer. Owners have full access; admins manage operator/viewer accounts and operational workflows; operators run safe operational actions; viewers are read-only.
- The account panel supports user list/detail/create/edit, role changes, disable/enable, protected deletes, password reset to a temporary password, and audit for important admin actions.
- Disabled accounts cannot sign in, and disabling or resetting a password revokes active sessions.
- Admin/account data lives in `/data/admin/admin.sqlite` by default, is migrated idempotently, and is included in `ct backup` as the `admin_data` volume snapshot. User rows carry role, status, and disabled timestamp metadata alongside Better Auth credential/session tables.

## Rust Boundary

Bun/TypeScript validates inputs, owns web/admin/operator workflows, and calls Rust through internal commands or local-only runtime interfaces. Rust owns protocol/config rendering, daemon/runtime logic, and internal operations. Rust internals are not exposed directly to the public internet.

## Render And Reload

- `ct admin migrate` migrates admin/auth SQLite tables.
- `ct render caddyfile` renders `/etc/caddy/Caddyfile` through the Rust boundary.
- `ct render singbox` renders `/data/config/singbox.json` through the Rust boundary.
- `ct update` reloads affected services after health gates pass.

## Component Manifests

Every replaceable runtime part is pinned under `manifests/*.upstream.json` or the matching deployment source. Use `ct doctor` as the broad PASS/WARN/FAIL health gate.
