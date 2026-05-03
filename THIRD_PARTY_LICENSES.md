# Third-Party Licences

This file lists the licences of every third-party component the Cool
Tunnel Server stack builds, runs, or links against. The original code
in this repository is **proprietary** (see [LICENSE](./LICENSE)); the
components below are **not** — their upstream terms apply, and those
terms must be preserved in any redistribution of the resulting stack
(including private redistribution to a single collaborator).

If you redistribute the running images, you ship every licence in
this list along with them. The cleanest way is to preserve this
file plus [NOTICE](./NOTICE) plus the per-image `/usr/share/doc/`
directories that come pre-populated by Debian / Alpine.

## Top-level upstream licences

| Component | Upstream | Licence |
| --- | --- | --- |
| Caddy | https://github.com/caddyserver/caddy | Apache-2.0 |
| klzgrad/forwardproxy (NaiveProxy plugin) | https://github.com/klzgrad/forwardproxy | Apache-2.0 |
| NaiveProxy (client side, not bundled here) | https://github.com/klzgrad/naiveproxy | BSD-3-Clause |
| Laravel | https://github.com/laravel/laravel | MIT |
| Filament | https://github.com/filamentphp/filament | MIT |
| predis/predis | https://github.com/predis/predis | MIT |
| MariaDB server | https://mariadb.org | GPL-2.0 |
| Redis | https://redis.io | BSD-3-Clause (≤ 7.2.x stable line we pin) |
| Composer (build-time) | https://getcomposer.org | MIT |
| xcaddy (build-time) | https://github.com/caddyserver/xcaddy | Apache-2.0 |

## Cargo crates (Rust workspace)

The full transitive graph is in [`core/Cargo.lock`](./core/Cargo.lock)
once the workspace builds. Direct deps and their licences:

| Crate | Used by | Licence |
| --- | --- | --- |
| tokio | ct-server-core (async runtime) | MIT |
| serde, serde_json | both crates (de/serialisation) | MIT OR Apache-2.0 |
| sqlx | ct-server-core (DB) | MIT OR Apache-2.0 |
| hyper, hyper-util, http-body-util, bytes | ct-server-core (admin API client) | MIT |
| hyperlocal | ct-server-core (unix-socket HTTP) | MIT |
| reqwest | ct-server-core (probe HTTP) | MIT OR Apache-2.0 |
| redis | ct-server-core (revocation pub/sub) | BSD-3-Clause |
| chrono | both crates (time) | MIT OR Apache-2.0 |
| tracing, tracing-subscriber | ct-server-core (logging) | MIT |
| sha2, hex, hmac | both crates (digests + signing) | MIT OR Apache-2.0 |
| clap | ct-server-core (CLI parsing) | MIT OR Apache-2.0 |
| regex | ct-server-core (parsing) | MIT OR Apache-2.0 |

`MIT OR Apache-2.0` means the upstream offers either; we
unconditionally honour both notice requirements in `THIRD_PARTY_LICENSES.md`.

## Composer packages (PHP panel)

Direct deps from `panel/composer.json`:

| Package | Licence |
| --- | --- |
| laravel/framework | MIT |
| laravel/tinker | MIT |
| filament/filament | MIT |
| guzzlehttp/guzzle | MIT |
| predis/predis | MIT |
| symfony/process | MIT |

Transitive deps are listed in `panel/composer.lock` after `composer
install`. They are predominantly MIT-licensed.

## Docker base images

| Image | Component | Licence |
| --- | --- | --- |
| `caddy:builder-alpine` | xcaddy build env | Apache-2.0 (Caddy) + Alpine licence collection |
| `caddy:alpine` | Caddy runtime | Apache-2.0 + Alpine |
| `rust:1.78-alpine` | Rust core build env | MIT/Apache-2.0 + Alpine |
| `php:8.3-fpm-alpine` | Panel runtime | PHP licence + Alpine |
| `mariadb:11` | DB | GPL-2.0 |
| `redis:7-alpine` | Cache + queue + revocation bus | BSD-3-Clause + Alpine |
| `alpine:3.20` | builder stage | Alpine licence collection |

The Alpine "licence collection" is a packaged set of the licences of
every apk that ships in the base image. It is preserved at
`/usr/share/doc/<pkg>/copyright` inside each container.

## Verifying compliance before redistribution

If you ship the running images to anyone (even a single collaborator
or a hosted environment they can pull from), run:

```sh
# Confirm every container preserves its upstream licence directory.
for c in ct-caddy ct-panel ct-db ct-redis; do
    docker exec "$c" ls -la /usr/share/doc/ 2>/dev/null \
        || docker exec "$c" find / -iname 'COPYRIGHT*' -o -iname 'LICENSE*' 2>/dev/null \
        | head -20
done
```

You should see Caddy's `LICENSE`, MariaDB's `COPYING`, Redis's
`COPYING`, and Alpine's bundled licence files present in their
respective images. If any are missing, you are out of compliance and
must add them back (typically by not aggressively pruning the base
images during build).

## Reporting omissions

If a component is missing from this list — please open a private
issue. We add it.
