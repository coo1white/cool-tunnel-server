# manifests/

Upstream-pin manifests — one JSON file per swappable component.

This is the **component-as-machine-part** model. Every replaceable
piece of the current stack (Caddy, admin API, admin web, Rust core,
ct-protocol crate, client runtime catalog, and deployment guards) is
described by a `*.upstream.json` file here. Retired component manifests
may remain with `kind: retired-*` so release audits can keep old
services from reappearing by accident.

## What lives here

| File | Component | Why pinned |
| --- | --- | --- |
| `caddy.upstream.json` | Stock Caddy 2 + `mholt/caddy-l4` (xcaddy build) | ACME + SNI router; reads cert from shared volume |
| `admin-api.upstream.json` | Bun/Hono API container | Better Auth, RBAC, SQLite, subscription output, status, and render boundary |
| `admin-web.upstream.json` | Next.js admin container | Operator dashboard |
| `ct-server-core.upstream.json` | Internal Rust engine binary | Release compatibility and daemon/protocol internals |
| `ct-protocol.upstream.json` | The Rust shared crate | Cross-platform contract |
| `client-runtime.upstream.json` | Portable client runtime catalog | Server-owned `sing-box` + `cool-tunnel-core` package for macOS today and future Android / Windows / iOS / Linux clients |
| `mariadb.upstream.json` | Retired DB container | Historical marker; current runtime uses SQLite |
| `redis.upstream.json` | Retired cache/queue container | Historical marker; current runtime has no Redis runtime |
| `credential-lock.upstream.json` | Credential-lock guard | Deployment invariant |
| `doh-resolver.upstream.json` | DoH resolver reachability | Captive-portal / poisoner catch |

## OK / NG check

```sh
ct doctor
```

`ct doctor` is the supported deployed-stack health gate. It checks the
Docker services, admin API status, SQLite schema, rendered config, SNI
routing, and release assets.

## Updating a component

1. Bump the `version` in the relevant `*.upstream.json`.
2. (For containers) update the corresponding base image tag in
   `docker/<service>/Dockerfile` or `docker-compose.yml`.
3. (For app/package versions) keep `package.json`, app/package
   package manifests, and app manifests aligned.
4. `ct update` loads release images, migrates SQLite, renders config,
   restarts the stack, and reports any FAIL through `ct doctor`.

## Why JSON, not TOML / YAML?

Because the same files are read by release tooling, the operator, and
client/runtime consumers. JSON is the lowest common denominator.

## Portable Runtime Catalog

`client-runtime.upstream.json` is the public runtime package contract.
The server owns the bytes for `sing-box` and `cool-tunnel-core`; clients
only consume release assets from `coo1white/cool-tunnel-server`, verify
them against the same `SHA256SUMS`, and install the platform asset they
understand. macOS currently consumes `darwin-universal`; future Android,
Windows, iOS, and Linux clients should add new platform keys without
changing the two plugin names or moving authority back into a client
release.
