# Third-Party Licences

This file lists the licences of every third-party component the Cool
Tunnel Server stack builds, runs, or links against. The original code
in this repository is **AGPL-3.0-or-later** (see [LICENSE](./LICENSE));
the components below are under their own upstream terms, and those
terms must be preserved in any redistribution of the resulting stack
(including private redistribution to a single collaborator).

If you redistribute the running images, you ship every licence in
this list along with them. The cleanest way is to preserve this file
plus [NOTICE](./NOTICE) plus the per-image `/usr/share/doc/`
directories that come pre-populated by Debian / Alpine.

> **GPL-3 + AGPL-3 interaction.** sing-box (the proxy server) is
> GPL-3.0; our own code is AGPL-3.0-or-later. The two are
> compatible (AGPL-3 is GPL-3 + the network-use clause). We bundle
> sing-box as a separate process / image — *not* statically linked
> with the AGPL code — so its GPL-3 scope stays contained to its
> own image. If you ever modify sing-box's source, you must
> distribute your modified source under GPL-3.0 (we ship it
> unmodified and pin the upstream tag in
> `manifests/sing-box.upstream.json`). If you modify OUR code AND
> run a modified version as a service, AGPL § 13 obliges you to
> publish those modifications too — see [README § License](./README.md#license).

## Top-level upstream licences

| Component | Upstream | Licence |
| --- | --- | --- |
| Caddy (ACME provider) | https://github.com/caddyserver/caddy | Apache-2.0 |
| sing-box (proxy) | https://github.com/SagerNet/sing-box | **GPL-3.0** |
| NaiveProxy (client) | https://github.com/klzgrad/naiveproxy | BSD-3-Clause |
| Laravel | https://github.com/laravel/laravel | MIT |
| Filament | https://github.com/filamentphp/filament | MIT |
| predis/predis | https://github.com/predis/predis | MIT |
| MariaDB server | https://mariadb.org | GPL-2.0 |
| Redis | https://redis.io | BSD-3-Clause (≤ 7.2.x stable line we pin) |
| Composer (build-time) | https://getcomposer.org | MIT |

## Cargo crates (Rust workspace)

Full transitive graph in [`core/Cargo.lock`](./core/Cargo.lock).
Direct deps and their licences:

| Crate | Used by | Licence |
| --- | --- | --- |
| tokio | ct-server-core (async runtime) | MIT |
| serde, serde_json | both crates (de/serialisation) | MIT OR Apache-2.0 |
| sqlx | ct-server-core (DB) | MIT OR Apache-2.0 |
| hyper, hyper-util, http-body-util, bytes | ct-server-core (clash API client) | MIT |
| hyperlocal | ct-server-core (unix-socket HTTP) | MIT |
| reqwest | ct-server-core (probe HTTP) | MIT OR Apache-2.0 |
| redis | ct-server-core (revocation pub/sub) | BSD-3-Clause |
| futures-core | ct-server-core (Stream poll helper) | MIT OR Apache-2.0 |
| aes-gcm | ct-server-core (Laravel-Crypt decrypt) | Apache-2.0 OR MIT |
| base64 | ct-server-core (Laravel-Crypt envelope) | MIT OR Apache-2.0 |
| chrono | both crates (time) | MIT OR Apache-2.0 |
| tracing, tracing-subscriber | ct-server-core (logging) | MIT |
| sha2, hex, hmac | both crates (digests + signing) | MIT OR Apache-2.0 |
| clap | ct-server-core (CLI parsing) | MIT OR Apache-2.0 |

`MIT OR Apache-2.0` means upstream offers either; we honour both
notice requirements.

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

Transitive deps are in `panel/composer.lock` after `composer install`,
predominantly MIT.

## Docker base images

| Image | Component | Licence |
| --- | --- | --- |
| `caddy:2.8.4-alpine` | ACME provider | Apache-2.0 + Alpine |
| `alpine:3.20` | sing-box runtime + builder stage | Alpine licence collection |
| `rust:1.86-alpine` | Rust core build env | MIT/Apache-2.0 + Alpine |
| `dunglas/frankenphp:1-php8.4-alpine` | Panel runtime (Caddy + PHP in-process) | Apache-2.0 (Caddy) + PHP licence + Alpine |
| `mariadb:11` | DB | GPL-2.0 |
| `redis:7-alpine` | Cache + queue + revocation bus | BSD-3-Clause + Alpine |

The Alpine "licence collection" is the packaged set of licences of
every apk shipped in the base image, preserved at
`/usr/share/doc/<pkg>/copyright` inside each container.

## Verifying compliance before redistribution

If you ship the running images to anyone (even a single collaborator
or a hosted environment they can pull from), run:

```sh
# Confirm every container preserves its upstream licence directory.
for c in ct-singbox ct-panel ct-db ct-redis; do
    docker exec "$c" ls -la /usr/share/doc/ 2>/dev/null \
        || docker exec "$c" find / -iname 'COPYRIGHT*' -o -iname 'LICENSE*' 2>/dev/null \
        | head -20
done

# sing-box specifically — verify the GPL-3 source pointer is intact.
docker exec ct-singbox sing-box version
echo "Source: https://github.com/SagerNet/sing-box (tag pinned in manifests/sing-box.upstream.json)"
```

You should see sing-box's licence (GPL-3.0), MariaDB's `COPYING`,
Redis's `COPYING`, and Alpine's bundled licence files present in
their respective images. If any are missing, you are out of compliance
and must add them back (typically by not aggressively pruning the base
images during build).

## Reporting omissions

If a component is missing from this list — please open a private
issue. We add it.
