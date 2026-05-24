# Third-Party Licences

This file lists the licences of every third-party component the
cool-tunnel-server stack builds, runs, or links against. The
original code in this repository is **AGPL-3.0-only**, Copyright
(C) 2026 coolwhite LLC (see [LICENSE](./LICENSE)); the components
below are under their own upstream terms, and those terms must
be preserved in any redistribution of the resulting stack.

If you redistribute the running images, you ship every licence in
this list along with them. The cleanest way is to preserve this file
plus [NOTICE](./NOTICE) plus the per-image `/usr/share/doc/`
directories that come pre-populated by Debian / Alpine.

> **AGPL-3 + GPL-3 interaction.** sing-box (the proxy server) is
> GPL-3.0; our own code is AGPL-3.0-only. AGPL-3 is GPL-3-
> compatible — they can be combined. We still bundle sing-box as
> a separate process / image (not statically linked) so its GPL-3
> scope stays contained to its own image. If you ever modify
> sing-box's source, you must distribute your modified source
> under GPL-3.0 (we ship it unmodified and pin the upstream tag
> in `manifests/sing-box.upstream.json`).
>
> **Network-source-disclosure (AGPL § 13).** If you operate a
> modified version of cool-tunnel-server as a network service
> (e.g. a paid proxy hosted for users), AGPL § 13 requires you
> to make the modified source code available to those users.
> Pin the upstream tag and offer the source URL. Running the
> stock images unmodified means you're redistributing our source
> unmodified — already satisfied by linking to this repository.

## Top-level upstream licences

| Component | Upstream | Licence |
| --- | --- | --- |
| Caddy (ACME provider) | https://github.com/caddyserver/caddy | Apache-2.0 |
| sing-box (proxy) | https://github.com/SagerNet/sing-box | **GPL-3.0** |
| NaiveProxy (client) | https://github.com/klzgrad/naiveproxy | BSD-3-Clause |
| Bun | https://github.com/oven-sh/bun | MIT |
| Hono | https://github.com/honojs/hono | MIT |
| Better Auth | https://github.com/better-auth/better-auth | MIT |
| MariaDB server | https://mariadb.org | GPL-2.0 |
| Redis | https://redis.io | BSD-3-Clause (≤ 7.2.x stable line we pin) |

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
| chrono | both crates (time) | MIT OR Apache-2.0 |
| tracing, tracing-subscriber | ct-server-core (logging) | MIT |
| sha2, hex, hmac | both crates (digests + signing) | MIT OR Apache-2.0 |
| clap | ct-server-core (CLI parsing) | MIT OR Apache-2.0 |

`MIT OR Apache-2.0` means upstream offers either; we honour both
notice requirements.

## Bun packages (operator/admin)

Direct deps from `operator/package.json`:

| Package | Licence |
| --- | --- |
| better-auth | MIT |
| hono | MIT |
| typescript | Apache-2.0 |
| @types/bun | MIT |

Transitive deps are in `operator/bun.lock` after `bun install`,
predominantly MIT or Apache-2.0.

## Docker base images

| Image | Component | Licence |
| --- | --- | --- |
| `caddy:2.8.4-alpine` | ACME provider | Apache-2.0 + Alpine |
| `alpine:3.20` | sing-box runtime + builder stage | Alpine licence collection |
| `rust:1.88-alpine` | Rust core build env | MIT/Apache-2.0 + Alpine |
| `oven/bun:1.3.14-alpine` | Bun admin runtime | MIT + Alpine |
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
