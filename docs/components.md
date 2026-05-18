# Components

Every swappable part of the stack has one manifest under
`manifests/*.upstream.json`. The manifest pins the expected version
and, when needed, a verifier command. `ct-server-core component check`
turns those manifests into an OK/NG table for the CLI and panel.

## Current Components

| Slug | Kind | Role | Check |
| --- | --- | --- | --- |
| `caddy` | container-image | Public Caddy with `mholt/caddy-l4`; ACME, SNI split, panel TLS | `caddy version` |
| `ct-protocol` | rust-crate | Shared server/client contract | lockfile |
| `ct-server-core` | binary | Rust control-plane binary | `ct-server-core version` |
| `doh-resolver` | doh-endpoint | Operator-selected DoH reachability | live RFC 8484 query |
| `mariadb` | container-image | Database | authenticated `SELECT VERSION()` |
| `panel` | container-image | Laravel + Filament admin | `php artisan ct:version` |
| `redis` | container-image | Cache, queue, revocation bus | authenticated `redis-cli INFO Server` |
| `credential-lock` | binary | DB/rendered/subscription credential invariant | guard check |

## Run The Check

```sh
docker compose exec -T panel ct-server-core component check --manifests /srv/manifests
```

The same rows appear in the panel Components page. Any `NG` row blocks
a clean update and should be fixed before trusting the release.

## Update A Component

For container/service pins, bump the manifest and the matching
Dockerfile or `docker-compose.yml` image tag together. For in-tree
versions, use:

```sh
make set-version V=0.4.X
```

Then deploy normally:

```sh
./ct update
```

`ct update` rebuilds, restarts the changed services, and runs the
component check against the post-update runtime.
