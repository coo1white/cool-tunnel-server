# Components

Cool Tunnel Server pins replaceable runtime parts so a self-hosted Docker proxy server can be updated and checked predictably.

| Component | Source of truth |
| --- | --- |
| Caddy | `docker/caddy/Dockerfile` |
| sing-box | `singbox-core/singbox.upstream.json`, `docker/singbox/Dockerfile` |
| Rust core | `core/Cargo.toml`, `core/rust-toolchain.toml`, `docker/core/Dockerfile` |
| Admin panel | `operator/package.json`, `operator/src/admin/`, `docker/panel/Dockerfile` |
| MariaDB | `docker-compose.yml`, retained only where core runtime still needs it |
| Redis | `docker-compose.yml`, retained only where runtime compatibility still needs it |
| Admin/auth DB | SQLite at `CT_ADMIN_DB_PATH`, default `/data/admin/admin.sqlite` |

## Health Gates

```sh
./ct doctor
./ct admin doctor
./ct render caddyfile
./ct render singbox
```

`doctor` is the broad PASS/WARN/FAIL dashboard. Admin migrations are safe to rerun with:

```sh
./ct admin migrate
```

## Updating Pins

For container or service pins, update the manifest and matching Dockerfile or `docker-compose.yml` image tag together. For in-tree versions, use:

```sh
make set-version V=0.4.X
```

Then deploy normally:

```sh
./ct update
./ct doctor
```
