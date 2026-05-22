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
| Rust core | `core/Cargo.toml`, `core/rust-toolchain.toml`, `docker/core/Dockerfile` |
| Panel | `panel/composer.json`, `docker/panel/Dockerfile` |
| MariaDB | `docker-compose.yml` |
| Redis | `docker-compose.yml`, `docker/panel/Dockerfile` |
| Credential lock | `manifests/credential-lock.upstream.json`, `panel/app/Console/Commands/CredentialLockCheck.php` |

## Health Gates

Use the current operator gates instead of old per-component CLI checks:

```sh
./ct doctor
docker compose exec -T panel php artisan credential-lock:check
```

`doctor` is the broad PASS/WARN/FAIL dashboard. `credential-lock:check`
verifies that the DB, rendered sing-box config, and subscription output
agree on active credentials.

## Updating Pins

For container or service pins, update the manifest and matching
Dockerfile or `docker-compose.yml` image tag together. For in-tree
versions, use:

```sh
make set-version V=0.4.X
```

Then deploy normally:

```sh
./ct update
./ct doctor
```
