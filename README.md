# Cool Tunnel Server

Server-side stack for the [Cool Tunnel][client] family of NaiveProxy
clients (macOS today; iOS / Android / Windows / Linux desktop on the
roadmap). Three layers, mirroring the client:

|  | UI | Glue (cross-platform Rust) | Anti-tracking engine |
| --- | --- | --- | --- |
| **Server** (this repo) | Filament 3 (PHP / Laravel) | `ct-server-core` (Rust) + shared `ct-protocol` crate | `forwardproxy@naive` plugin baked into Caddy |
| **macOS client** ([cool-tunnel][client]) | SwiftUI + AppKit | `cool-tunnel-core` (Rust) | Bundled `naive` Mach-O |
| **Future iOS / Android / Win / Linux** | Per-platform native | Same `ct-protocol` + per-platform core | Per-platform `naive` |

The two horizontal lines that bind every row together are the Rust
crate (`ct-protocol`) and the NaiveProxy wire format. New platforms
plug into both without re-implementing.

Runs **Caddy + `forward_proxy` (NaiveProxy fork)** as the actual proxy,
with a **Filament + Laravel** admin panel that manages proxy accounts,
generates the `Caddyfile`, hot-reloads Caddy via its admin API (via
the Rust core), and serves a fake camouflage site on the apex domain
so unauthenticated probes can't fingerprint the box as a proxy.

[client]: https://github.com/coo1white/cool-tunnel

> **Heads-up.** This is a tool for circumventing online censorship.
> Read the [Disclaimer](./Disclaimer.md) before deploying — it covers
> intended use, operator responsibility, and what the bundled
> components are.

---

## What's in the box

| Layer | What it is |
| --- | --- |
| **`caddy`** | Caddy compiled with [`klzgrad/forwardproxy@naive`](https://github.com/klzgrad/forwardproxy/tree/naive). Terminates TLS on `:443`, speaks HTTP/2 + HTTP/3, runs `forward_proxy` with `hide_ip`, `hide_via`, and `probe_resistance` switched on. Falls through to a Laravel-rendered fake site for any request that isn't an authenticated CONNECT. |
| **`ct-server-core`** | Rust binary baked into the panel image. Owns the latency-sensitive paths: Caddyfile rendering, admin-API hot-reload over the unix socket, `/metrics` scraping, quota enforcement, anti-tracking probe, component OK/NG check. Uses the `ct-protocol` crate that future cross-platform clients will share. |
| **`panel`** | Laravel 11 + Filament 3 admin app. PHP services are thin shell-outs to `ct-server-core`. Manages proxy accounts, fake-site templates, server config, traffic logs, and the **Components** OK/NG page. |
| **`db`** | MariaDB 11 — proxy accounts, traffic counters, fake-site template data, panel users. |
| **`redis`** | Cache + queue backend for the panel. |

Each piece is described by an `*.upstream.json` in [`manifests/`](./manifests/) — the **component-as-machine-part** model. Update one component, run `ct-server-core component check`, get an OK/NG verdict before swap. Same schema is used by every Rust-cored client. See [`docs/components.md`](./docs/components.md).

```
                    ┌─────────────────────────────────────┐
                    │  Cool Tunnel client (macOS / iOS)   │
                    │  — naive: HTTP/2 CONNECT over TLS   │
                    └────────────────┬────────────────────┘
                                     │ TLS:443
                                     ▼
   ┌────────────────────────────────────────────────────────────┐
   │                       caddy container                       │
   │                                                             │
   │  TLS (ACME Let's Encrypt, auto-renew)                      │
   │   │                                                         │
   │   ├──▶ forward_proxy (basic_auth from sites-enabled/*.caddy)│
   │   │      hide_ip, hide_via, probe_resistance                │
   │   │      → upstream internet                                │
   │   │                                                         │
   │   └──▶ unauthed traffic → fake site                          │
   │           ├─ /  → reverse_proxy panel:9000 (PHP-FPM)        │
   │           └─ /static/*, /favicon.ico → file_server          │
   └─────────────┬──────────────────────────────┬───────────────┘
                 │                               │
                 │ unix socket /run/caddy/admin │ generated Caddyfile
                 ▼                               │
   ┌────────────────────────────────────────────┴───────────────┐
   │                      panel container                        │
   │                                                             │
   │  Laravel 11 + Filament 3 admin (port 8443 over reverse-     │
   │  proxy with admin-only basic_auth at the Caddy edge)        │
   │                                                             │
   │  Models:  ProxyAccount, FakeWebsite, ServerConfig,          │
   │           TrafficLog                                        │
   │  Services: CaddyfileGenerator, CaddyReloader,               │
   │            FakeSiteRenderer, AntiTrackingFilter,            │
   │            TrafficCollector                                 │
   │  Workers: queue worker (regenerate-on-save),                │
   │           scheduled traffic-rollup, scheduled quota check   │
   └─────────────────────────────────────────────────────────────┘
```

---

## Anti-tracking defaults

Out of the box, the generated `Caddyfile` enables every network-tracking
mitigation `forward_proxy` exposes, plus a few panel-level defaults:

- **`hide_ip`** — strip `X-Forwarded-For`, `Forwarded`, and `X-Real-IP`
  from outbound requests.
- **`hide_via`** — strip `Via` (which would otherwise reveal that the
  request transited a proxy at all).
- **`probe_resistance`** — unauthenticated `CONNECT` is indistinguishable
  from a wrong-password attempt; the response shape matches the static
  site, so active probing tools (e.g. GFW-style probers) can't
  fingerprint the proxy.
- **HTTP/3 (QUIC) on `:443/udp`** — harder to selectively throttle than
  TCP/443.
- **Disabled access logs by default** — only the panel records
  per-account aggregate byte counters, never URLs or remote hosts.
- **DNS over HTTPS upstream resolver** (Cloudflare `1.1.1.1` by default)
  — Caddy resolves CONNECT targets without leaking to the host's
  recursive resolver. Configurable to any DoH endpoint.
- **Random fake-site rotation** — a dataset of cover-site templates
  (blog, portfolio, corp landing) the operator can swap between to
  reduce fingerprintability across hosts.

The full list and per-account toggles live in *Settings → Anti-Tracking*
in the panel.

---

## Quickstart (Docker)

Prerequisites:

- Linux host with Docker + Compose v2
- A domain pointing at the host's public IP (`A` and `AAAA`)
- Ports 80, 443/tcp, 443/udp open inbound

> **Bare-metal / fresh VPS?** Read
> [`docs/installation-debian.md`](./docs/installation-debian.md)
> first — it's a one-by-one Debian 10 / 11 / 12 / 13+ walk-through
> covering DNS, firewall, BBR, Docker repo setup, and the gotchas
> you only hit once.

```bash
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server

# Copy the env template, then edit DOMAIN, ACME_EMAIL, and the
# generated app/db/redis passwords.
cp .env.example .env
$EDITOR .env

# Build the panel + caddy images and start everything.
./scripts/install.sh
```

`install.sh` will:

1. Build the panel image (PHP 8.3-fpm + Composer install + `php artisan
   key:generate` + `php artisan filament:install`).
2. Build the Caddy image (xcaddy with `klzgrad/forwardproxy@naive`).
3. Run DB migrations and seed a default `ServerConfig` row.
4. Prompt you to create the first admin login for the panel.
5. Render a starter `Caddyfile` (no proxy accounts yet → caddy serves
   only the fake site).
6. `docker compose up -d`.

When it finishes, the panel is at:

```
https://<your-domain>/admin
```

…protected at the Caddy edge by an additional admin basic-auth header
(see `.env` `PANEL_BASIC_AUTH_*`) so the Filament login isn't directly
exposed to the internet.

Create a proxy account, copy the cleartext password (it will only show
once), and point your Cool Tunnel client at:

```
naive+https://<username>:<password>@<your-domain>:443
```

---

## Configuring the client

In Cool Tunnel (the macOS app), add a profile with:

| Field | Value |
| --- | --- |
| Server | `naive+https://<username>:<password>@<your-domain>:443` |
| Username | `<username>` (same as panel) |
| Password | `<password>` (cleartext, shown once on creation) |
| Local SOCKS port | `1080` (default) |
| Mode | Smart, Global, or Local-only — your call |

If you don't have the client yet:
[github.com/coo1white/cool-tunnel/releases](https://github.com/coo1white/cool-tunnel/releases).

---

## Repository layout

```
cool-tunnel-server/
├── core/                          Cargo workspace (Rust)
│   ├── ct-protocol/               Pure-Rust shared crate. Profile parsing,
│   │                              SubscriptionManifestV1, wire format,
│   │                              ComponentManifestV1. Cross-platform —
│   │                              the same crate every future client links.
│   └── ct-server-core/             Server-only binary. CLI subcommands +
│                                   long-running daemon mode. Owns:
│                                   caddyfile render / caddy reload /
│                                   traffic collect / quota enforce /
│                                   probe anti-tracking / component check.
├── manifests/                     One *.upstream.json per swappable
│                                  component (caddy, forwardproxy, the
│                                  Rust crates, the panel image, db, redis).
├── docker/
│   ├── core/Dockerfile             Rust musl build → static ct-server-core
│   ├── caddy/Dockerfile            xcaddy with forwardproxy@naive
│   └── panel/Dockerfile            PHP-fpm + Composer + nginx +
│                                   ct-server-core copied in from core stage
├── caddy/
│   ├── Caddyfile.tpl               Template — Rust core substitutes
│   └── sites-fallback/             Static cover-site fallback
├── panel/                          Laravel 11 + Filament 3
│   ├── app/
│   │   ├── Filament/
│   │   │   ├── Resources/          ProxyAccount, FakeWebsite, TrafficLog
│   │   │   ├── Pages/              ServerConfig, Components (OK/NG)
│   │   │   └── Widgets/            TrafficStats
│   │   ├── Models/                 ProxyAccount, FakeWebsite, ServerConfig,
│   │   │                           TrafficLog, User
│   │   ├── Services/               CtServerCore (the shell-out), and thin
│   │   │                           wrappers: CaddyfileGenerator,
│   │   │                           CaddyReloader, TrafficCollector,
│   │   │                           ComponentChecker, PasswordGenerator,
│   │   │                           AntiTrackingFilter
│   │   ├── Console/Commands/       caddyfile:render, quota:enforce,
│   │   │                           traffic:rollup, component:check
│   │   └── Http/Controllers/       FakeSiteController, SubscriptionController
│   ├── database/migrations/        schema
│   ├── resources/views/            fake-sites + Filament page views
│   ├── routes/                     web.php + console.php
│   ├── composer.json               Laravel 11, Filament 3, predis
│   └── config/                     app, auth, db, cache, session, queue …
├── scripts/                        install.sh, update.sh, backup.sh,
│                                   render-caddyfile.sh
├── docs/
│   ├── installation-debian.md      Step-by-step Debian 10/11/12/13+
│   ├── architecture.md             Three-layer model
│   ├── components.md               How OK/NG verifies each part
│   └── cross-platform-clients.md   Future iOS / Android / Win / Linux plan
├── docker-compose.yml              core-builder + panel + caddy + db + redis
├── .env.example
├── LICENSE                         Apache 2.0
├── NOTICE                          Bundled-software attribution
├── Disclaimer.md                   Read this first
└── README.md                       You are here
```

---

## Pairs with

This is the server-side companion to:

- [coo1white/cool-tunnel](https://github.com/coo1white/cool-tunnel) —
  macOS GUI client (SwiftUI + Rust core, universal `.app`).

The client connects to any HTTP/2 CONNECT proxy that speaks
NaiveProxy's `forward_proxy` flavour. This server is one (opinionated)
way to provide that endpoint — but the client also works against a
hand-rolled Caddyfile + naive setup, or any other compatible upstream.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Read the [Disclaimer](./Disclaimer.md) before deploying.
