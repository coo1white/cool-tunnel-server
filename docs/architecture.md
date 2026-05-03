# Architecture

Cool Tunnel Server is a **three-layer stack** that mirrors the
Cool Tunnel client's three-layer stack one-to-one:

|  | UI tier | Glue tier (cross-platform Rust) | Anti-tracking engine |
| --- | --- | --- | --- |
| **Server** | Filament 3 (PHP / Laravel) | `ct-server-core` (Rust) + shared `ct-protocol` | `forwardproxy@naive` plugin baked into Caddy |
| **macOS client (today)** | SwiftUI + AppKit | `cool-tunnel-core` (Rust) — already ships in [coo1white/cool-tunnel](https://github.com/coo1white/cool-tunnel) | Bundled `naive` Mach-O |
| **Future iOS / Android / Windows / Linux desktop clients** | Per-platform native (Swift / Kotlin / C++ / GTK or Qt) | Same `ct-protocol` crate + a per-platform `ct-client-core` | Per-platform `naive` build |

The two horizontal lines that connect every row are:

1. **`ct-protocol`** — the same Rust crate every client and the
   server pull from. Defines `ProfileV1`, `SubscriptionManifestV1`,
   the JSON wire format, and the **component manifest** schema.
2. **NaiveProxy** — the same wire protocol on every platform: HTTP/2
   CONNECT over TLS to a `forward_proxy`-mode Caddy. The server
   speaks it via the `forwardproxy@naive` Caddy plugin; clients
   speak it via the `naive` binary they bundle.

## Component-as-machine-part

Every replaceable piece — Rust core, the protocol crate, the
NaiveProxy engine, Caddy, the panel, the database, the cache — is
declared in `manifests/*.upstream.json`. The shape is defined once
in `ct-protocol::components` so server and every Rust-cored client
agree.

Each component carries:

- A pinned **version**.
- An optional pinned **SHA-256** (binaries / images).
- A **verify spec**: a command to run that proves the installed
  artifact actually works, plus an expected substring or zero-exit.

`ct-server-core component check` walks every manifest, runs each
verifier, and prints an OK/NG line per component. Same data renders
in the Filament *Components* page. The macOS client today doesn't
yet have this page, but its `naive.upstream.json` is already a
manifest in the same spirit and will move under `ct-protocol`'s
shared schema once we cut that integration.

```
                      ┌──────────────────────────────────────┐
                      │  manifests/*.upstream.json            │
                      │  ┌──────────────┐  ┌──────────────┐  │
                      │  │ caddy        │  │ forwardproxy │  │
                      │  │ ct-server-…  │  │ ct-protocol  │  │
                      │  │ panel        │  │ mariadb      │  │
                      │  │ redis        │  │ …            │  │
                      │  └──────────────┘  └──────────────┘  │
                      └──────────────────────────────────────┘
                                        ▲
                                        │ schema = ct_protocol::components
                                        │
            ┌────────────────────────────┼─────────────────────────────┐
            │                            │                             │
            ▼                            ▼                             ▼
   ┌─────────────────┐         ┌─────────────────┐          ┌─────────────────┐
   │ ct-server-core  │         │ Filament        │          │ Future client   │
   │ component check │         │ Components page │          │ Components view │
   │ (CLI + daemon)  │         │ (PHP)           │          │ (Rust + native) │
   └─────────────────┘         └─────────────────┘          └─────────────────┘
```

## Inside the server box

```
                   ┌─────────────────────────────────────────────┐
                   │             Filament admin (PHP)             │
                   │   ProxyAccount / FakeWebsite / ServerConfig  │
                   │   resources, Components page,                │
                   │   subscription endpoint                      │
                   └────────────────┬────────────────────────────┘
                                    │ Process::spawn /
                                    │ unix-socket JSON
                   ┌────────────────▼────────────────────────────┐
                   │           ct-server-core (Rust)              │
                   │   caddyfile::render   admin::reload          │
                   │   metrics::collect    quota::enforce         │
                   │   probe::anti_tracking  components::check    │
                   │   daemon (long-running)                      │
                   └─────┬──────────────────────────────────┬────┘
                         │                                  │
            POST /load    │                                  │ POST /load
            (text/caddyfile)                                 │ (admin API)
                         ▼                                  │
                   ┌──────────────────────────────────┐    │
                   │            Caddy                  │◀───┘
                   │   forward_proxy { hide_ip,        │
                   │                   hide_via,       │
                   │                   probe_resistance}│
                   │   tls (ACME)                      │
                   │   reverse_proxy → panel (cover    │
                   │                        site)      │
                   └──────────────────────────────────┘
                         ▲                  ▲
                         │ TLS:443          │ panel:9000 (cover-site fallthrough)
                         │                  │
                         │          ┌───────┴────────┐
                         │          │     panel      │
                         │          │  (PHP-FPM)     │
                         │          └────────────────┘
                         │
                         │
              ┌──────────┴────────────┐
              │  Cool Tunnel client    │
              │  (any platform)        │
              │  → naive (CONNECT)     │
              └────────────────────────┘
```

### What runs where

- **`caddy` container** — Caddy (with `forwardproxy@naive` baked in
  via `xcaddy`), terminates TLS, runs the proxy. Has the unix socket
  the panel writes Caddyfile to and that `ct-server-core` posts
  reloads to.
- **`panel` container** — PHP-FPM + nginx + Laravel + Filament,
  plus a copy of the `ct-server-core` Rust binary on PATH. The PHP
  services in `app/Services/` are thin shell-outs to the Rust binary.
  A queue worker serializes Caddy reload requests so they never
  collide.
- **`db` container** — MariaDB. Stores everything: proxy accounts,
  fake-site templates, server config, traffic rollups, panel
  admins.
- **`redis` container** — cache, sessions, queue.

## Why split UI / glue / engine three ways

Each layer has a different change cadence:

| Layer | Change cadence | Driven by |
| --- | --- | --- |
| **UI** | Daily | Operator preferences, new admin features |
| **Rust glue** | Weekly to monthly | Wire-format changes, new diagnostic probes |
| **NaiveProxy engine** | Tied to upstream releases | Censorship-resistance research |

Mixing them in one process means an upstream `naive` rev bump
forces you to redeploy your UI. The split lets each piece move on
its own schedule, with the **component manifests** giving you a
machine-readable record of what version of each piece you're
running and a one-line OK/NG check before you trust it.

## How a client uses this

A future `ct-client-core` (any platform) would:

1. Pull `ct-protocol` as a Cargo dep.
2. Use `ProfileV1::parse` to validate user-pasted URLs.
3. Use `SubscriptionManifestV1` to deserialize the JSON the panel
   serves at `/api/v1/subscription/<token>` and verify its
   `X-CT-Signature` header.
4. Use `ComponentManifestV1` to render its own *Components* tab
   with the local `naive` binary and the local Rust core checked
   the same way the server checks its own components.
5. Speak NaiveProxy (HTTP/2 CONNECT) to the server's :443 — same
   wire as today.

Nothing client-side has to know any PHP exists. The protocol crate
is the contract; everything else is implementation detail.
