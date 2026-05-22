# cool-tunnel-server

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/badge/release-v0.4.20-1c5cdc)](https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.4.20)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

Open-source, self-hosted proxy server for a Debian VPS.

Cool Tunnel Server runs Caddy, sing-box, VLESS + Reality, MariaDB,
Redis, and a Laravel/Filament admin panel in Docker Compose. You point
a domain at your VPS, install the stack, create user accounts in the
panel, and connect devices through per-user subscription URLs.

It is a VPS-hosted VPN alternative for people who want to own and audit
their server. It is not a managed VPN service: you are responsible for
the VPS, domain, updates, backups, provider terms, and local law.

## What You Get

- **Admin panel** for accounts, settings, health, and subscription URLs.
- **Private VLESS + Reality endpoint** generated from panel state.
- **`ct` operator CLI** for install, update, doctor, backup, restore,
  and config rendering.
- **Docker Compose runtime** with Caddy SNI routing, sing-box, panel,
  MariaDB, and Redis.
- **Release-pinned runtime assets** with `SHA256SUMS` verification.
- **Privacy-first diagnostics**: project health checks must not log
  per-user destinations or track users.

## Requirements

| Need | Notes |
| --- | --- |
| Debian VPS | Debian 12 is the primary target; Debian 11/13 are supported |
| Root SSH or sudo | Required for Docker, firewall, and service setup |
| Domain name | Point an `A` record at the VPS public IPv4 |
| Open ports | `80/tcp` for ACME and `443/tcp` for panel/proxy traffic |
| Small VPS | Designed for about 1 vCPU / 1 GB RAM deployments |

New to VPS, ACME, or Docker terms? See the
[glossary](./docs/glossary.md).

## Quickstart

SSH to a fresh Debian VPS as root:

```sh
ssh root@your.vps.public.ip
```

Install base tools and open the firewall:

```sh
apt update && apt -y upgrade
apt install -y ca-certificates curl git gnupg ufw dnsutils chrony fail2ban unattended-upgrades

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Bootstrap the latest release:

```sh
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
```

Configure and install:

```sh
cd /opt/cool-tunnel-server
nano .env
./ct install
./ct doctor
```

Set at least these `.env` values before running `./ct install`:

| Key | Meaning |
| --- | --- |
| `DOMAIN` | Proxy/base domain |
| `PANEL_DOMAIN` | Admin panel hostname, usually `panel.<DOMAIN>` |
| `ACME_EMAIL` | Email for certificate renewal notices |

For the full install walkthrough, expected output, DNS checks, and
recovery hints, read [GETTING_STARTED.md](./GETTING_STARTED.md).

## Daily Operation

Most VPS operation should stay inside the `ct` command:

```sh
cd /opt/cool-tunnel-server

ct doctor   # health dashboard with PASS / WARN / FAIL remediation
ct backup   # snapshot DB + .env + ACME certs
ct update   # update to the current release and restart safely
```

Create or recover an admin user:

```sh
docker compose exec panel php artisan ct:make-admin
docker compose exec panel php artisan ct:make-admin --force --email=you@example.com
```

Open the panel at:

```text
https://<PANEL_DOMAIN>/admin
```

## What Runs

| Service | Role |
| --- | --- |
| `caddy` | Public `:443` front door, ACME, TLS, and SNI routing |
| `singbox` | VLESS + Reality proxy service |
| `panel` | Laravel + Filament admin UI and render commands |
| `db` | MariaDB data store |
| `redis` | Cache and queue backend |

The control plane is split between Laravel/Filament, TypeScript
`singbox-core`, and Rust `ct-server-core`. See
[docs/architecture.md](./docs/architecture.md) for diagrams and design
rationale.

## Project Rule

The operator experience should stay simple:

```text
install simple -> update simple -> doctor simple -> fix simple
```

That means `ct install`, `ct update`, and `ct doctor` are the normal
surface, and diagnostics should name the next command to run when
something fails.

## Release

Latest stable server release: `v0.4.20`.

Server releases own the runtime assets used by clients:

- server package/source release;
- `SHA256SUMS`;
- `sing-box` runtime asset;
- `cool-tunnel-core` runtime asset.

Clients should fetch runtime assets from
[cool-tunnel-server releases](https://github.com/coo1white/cool-tunnel-server/releases)
so client and server stay on compatible parts.

## Documentation

| Goal | Read |
| --- | --- |
| Install for the first time | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| Debian VPS install reference | [docs/installation-debian.md](./docs/installation-debian.md) |
| Update, backup, rotate, debug | [docs/operations.md](./docs/operations.md) |
| Troubleshoot install/update/doctor | [docs/operator-runbook.md](./docs/operator-runbook.md) |
| Smoke-test a release | [docs/test-vps.md](./docs/test-vps.md) |
| Understand the architecture | [docs/architecture.md](./docs/architecture.md) |
| Look up terms | [docs/glossary.md](./docs/glossary.md) |
| Contribute | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Report a security issue | [SECURITY.md](./SECURITY.md) |

The operator CLI also includes built-in help:

```sh
ct help
```

## License + Posture

- Active license: [AGPL-3.0-only](./LICENSE).
- Stricter LTSC-Heng draft:
  [LTSC-HENG-LICENSE-DRAFT.md](./LTSC-HENG-LICENSE-DRAFT.md).
- No user tracking. Internal health metrics are allowed; per-user
  destination logging is forbidden.
- Read [Disclaimer.md](./Disclaimer.md) before production use.

Bundled upstream components keep their own licenses. See
[NOTICE](./NOTICE) and
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

<sub>Jurisdiction: Wyoming, USA. Steward: coolwhite LLC.</sub>
