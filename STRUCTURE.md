# STRUCTURE.md

Map of the repository. Use this when you're trying to find which
file owns a given concern.

```
cool-tunnel-server/
│
├── core/                              Cargo workspace — Rust
│   ├── Cargo.toml                       workspace root + lints
│   ├── rust-toolchain.toml              pinned to 1.86 (sqlx icu_* needs it)
│   │
│   ├── ct-protocol/                     Pure-Rust shared crate
│   │   └── src/                           no_std-friendly, zero-IO
│   │       ├── components.rs              ComponentManifestV1 schema
│   │       ├── profile.rs                 naive+https URL parser
│   │       ├── subscription.rs            SubscriptionManifestV1
│   │       └── wire.rs                    WireRequest/Response/Event V1
│   │
│   └── ct-server-core/                  Server-only binary
│       └── src/
│           ├── main.rs                    CLI dispatch (clap)
│           ├── singbox/mod.rs             render() — the heart of the panel
│           ├── template.rs                tiny Go-template renderer
│           ├── admin.rs                   sing-box clash-API client
│           ├── redis_bridge.rs            Redis pub/sub + Coalescer hot path
│           ├── util/debounce.rs           Debouncer + Coalescer + stress tests
│           ├── laravel_crypt.rs           AES-256-GCM (matches Laravel's Crypt)
│           ├── db.rs                      SQLx queries
│           ├── domain/mod.rs              ProxyAccount / ServerConfig types
│           ├── metrics.rs                 Prometheus scraper + traffic_logs
│           ├── quota.rs                   per-account quota / expiry enforcer
│           ├── probe.rs                   anti-tracking probe (synthetic CONNECT)
│           ├── components.rs              OK/NG verifier
│           ├── subscription.rs            SubscriptionManifestV1 emitter
│           ├── daemon.rs                  long-lived JSON-over-unix-socket
│           └── err.rs                     unified Error / Result
│
├── manifests/                          *.upstream.json — one per component
│   ├── sing-box.upstream.json            the actual proxy server (GPL-3)
│   ├── naiveproxy.upstream.json          the wire-protocol reference
│   ├── ct-server-core.upstream.json
│   ├── ct-protocol.upstream.json
│   ├── panel.upstream.json
│   ├── mariadb.upstream.json
│   └── redis.upstream.json
│
├── docker/
│   ├── core/Dockerfile                  Rust musl static build
│   ├── sing-box/Dockerfile              downloads upstream binary
│   └── panel/                           FrankenPHP (Caddy + PHP in-process) + ct-server-core
│       ├── Dockerfile
│       ├── Caddyfile                    in-process Caddy config (worker mode + token mask + Server-header strip)
│       ├── supervisord.conf             runs frankenphp + queue + scheduler + ct-core daemon
│       ├── opcache.ini
│       ├── php-hardening.ini
│       └── entrypoint.sh                composer install (lock-drift-aware) + package:discover + migrate / render
│
├── sing-box/
│   └── config.json.tpl                  Go-template ({{ .Field }}) — rendered by ct-server-core
│
├── panel/                               Laravel 11 + Filament 3
│   ├── app/
│   │   ├── Filament/
│   │   │   ├── Resources/                 ProxyAccount, FakeWebsite, TrafficLog
│   │   │   ├── Pages/                     ServerConfig, Components (OK/NG)
│   │   │   └── Widgets/                   TrafficStats
│   │   ├── Models/                       Eloquent models (User, ProxyAccount, …)
│   │   ├── Services/                     Thin shell-outs to ct-server-core
│   │   │                                  + RedisRevocationBus + PasswordGenerator
│   │   ├── Console/Commands/             Artisan commands (singbox:render, …)
│   │   ├── Http/Controllers/             FakeSiteController, SubscriptionController
│   │   └── Providers/                    AppServiceProvider, AdminPanelProvider
│   ├── database/
│   │   ├── migrations/                   schema
│   │   └── seeders/                      DatabaseSeeder (ServerConfig + 3 cover sites)
│   ├── resources/views/
│   │   ├── fake-sites/                   blog / corporate / portfolio Blade
│   │   └── filament/pages/               server-config + components Blade
│   ├── config/                           app, auth, cache, db, queue, session, …
│   ├── bootstrap/                        app.php + providers.php
│   ├── routes/                           web.php (subscription + cover site)
│   ├── public/                           index.php
│   ├── composer.json                     Laravel + Filament + predis + symfony/process
│   └── .env.example                      panel-side env (compose passes from root .env)
│
├── scripts/                             Bash, all sourcing scripts/lib.sh
│   ├── lib.sh                              shared helpers (step/ok/warn/die/…)
│   ├── install.sh                          first-time bootstrap
│   ├── update.sh                           pull + rebuild + check + swap
│   ├── backup.sh                           db + ACME state + .env tarball
│   ├── render-singbox.sh                   one-shot: render config from DB
│   └── late-night-comeback.sh              10-check launch-readiness gate
│
├── docs/
│   ├── installation-debian.md           full Debian 10/11/12/13+ guide
│   ├── architecture.md                  three-layer diagram + why
│   ├── components.md                    OK/NG model
│   ├── cross-platform-clients.md        future iOS / Android / Win / Linux plan
│   ├── late-night-comeback.md           launch-readiness checklist
│   └── (this file at the root, see GETTING_STARTED.md and STRUCTURE.md)
│
├── docker-compose.yml                   sing-box + panel + db + redis
├── .env.example                         DOMAIN / ACME_EMAIL / *_PASSWORD
├── .gitignore                           target/, vendor/, .env, etc.
├── .dockerignore                        keeps build contexts small + secrets out
│
├── LICENSE                              AGPL-3.0-or-later (c) 2026 Nick (Bai Yuhang)
├── NOTICE                               bundled-software attribution
├── THIRD_PARTY_LICENSES.md              full list incl. sing-box GPL-3
├── Disclaimer.md                        operator responsibility
├── README.md                            top-of-repo overview
├── GETTING_STARTED.md                   "I SSH'd in, now what?" (this is the new-operator path)
└── STRUCTURE.md                         you are here
```

## How the layers talk to each other

```
                    Filament admin (PHP)
                          │
          shells out      │       publishes
          (CLI / daemon)  │       (revocation events)
                          ▼
               ct-server-core (Rust)         ◀── subscribes ── Redis
                          │                  ───── reads ────▶ MariaDB
              renders +   │
              hot-reloads │
                          ▼
                       sing-box
                          │
                          ▼
                     :443 (TLS) — naive client connects here
```

Every cross-layer call goes through one of:

- **Process spawn** (`Symfony\Process` in PHP → `ct-server-core` CLI)
- **Unix socket** (PHP → ct-server-core daemon at `/run/cool-tunnel/core.sock`)
- **Unix socket** (ct-server-core → sing-box clash API at `/run/sing-box/clash.sock`)
- **Redis pub/sub** (Filament saves → ct-server-core daemon listening on `cool_tunnel:revocations`)

No raw HTTP between layers; no shared in-process state. That's
deliberate — each layer can be swapped independently as long as it
keeps to one of these wire shapes.
