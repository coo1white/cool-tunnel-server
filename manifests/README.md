# manifests/

Upstream-pin manifests — one JSON file per swappable component.

This is the **component-as-machine-part** model. Every replaceable
piece of the stack (Rust core, ct-protocol crate, panel, MariaDB,
Redis, ...) is described by exactly one `*.upstream.json` here. The
format is shared across server and every Rust-cored client via
`ct-protocol::components`, so a manifest you write here can be
consumed unchanged by a future iOS / Android / Windows / Linux
desktop client.

## What lives here

| File | Component | Why pinned |
| --- | --- | --- |
| `caddy.upstream.json` | Stock Caddy 2 + `mholt/caddy-l4` (xcaddy build) | ACME + SNI router; reads cert from shared volume |
| `ct-server-core.upstream.json` | The Rust engine binary | Versioned alongside the operator/admin layer |
| `ct-protocol.upstream.json` | The Rust shared crate | Cross-platform contract |
| `panel.upstream.json` | The Bun/Hono admin panel container | Boot-check via Bun admin doctor |
| `client-runtime.upstream.json` | Portable client runtime catalog | Server-owned `sing-box` + `cool-tunnel-core` package for macOS today and future Android / Windows / iOS / Linux clients |
| `mariadb.upstream.json` | The DB container | Major-version drift is a flag |
| `redis.upstream.json` | Runtime cache/compatibility container | Same |
| `credential-lock.upstream.json` | Credential-lock guard | Deployment invariant |
| `doh-resolver.upstream.json` | DoH resolver reachability | Captive-portal / poisoner catch |

## OK / NG check

```sh
# From inside the panel container, or anywhere ct-server-core is on PATH.
ct-server-core component check --manifests /srv/manifests
```

Output is a one-line-per-component status table:

```
 OK  ct-protocol             pinned=0.0.1                installed=0.0.1
 OK  ct-server-core          pinned=0.0.1                installed=0.0.1
 OK  mariadb                 pinned=11                   installed=11.4.2
 OK  panel                   pinned=0.0.1                installed=ct-admin
 OK  redis                   pinned=7-alpine             installed=redis-cli 7.2
```

Use `ct doctor` or `ct-server-core component check` to refresh the
same data from the deployed stack.

## Updating a component

1. Bump the `version` in the relevant `*.upstream.json`.
2. (For containers) update the corresponding base image tag in
   `docker/<service>/Dockerfile` or `docker-compose.yml`.
3. (For Rust workspace crates) bump in `core/Cargo.toml`'s
   `workspace.package.version`.
4. `ct update` rebuilds, runs `component check`, and reports any
   NG before swapping the running container.

If `component check` reports NG after the swap, `ct update` rolls
back the image and surfaces the diagnostic.

## Why JSON, not TOML / YAML?

Because the same files are read by Rust (server + every client) and
Bun/TypeScript (operator/admin tooling). JSON is the lowest common
denominator.

## Portable Runtime Catalog

`client-runtime.upstream.json` is the public runtime package contract.
The server owns the bytes for `sing-box` and `cool-tunnel-core`; clients
only consume release assets from `coo1white/cool-tunnel-server`, verify
them against the same `SHA256SUMS`, and install the platform asset they
understand. macOS currently consumes `darwin-universal`; future Android,
Windows, iOS, and Linux clients should add new platform keys without
changing the two plugin names or moving authority back into a client
release.
