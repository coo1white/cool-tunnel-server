# Architecture

Cool Tunnel Server is a **three-layer stack** that mirrors the
Cool Tunnel client's three-layer stack one-to-one:

|  | UI tier | Glue tier (cross-platform Rust) | TLS / ACME | Anti-tracking engine |
| --- | --- | --- | --- | --- |
| **Server** | Filament 3 (PHP / Laravel) | `ct-server-core` (Rust) + shared `ct-protocol` | Caddy 2 (stock; ACME-only) | sing-box (`naive` inbound, GPL-3.0) |
| **macOS client (today)** | SwiftUI + AppKit | `cool-tunnel-core` (Rust) | (system trust store) | Bundled `naive` Mach-O |
| **Future iOS / Android / Windows / Linux desktop clients** | Per-platform native | Same `ct-protocol` + per-platform `ct-client-core` | (system trust store) | Per-platform `naive` |

**Why Caddy is in the diagram:** sing-box ships its own ACME
implementation, but it lacks Caddy's CertMagic-grade reliability —
no multi-challenge fallback, terser error messages, smaller community.
For an operator deploying to a fresh VPS, "ACME just works" is worth
its own container. Caddy here is **stock, no plugins** (the historical
`forwardproxy` plugin is gone — see `CHANGELOG.md` for the v0.0.2 pivot).
Caddy only manages the TLS cert and writes it to a shared volume;
sing-box reads from that volume and does the actual TLS termination
+ proxying on `:443`.

The two horizontal lines that connect every row are:

1. **`ct-protocol`** — the same Rust crate every client and the
   server pull from. Defines `ProfileV1`, `SubscriptionManifestV1`,
   the JSON wire format, and the **component manifest** schema.
2. **NaiveProxy protocol** — HTTP/2 CONNECT over TLS, with the
   probe-resistance + traffic-padding shape that makes it look like
   plain HTTPS browsing. The server speaks it via sing-box's `naive`
   inbound; clients speak it via the `naive` binary they bundle.
   Same wire, two implementations of the same protocol.

## Component-as-machine-part

Every replaceable piece — sing-box, the Rust crates, the panel image,
the database, the cache — is declared in `manifests/*.upstream.json`.
The shape is defined once in `ct-protocol::components` so server and
every Rust-cored client agree.

Each component carries:

- A pinned **version**.
- An optional pinned **SHA-256** (binaries / images).
- A **verify spec**: a command to run that proves the installed
  artifact actually works, plus an expected substring or zero-exit.

`ct-server-core component check` walks every manifest, runs each
verifier, and prints an OK/NG line per component. Same data renders
in the Filament *Components* page. The macOS client today uses the
same pattern for its bundled `naive` via `naive.upstream.json` +
`NaiveBinaryResolver`; it'll move under `ct-protocol`'s shared schema
once we cut that integration.

```
                      ┌──────────────────────────────────────┐
                      │  manifests/*.upstream.json            │
                      │  ┌──────────────┐  ┌──────────────┐  │
                      │  │ sing-box     │  │ naiveproxy   │  │
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
                   │   singbox::render    admin::reload (clash)   │
                   │   metrics::collect   quota::enforce          │
                   │   probe::anti_tracking  components::check    │
                   │   redis_bridge (Coalescer + pub/sub)         │
                   └─────┬──────────────────────────────────┬────┘
                         │                                  │
            atomic write to                                 │ PUT /configs?path=…
            /etc/sing-box/config.json                       │ (clash unix socket)
                         ▼                                  │
                   ┌──────────────────────────────────┐    │
                   │           sing-box                 │◀──┘
                   │   naive inbound { users }          │
                   │   tls { cert+key from              │
                   │     /data/caddy/certificates/... } │
                   │   listen :443 (h2 + h3)            │
                   │   fallback → panel:9000 (cover     │
                   │                          site)     │
                   └──────────────────────────────────┘
                         ▲                  ▲
                         │ TLS:443          │ panel:9000 (cover-site fallback)
                         │                  │
                         │          ┌───────┴────────┐
                         │          │     panel      │
                         │          │  (PHP-FPM +    │
                         │          │   nginx +      │
                         │          │   ct-server-   │
                         │          │   core daemon) │
                         │          └────────────────┘
                         │
              ┌──────────┴────────────┐
              │  Cool Tunnel client    │
              │  (any platform)        │
              │  → naive (CONNECT)     │
              └────────────────────────┘
```

### What runs where

- **`sing-box` container** — sing-box with the `naive` inbound.
  Multi-user `users` array (cleartext passwords from the panel,
  decrypted at render time). Built-in ACME on :80; TLS-terminating
  HTTP/2 CONNECT on :443. Fallback for unauthenticated traffic
  reverse-proxies to `panel:9000` so probes see the cover site.
  The clash-API unix socket at `/run/sing-box/clash.sock` is what
  `ct-server-core` PUTs `/configs?force=true&path=…` to for hot
  reloads.
- **`panel` container** — PHP-FPM + nginx + Laravel + Filament,
  plus a copy of the `ct-server-core` Rust binary on PATH and the
  ct-server-core daemon running under supervisord. The PHP services
  in `app/Services/` are thin shell-outs to the Rust binary; the
  Rust daemon owns the Redis pub/sub subscription with the burst
  Coalescer.
- **`db` container** — MariaDB. Stores everything: proxy accounts
  (incl. encrypted cleartext passwords), fake-site templates, server
  config, traffic rollups, panel admins.
- **`redis` container** — cache, sessions, queue, and the
  `cool_tunnel:revocations` pub/sub channel.

## Why split UI / glue / engine three ways

Each layer has a different change cadence:

| Layer | Change cadence | Driven by |
| --- | --- | --- |
| **UI** | Daily | Operator preferences, new admin features |
| **Rust glue** | Weekly to monthly | Wire-format changes, new diagnostic probes |
| **NaiveProxy engine (sing-box)** | Tied to upstream releases | Censorship-resistance research |

Mixing them in one process means an upstream sing-box rev bump
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
   wire as today, regardless of whether the server is sing-box,
   forwardproxy-on-Caddy, or some future implementation.

Nothing client-side has to know any PHP exists. The protocol crate
is the contract; everything else is implementation detail.
