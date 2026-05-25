# Glossary

Core terms used in the current Cool Tunnel Server stack.

## ACME

The certificate automation protocol used by Let's Encrypt. Caddy uses ACME to issue the panel certificate.

## Better Auth

The Bun/TypeScript auth library used by the admin panel for accounts, password hashing, sessions, and login rate limiting.

## Caddy

The public front door. The built image includes `mholt/caddy-l4`, so Caddy listens on `:443`, routes panel SNI to the panel HTTPS handler, and forwards non-panel SNI traffic to sing-box. It also handles ACME for the panel domain.

## ct-server-core

The Rust control-plane binary bundled in the panel image. It owns core rendering, runtime checks, daemon logic, and internal operations.

## .env

The deployment config and secret file at the repo root. It contains domains, database credentials where retained, Redis credentials where retained, `BETTER_AUTH_SECRET`, and related operator settings.

## First Owner Bootstrap

The first owner setup flow. Run `ct admin bootstrap`, read the setup page and one-time token from the root-only setup file over SSH, and choose the owner password in the browser. Tokens expire and are disabled after an owner exists.

## PASS / WARN / FAIL

The status labels used by `ct doctor`. PASS is healthy, WARN needs attention soon, and FAIL should be fixed before trusting the release.

## panel

The Bun/Hono/Better Auth admin container. Operators run admin commands through `ct admin ...` or `docker compose exec -T panel bun run /opt/cool-tunnel/operator/src/index.ts ...`.

## PANEL_DOMAIN

The hostname for the admin UI, usually `panel.<DOMAIN>`.

## Reality

The sing-box TLS camouflage mode used by the VLESS proxy path.

## SQLite Admin DB

The default admin/account database. The default path is `/data/admin/admin.sqlite`, controlled by `CT_ADMIN_DB_PATH`.

## sing-box

The proxy engine. It runs in the `singbox` container under `singbox-core supervise`, reads `/data/config/singbox.json`, and is restarted when the rendered config changes.

## SNI

Server Name Indication, the hostname inside the TLS ClientHello. Caddy uses SNI to route panel traffic separately from proxy traffic.

## supervisord

The process supervisor inside the panel container. It keeps the Bun admin server and Rust core daemon running.

## VLESS

The sing-box protocol used for end-user proxy accounts.
