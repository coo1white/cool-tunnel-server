# manifests/

Upstream-pin manifests — one JSON file per swappable component.

This is the **component-as-machine-part** model. Every replaceable
piece of the stack (Rust core, ct-protocol crate, sing-box NaiveProxy
server, panel, MariaDB, Redis) is described by exactly one
`*.upstream.json` here. The format is shared across server and every
Rust-cored client via `ct-protocol::components`, so a manifest you
write here can be consumed unchanged by a future iOS / Android /
Windows / Linux desktop client.

## What lives here

| File | Component | Why pinned |
| --- | --- | --- |
| `sing-box.upstream.json` | The actively-maintained NaiveProxy server | Verify clash API + multi-user reload work |
| `naiveproxy.upstream.json` | The NaiveProxy client family (klzgrad/naiveproxy) | Wire-protocol reference; bundled by clients, not the server |
| `ct-server-core.upstream.json` | The Rust engine binary | Versioned alongside the panel |
| `ct-protocol.upstream.json` | The Rust shared crate | Cross-platform contract |
| `panel.upstream.json` | The Filament + Laravel container | Boot-check via artisan |
| `mariadb.upstream.json` | The DB container | Major-version drift is a flag |
| `redis.upstream.json` | The cache / queue / revocation bus | Same |

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
 OK  sing-box                pinned=1.10.7               installed=sing-box version 1.10.7
```

The same data shows up in the panel's **Components** page (Filament).
Click **Re-check** to refresh.

## Updating a component

1. Bump the `version` in the relevant `*.upstream.json`.
2. (For containers) update the corresponding base image tag in
   `docker/<service>/Dockerfile` or `docker-compose.yml`.
3. (For Rust workspace crates) bump in `core/Cargo.toml`'s
   `workspace.package.version`.
4. `./scripts/update.sh` rebuilds, runs `component check`, and
   reports any NG before swapping the running container.

If `component check` reports NG after the swap, `update.sh` rolls
back the image and surfaces the diagnostic.

## Why JSON, not TOML / YAML?

Because the same files are read by Rust (server + every client) and
PHP (Filament panel widget). JSON is the lowest common denominator.
