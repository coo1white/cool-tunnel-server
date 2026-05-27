# Components

Cool Tunnel Server pins replaceable runtime parts so a self-hosted
Docker proxy server can be updated and checked predictably. This page
maps each component to its source of truth and the health gates that
verify the deployed VPS state.

Replaceable runtime parts are pinned in manifests and deployment
sources:

| Component | Source of truth |
| --- | --- |
| Caddy | `docker/caddy/Dockerfile` |
| sing-box | `singbox-core/singbox.upstream.json`, `docker/singbox/Dockerfile` |
| ct-protocol (shared Rust crate) | `core/Cargo.toml`, `core/ct-protocol/`, `manifests/ct-protocol.upstream.json` |
| Admin API | `apps/api/package.json`, `docker/admin-api/Dockerfile` |
| Admin web | `apps/web/package.json`, `docker/admin-web/Dockerfile` |
| Shared packages | `packages/*/package.json`, `pnpm-lock.yaml` |
| SQLite schema | `packages/db/src/index.ts` |
| Retired DB/cache services | `manifests/mariadb.upstream.json`, `manifests/redis.upstream.json` |

## Health Gates

Use the current operator gates instead of old per-component CLI checks:

```sh
./ct doctor
docker compose exec -T admin-api bun -e 'await fetch("http://127.0.0.1:9000/up").then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); })'
```

`doctor` is the broad PASS/WARN/FAIL dashboard. The admin API status
view reports SQLite schema status, owner setup, user counts, proxy
account counts, and the runtime actions that require shell-side doctor
checks.

MariaDB and Redis manifests are retained as retired-component markers.
They are not active services; their verify commands assert
that the retired services have not been reintroduced to Compose.

## Updating Pins

For container or service pins, update the manifest and matching
Dockerfile or `docker-compose.yml` image tag together. For in-tree
versions, use:

```sh
make set-version V=0.5.X
```

Then deploy normally:

```sh
./ct update
./ct doctor
```
