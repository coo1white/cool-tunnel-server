# cool-tunnel-server

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/badge/release-v0.4.22-1c5cdc)](https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.4.22)
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
- **Release-pinned Docker image slices** with `SHA256SUMS`
  verification and a per-architecture image BOM.
- **No local runtime builds on the VPS** during normal install/update:
  the server downloads verified release images and loads them with
  Docker.
- **Privacy-first diagnostics**: project health checks must not log
  per-user destinations or track users.

## Requirements

| Need | Notes |
| --- | --- |
| Debian VPS | Debian 12 or newer; Debian 12 is the primary target |
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

Release installs download verified Docker image slices for the VPS CPU
architecture and load them one at a time. The VPS uses `docker load`;
it does not build Rust, Bun, Go, PHP extensions, or Docker images
during `ct install` or `ct update`.

Set at least these `.env` values before running `./ct install`:

| Key | Meaning |
| --- | --- |
| `DOMAIN` | Proxy/base domain |
| `PANEL_DOMAIN` | Admin panel hostname, usually `panel.<DOMAIN>` |
| `ACME_EMAIL` | Email for certificate renewal notices |

For the full install walkthrough, expected output, DNS checks, and
recovery hints, read [GETTING_STARTED.md](./GETTING_STARTED.md).

## Panel Login and Account Setup

Open the panel:

```text
https://<PANEL_DOMAIN>/admin
```

Initial admin login:

```text
admin name: holder
password: value of CT_BOOTSTRAP_ADMIN_PASSWORD in /opt/cool-tunnel-server/.env
```

The panel forces a password change after the first login. After that,
create a device/user account:

```text
Proxy accounts -> New proxy account -> Save
```

After the account is created, open the account row's **Subscription
URL** action and copy the **Import URL** into the Cool Tunnel client.
That URL contains the per-account subscription token, so treat it like a
password. If you lose the URL, open the same action again; if you rotate
the UUID, copy the fresh URL after rotation.

If you need to recover access:

```sh
cd /opt/cool-tunnel-server
docker compose exec panel php artisan ct:make-admin
docker compose exec panel php artisan ct:make-admin --force --email=you@example.com
```

## Daily Operation

Most VPS operation should stay inside the `ct` command:

```sh
cd /opt/cool-tunnel-server

ct doctor   # health dashboard with PASS / WARN / FAIL remediation
ct backup   # snapshot DB + .env + ACME certs
ct update   # update to the current release and restart safely
ct recover  # diagnose/repair failed install/update settle gates
```

### Copy-Paste VPS Update

For an already installed VPS, SSH into the server and paste:

```sh
sudo bash -lc 'set -euo pipefail; cd /opt/cool-tunnel-server; test -f .env || { echo "ERROR: .env is missing. This looks like a fresh or unfinished install, not an update."; echo "Run: cd /opt/cool-tunnel-server && cp .env.example .env && nano .env && ./ct install"; exit 1; }; ./ct backup; ./ct update; ./ct doctor; echo; echo "Panel URL:"; . ./.env; echo "https://${PANEL_DOMAIN}/admin"; echo; echo "Bootstrap admin password, if needed:"; grep "^CT_BOOTSTRAP_ADMIN_PASSWORD=" .env || true'
```

If the update stops with `git pull failed`, reset the VPS checkout to
published `main` while preserving the current code position as a backup
branch, then rerun the update:

```sh
cd /opt/cool-tunnel-server
git status -sb
git fetch origin main
BACKUP_BRANCH="ct-backup/pre-fix-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
git branch "$BACKUP_BRANCH" HEAD
git reset --hard origin/main
./scripts/fetch_operator_binary.sh || true
./ct update
./ct doctor
```

Do not create a new `.env` on a VPS that was already working before;
recover the old `.env` from a backup instead. It contains the database,
Redis, app, and bootstrap-admin secrets for that deployment.

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

Latest stable server release: `v0.4.22`.

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
