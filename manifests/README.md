# manifests/

Upstream-pin manifests — one JSON file per swappable component.

This is the **component-as-machine-part** model. Every replaceable
piece of the stack (Rust core, ct-protocol crate, naive proxy server
+ client, panel, MariaDB, Redis) is described by exactly one
`*.upstream.json` here. The format is shared across server and every
Rust-cored client via `ct-protocol::components`, so a manifest you
write here can be consumed unchanged by a future iOS / Android /
Windows / Linux desktop client.

## What lives here

| File | Component | Why pinned |
| --- | --- | --- |
| `caddy.upstream.json` | Stock Caddy 2 + `mholt/caddy-l4` (xcaddy build) | ACME + SNI router; reads cert from shared volume |
| `naive.upstream.json` | **Canonical naive binary pin** — single source of truth for BOTH server (ct-naive) AND client (panel-bundled probe) | v0.3.0 architecture: same upstream binary on both ends prevents padding-protocol drift. Auto-synced to Dockerfile ARGs by `operator/sync-naive-pin.ts` |
| `naiveproxy.upstream.json` | The running server-side `naive` (verifies via `naive --version` inside ct-naive) | OK/NG component check after deploy |
| `naiveproxy-client.upstream.json` | The bundled client-side `naive` in the panel image (used by the anti-tracking probe) | OK/NG component check; matches `naive.upstream.json` |
| `ct-server-core.upstream.json` | The Rust engine binary | Versioned alongside the panel |
| `ct-protocol.upstream.json` | The Rust shared crate | Cross-platform contract |
| `panel.upstream.json` | The Filament + Laravel container | Boot-check via artisan |
| `mariadb.upstream.json` | The DB container | Major-version drift is a flag |
| `redis.upstream.json` | The cache / queue / revocation bus | Same |
| `credential-lock.upstream.json` | Credential-lock guard | Deployment invariant |
| `doh-resolver.upstream.json` | DoH resolver reachability | Captive-portal / poisoner catch |

Note: `sing-box.upstream.json` was removed in v0.2.0 when sing-box +
HAProxy were collapsed into Caddy+forwardproxy; v0.3.0 then split
the naive server back out into its own container, governed by the
`naive.upstream.json` canonical pin above.

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
 OK  panel                   pinned=0.0.1                installed=Laravel 11
 OK  redis                   pinned=7-alpine             installed=redis-cli 7.2
 OK  naiveproxy              pinned=148.0.7778.96        installed=naive 148.0.7778.96
 OK  naiveproxy-client       pinned=148.0.7778.96        installed=naive 148.0.7778.96
```

The same data shows up in the panel's **Components** page (Filament).
Click **Re-check** to refresh.

## Updating a component

1. Bump the `version` in the relevant `*.upstream.json`.
2. (For containers) update the corresponding base image tag in
   `docker/<service>/Dockerfile` or `docker-compose.yml`.
3. (For Rust workspace crates) bump in `core/Cargo.toml`'s
   `workspace.package.version`.
4. **For naive** (v0.3.0+ special-case): bump only `naive.upstream.json`,
   then `make sync-naive-pin` to rewrite both Dockerfile ARGs in
   lockstep. The bump must be paired with the same bump in the
   macOS client repo's `naive.upstream.json` — wire-protocol
   compatibility is the v0.3.0 architecture's central invariant.
5. `ct update` rebuilds, runs `component check`, and reports any
   NG before swapping the running container. The update preflight
   includes `make check-naive-pin`; drift between the manifest and
   the Dockerfile ARG defaults refuses to build.

If `component check` reports NG after the swap, `ct update` rolls
back the image and surfaces the diagnostic.

## Why JSON, not TOML / YAML?

Because the same files are read by Rust (server + every client) and
PHP (Filament panel widget). JSON is the lowest common denominator.
