# Support and EOL policy

cool-tunnel-server is run by individual operators. We prioritise
**predictability over novelty**: long support windows, breaking
changes only at minor-version boundaries, and explicit EOL dates
on every release.

## Supported platforms

| Platform | Support tier |
| --- | --- |
| Debian 12 (bookworm) | **Tier 1** — primary CI target |
| Debian 13 (trixie) | Tier 1 — verified at each release |
| Debian 11 (bullseye) | Tier 2 — should work; not in CI |
| Ubuntu LTS (22.04, 24.04) | Tier 2 |
| Debian 10 (buster) | **Tier 3** — best effort, EOL upstream |
| Other Linux | Tier 3 — operator responsibility |
| Non-Linux | unsupported |

**Tier 1** = CI builds + boots a stack on this platform on every
release; bugs here block a release.

**Tier 2** = the install commands in `docs/installation-debian.md`
should work; we accept bug reports but a Tier-1 fix takes
precedence.

**Tier 3** = it might work; we won't actively keep it working.

## Architectures

| Arch | Support tier |
| --- | --- |
| `linux/amd64` | Tier 1 |
| `linux/arm64` | Tier 1 (CI builds the Rust core for both arches) |
| `linux/armv7` | Tier 3 (sing-box image supports it; not CI-tested) |

## Languages / runtimes (the inside-the-image versions)

| Component | Source of truth | Current pin | When we re-pin |
| --- | --- | --- | --- |
| Rust | `core/rust-toolchain.toml`, `core/Cargo.toml`, `docker/core/Dockerfile` | `1.88` | When a transitive crate raises the floor |
| Bun/admin runtime | `operator/package.json`, `docker/panel/Dockerfile` | `oven/bun:1.3.14-alpine` | At Bun minor releases inside the supported window |
| Caddy | `docker/caddy/Dockerfile` | `caddy:2.11.3-alpine` | At Caddy minor releases or Caddy module compatibility bumps |
| sing-box | `singbox-core/singbox.upstream.json` | `v1.13.12` | At sing-box minor releases |
| MariaDB | `docker-compose.yml` | `mariadb:11.8.6` | At MariaDB minor releases |
| Redis | `docker-compose.yml`, `docker/panel/Dockerfile` | `redis:7.4.8-alpine` | At Redis minor releases inside the BSD-3 line |

## Release cadence

Pre-`1.0`:

- A new `0.0.x` lands roughly every 1–4 weeks. Each release is a
  pre-release on GitHub and the tag message lists the headline
  changes.
- We do not commit to a stable wire/config format until `0.1.0`.

Post-`1.0` (target: when sing-box's `naive` inbound has had
multi-user load tested by us in production for 6+ months):

- Minor releases: every 3–6 months.
- Patch releases: as needed for security or a clear bug.
- Each minor release line is supported for **18 months** for
  security and **6 months** for bugs after the next minor lands.
  See `SECURITY.md` for the supported-versions table.

## What "supported" means

- We will publish patch releases for the supported version lines
  when a security issue is confirmed.
- We will accept bug reports against the supported lines and
  triage them.
- We will keep the manifest pinning + reproducible-build recipe
  working for the supported lines (so a 12-month-old release can
  still be built bit-for-bit if the upstream images are still
  available).

## What "supported" does NOT mean

- We will not backport features. If a feature lands in `0.2.0`,
  it stays there.
- We will not provide email / chat / phone support. Use GitHub
  Issues for bugs and Discussions for questions.
- We will not test against arbitrary Debian customisations. If
  you've replaced systemd with runit, or rebuilt Docker from
  source, or pinned `caddy` to a non-canonical fork, you're on
  your own.

## Upgrade matrix

You may always upgrade by N + 1 minor versions in one step. Skipping
a minor release line is **unsupported** unless the changelog
explicitly says so. The reason: each minor may include a database
migration that depends on the previous minor's schema being in place.

| From | To | OK? |
| --- | --- | --- |
| `0.0.X` | `0.0.X+1` | yes |
| `0.0.X` | `0.0.X+2` | yes (we keep migrations linear inside a minor line) |
| `0.0.X` | `0.1.0` | yes |
| `0.0.X` | `0.2.0` | **no** — go via `0.1.0` |
| `0.1.0` | `1.0.0` | yes |

Run the upgrade with `./ct update`. It rebuilds the images,
runs DB migrations, runs health gates, and only swaps traffic over if
the deployment reports healthy.

## Reporting bugs

GitHub Issues. Include:

1. The version you're on (`git rev-parse HEAD` and `git tag --points-at HEAD`).
2. The platform (`cat /etc/os-release` + `uname -r`).
3. The output of `ct doctor`.
4. A reproduction or, if it's intermittent, the relevant log
   excerpts (`docker compose logs --tail=200 panel singbox caddy`).

For security issues, see `SECURITY.md` — do not file public GitHub
issues for those.
