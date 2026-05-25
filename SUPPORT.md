# Support and EOL Policy

cool-tunnel-server is run by individual operators. We prioritize
predictability over novelty: explicit upgrade steps, release gates, and
clear EOL notes on every release.

## Supported Platforms

| Platform | Support tier |
| --- | --- |
| Debian 12 (bookworm) | Tier 1, primary target |
| Debian 13 (trixie) | Tier 1 |
| Ubuntu LTS (22.04, 24.04) | Tier 2 |
| Debian 11 (bullseye) | Tier 2 |
| Other Linux | Tier 3, operator responsibility |
| Non-Linux | unsupported for the server stack |

Tier 1 means the install/update flow is expected to work and release
bugs block shipping. Tier 2 bugs are accepted, but Tier 1 fixes take
precedence. Tier 3 is best effort.

## Architectures

| Arch | Support tier |
| --- | --- |
| `linux/amd64` | Tier 1 |
| `linux/arm64` | Tier 1 |
| `linux/armv7` | Tier 3 |

## Runtime Pins

| Component | Source of truth | Current pin | When we re-pin |
| --- | --- | --- | --- |
| Bun / TypeScript apps | `package.json`, `pnpm-lock.yaml` | release lockfile | Security or runtime fixes |
| Rust | `core/rust-toolchain.toml`, `core/Cargo.toml` | `1.88` | When a transitive crate raises the floor |
| Caddy | `manifests/caddy.upstream.json`, `docker-compose.yml` | manifest pin | Caddy or module compatibility fixes |
| sing-box | `singbox-core/singbox.upstream.json` | manifest pin | sing-box minor or security releases |
| SQLite admin state | `packages/db` migrations | bundled with v0.5.2 | Schema changes only through migrations |

The retired PHP admin, MariaDB, and Redis manifests remain only as
migration/retired-component guardrails for operators upgrading from
v0.5.1. They are not live v0.5.2 services.

## Upgrade Policy

Patch upgrades inside a minor line are expected to be direct. Minor
upgrades may require documented migration steps. The v0.5.1 to v0.5.2
upgrade moves admin state into SQLite via idempotent `packages/db`
migrations and the `ct admin migrate` flow.

Run upgrades with:

```bash
./ct update
./ct doctor
```

`ct update` runs the migration checks before restart. `ct doctor`
reports actionable migration status and points to the admin command when
manual intervention is required.

## Reporting Bugs

Open a GitHub issue and include:

1. The version (`./ct version` or `git rev-parse HEAD`).
2. The platform (`cat /etc/os-release` and `uname -m`).
3. Redacted `./ct doctor` output.
4. Relevant redacted logs, for example:

```bash
docker compose logs --tail=200 admin-api admin-web singbox caddy
```

For security issues, follow [SECURITY.md](./SECURITY.md) instead of
opening a public issue.
