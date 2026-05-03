# Cool Tunnel Server

Server-side stack for the [Cool Tunnel][client] family of NaiveProxy
clients (macOS today; iOS / Android / Windows / Linux desktop on the
roadmap). Three layers, mirroring the client:

|  | UI | Glue (cross-platform Rust) | Anti-tracking engine |
| --- | --- | --- | --- |
| **Server** (this repo) | Filament 3 (PHP / Laravel) | `ct-server-core` (Rust) + shared `ct-protocol` crate | sing-box `naive` inbound (GPL-3, actively maintained) |
| **macOS client** ([cool-tunnel][client]) | SwiftUI + AppKit | `cool-tunnel-core` (Rust) | Bundled `naive` Mach-O |
| **Future iOS / Android / Win / Linux** | Per-platform native | Same `ct-protocol` + per-platform core | Per-platform `naive` |

The two horizontal lines that bind every row together are the Rust
crate (`ct-protocol`) and the NaiveProxy wire format. New platforms
plug into both without re-implementing.

Runs **sing-box** as the actual NaiveProxy server (multi-user,
built-in ACME, hot reload via clash API), with a **Filament + Laravel**
admin panel that manages proxy accounts, generates the sing-box
`config.json`, hot-reloads sing-box via its clash unix socket (via the
Rust core), and serves a fake camouflage site at the apex domain
through sing-box's fallback so unauthenticated probes can't
fingerprint the box as a proxy.

[client]: https://github.com/coo1white/cool-tunnel

> **Heads-up.** This is a tool for circumventing online censorship.
> Read the [Disclaimer](./Disclaimer.md) before deploying — it covers
> intended use, operator responsibility, and what the bundled
> components are.

---

## What's in the box

| Layer | What it is |
| --- | --- |
| **`caddy`** | [caddyserver/caddy](https://github.com/caddyserver/caddy) (Apache-2.0). Stock Caddy 2 — **no plugins**. Used here as **ACME provider only**: binds `:80` for HTTP-01 challenges, manages the TLS certificate for the operator's domain via Let's Encrypt, stores the cert in a shared volume sing-box reads. Caddy's auto-HTTPS / CertMagic is the most reliable ACME implementation in the Go ecosystem; we use it because sing-box's built-in ACME lacks Caddy's multi-challenge fallback and operator-friendly error messages. |
| **`sing-box`** | [SagerNet/sing-box](https://github.com/SagerNet/sing-box) (GPL-3.0). Multi-user `naive` inbound on `:443/tcp` + `:443/udp`. **Reads the TLS cert from Caddy's volume**; does the actual TLS termination. Fallback for unauthenticated traffic reverse-proxies to the panel for the cover site. Replaces the unmaintained klzgrad/forwardproxy plugin. |
| **`ct-server-core`** | Rust binary baked into the panel image. Owns the latency-sensitive paths: sing-box config rendering (incl. Laravel-Crypt decryption of cleartext passwords), clash-API hot-reload over the unix socket, `/metrics` scraping, quota enforcement, anti-tracking probe, component OK/NG check, burst Coalescer. Uses the `ct-protocol` crate that future cross-platform clients will share. |
| **`panel`** | Laravel 11 + Filament 3 admin app. PHP services are thin shell-outs to `ct-server-core`. Manages proxy accounts, fake-site templates, server config, traffic logs, and the **Components** OK/NG page. |
| **`db`** | MariaDB 11 — proxy accounts, traffic counters, fake-site template data, panel users. |
| **`redis`** | Cache + queue backend **and** the revocation pub/sub bus that ties Filament saves to ≤100 ms sing-box reloads. |

Each piece is described by an `*.upstream.json` in [`manifests/`](./manifests/) — the **component-as-machine-part** model. Update one component, run `ct-server-core component check`, get an OK/NG verdict before swap. Same schema is used by every Rust-cored client. See [`docs/components.md`](./docs/components.md).

```
                    ┌─────────────────────────────────────┐
                    │  Cool Tunnel client (macOS / iOS)   │
                    │  — naive: HTTP/2 CONNECT over TLS   │
                    └────────────────┬────────────────────┘
                                     │ TLS:443
                                     ▼
   ┌────────────────────────────────────────────────────────────┐
   │                     sing-box container                      │
   │                                                             │
   │  TLS (built-in ACME Let's Encrypt, auto-renew on :80)      │
   │   │                                                         │
   │   ├──▶ naive inbound (multi-user from `users` array)        │
   │   │      probe_resistance, padding, h2/h3                   │
   │   │      → upstream internet                                │
   │   │                                                         │
   │   └──▶ unauthed traffic → fallback                           │
   │           reverse_proxy panel:9000 (cover site / panel)     │
   └─────────────┬──────────────────────────────┬───────────────┘
                 │ /etc/sing-box/config.json    │ /run/sing-box/clash.sock
                 ▼ (panel renders here)         │ (panel hot-reloads here)
   ┌────────────────────────────────────────────┴───────────────┐
   │                      panel container                        │
   │                                                             │
   │  Laravel 11 + Filament 3 admin (reverse-proxied behind      │
   │  sing-box with admin-only basic_auth gating /admin)         │
   │                                                             │
   │  Models:    ProxyAccount, FakeWebsite, ServerConfig,        │
   │             TrafficLog                                      │
   │  Services:  CtServerCore + thin wrappers,                   │
   │             SingBoxConfigGenerator, SingBoxReloader,        │
   │             RedisRevocationBus                              │
   │  Workers:   queue worker, scheduled traffic-rollup,         │
   │             scheduled quota check                           │
   └─────────────────────────┬───────────────────────────────────┘
                             │ PUBLISH cool_tunnel:revocations
                             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                      redis container                         │
   │  channel: cool_tunnel:revocations                            │
   │  keys:    account:status:<username> = active|revoked|…       │
   └─────────────────────────┬───────────────────────────────────┘
                             │ SUBSCRIBE (long-lived)
                             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │           ct-server-core daemon (Rust, in panel image)       │
   │  on revocation: re-render config.json, PUT /configs to       │
   │  sing-box clash API. ≤100 ms from Filament save to new       │
   │  auth blocked. Burst Coalescer collapses N events → ≤2       │
   │  reloads per 100 ms window.                                  │
   └─────────────────────────────────────────────────────────────┘
```

**Revocation latency:** new auth attempts are blocked within ~100 ms
of a Filament save (Redis pub/sub → sing-box config re-render →
clash-API reload). Bursts of saves (e.g. an admin disabling 50
accounts in one click) collapse to **at most 2 sing-box reloads per
100 ms window** thanks to the leading-edge + trailing-flush coalescer
in `redis_bridge.rs`. Existing in-flight HTTP/2 CONNECT tunnels
persist until the underlying TCP connection closes — neither sing-box
nor any other multi-user NaiveProxy server currently exposes per-user
connection enumeration. Per-request hard severing is on the v0.1
roadmap.

---

## Anti-tracking defaults

Out of the box, the rendered sing-box config enables every NaiveProxy
mitigation it exposes, plus a few panel-level defaults:

- **TLS forge / browser-shaped handshake** — sing-box's `naive`
  inbound emits a TLS ClientHello-equivalent shape that matches a
  real Chrome browser, so the handshake itself doesn't fingerprint
  the box as a proxy.
- **Padding** — naive's protocol-level padding makes traffic-flow
  analysis harder.
- **Probe resistance** — sing-box's `naive` inbound's `fallback`
  field reverse-proxies unauthenticated traffic to the panel, which
  serves a Blade-rendered cover site. Probes see a normal-looking
  website, not a proxy 401.
- **HTTP/3 (QUIC) on `:443/udp`** — harder to selectively throttle
  than TCP/443.
- **Disabled access logs by default** — only the panel records
  per-account aggregate byte counters, never URLs or remote hosts.
- **DNS over HTTPS** — sing-box's route block uses a DoH resolver
  for outbound name lookups; Cloudflare `1.1.1.1` by default,
  configurable to any DoH endpoint.
- **Cover-site rotation** — three Blade templates (blog, portfolio,
  corporate consultancy) the operator can swap between to reduce
  fingerprintability across hosts.

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

# Build the panel + sing-box images and start everything.
./scripts/install.sh
```

`install.sh` will:

1. Build the panel image (PHP 8.3-fpm + Composer install + `php artisan
   key:generate` + `php artisan filament:install`) with the
   `ct-server-core` Rust binary baked in.
2. Build the sing-box image (downloads the upstream pre-built binary,
   verifies it).
3. Run DB migrations and seed a default `ServerConfig` row.
4. Prompt you to create the first admin login for the panel.
5. Render a starter sing-box `config.json` (no proxy accounts yet →
   sing-box serves only the cover site via fallback).
6. `docker compose up -d`.

When it finishes, the panel is at:

```
https://<your-domain>/admin
```

…protected at the sing-box `naive` fallback layer by an additional
admin basic-auth header (see `.env` `PANEL_BASIC_AUTH_*`) so the
Filament login isn't directly exposed to the internet.

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
│                                   singbox render / server reload (clash) /
│                                   traffic collect / quota enforce /
│                                   probe anti-tracking / component check /
│                                   util::debounce (Coalescer).
├── manifests/                     One *.upstream.json per swappable
│                                  component (sing-box, naiveproxy, the
│                                  Rust crates, the panel image, db, redis).
├── docker/
│   ├── core/Dockerfile             Rust musl build → static ct-server-core
│   ├── sing-box/Dockerfile         Pulls upstream sing-box binary
│   └── panel/Dockerfile            PHP-fpm + Composer + nginx +
│                                   ct-server-core copied in from core stage
├── sing-box/
│   └── config.json.tpl             Template — ct-server-core substitutes
├── panel/                          Laravel 11 + Filament 3
│   ├── app/
│   │   ├── Filament/
│   │   │   ├── Resources/          ProxyAccount, FakeWebsite, TrafficLog
│   │   │   ├── Pages/              ServerConfig, Components (OK/NG)
│   │   │   └── Widgets/            TrafficStats
│   │   ├── Models/                 ProxyAccount, FakeWebsite, ServerConfig,
│   │   │                           TrafficLog, User
│   │   ├── Services/               CtServerCore (the shell-out), and thin
│   │   │                           wrappers: SingBoxConfigGenerator,
│   │   │                           SingBoxReloader, TrafficCollector,
│   │   │                           ComponentChecker, PasswordGenerator,
│   │   │                           AntiTrackingFilter, RedisRevocationBus
│   │   ├── Console/Commands/       singbox:render, quota:enforce,
│   │   │                           traffic:rollup, component:check
│   │   └── Http/Controllers/       FakeSiteController, SubscriptionController
│   ├── database/migrations/        schema
│   ├── resources/views/            fake-sites + Filament page views
│   ├── routes/                     web.php + console.php
│   ├── composer.json               Laravel 11, Filament 3, predis
│   └── config/                     app, auth, db, cache, session, queue …
├── scripts/                        install.sh, update.sh, backup.sh,
│                                   render-singbox.sh
├── docs/
│   ├── installation-debian.md      Step-by-step Debian 10/11/12/13+
│   ├── architecture.md             Three-layer model
│   ├── components.md               How OK/NG verifies each part
│   └── cross-platform-clients.md   Future iOS / Android / Win / Linux plan
├── docker-compose.yml              core-builder + panel + sing-box + db + redis
├── .env.example
├── LICENSE                         Proprietary — (c) 2026 Nick (Bai Yuhang)
├── THIRD_PARTY_LICENSES.md         Upstream Apache/MIT/BSD/GPL components
├── NOTICE                          Bundled-software attribution
├── Disclaimer.md                   Read this first
└── README.md                       You are here
```

---

## Pairs with

This is the server-side companion to:

- [coo1white/cool-tunnel](https://github.com/coo1white/cool-tunnel) —
  macOS GUI client (SwiftUI + Rust core, universal `.app`).

The client connects to any HTTP/2 CONNECT proxy that speaks the
NaiveProxy wire format. This server (sing-box `naive` inbound) is
one opinionated way to provide that endpoint — the client also
works against any other NaiveProxy-protocol server.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Read the [Disclaimer](./Disclaimer.md) before deploying.
