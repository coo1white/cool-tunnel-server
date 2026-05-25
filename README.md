# cool-tunnel-server

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/badge/release-v0.5.1-1c5cdc)](https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.5.1)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

Open-source, self-hosted proxy server for a Debian VPS.

Cool Tunnel Server runs Caddy, sing-box, VLESS + Reality, a Bun/Hono/Better Auth admin panel, SQLite admin auth storage, and the Rust core engine. MariaDB and Redis stay in the runtime only where retained core functionality still needs them.

## What You Get

- Minimal admin panel for login, roles, doctor/status, safe actions, and setup.
- Secure Better Auth sessions in httpOnly cookies; no default credentials.
- First-owner bootstrap with `ct admin bootstrap` and an expiring one-time token.
- Private VLESS + Reality endpoint rendered from validated config.
- `ct` operator CLI for install, update, doctor, backup, restore, render, and admin bootstrap.
- Docker Compose runtime with Caddy SNI routing, sing-box, panel, MariaDB, and Redis.
- Release-pinned Docker image slices with `SHA256SUMS` verification.

## Requirements

| Need | Notes |
| --- | --- |
| Debian VPS | Debian 12 or newer; Debian 12 is the primary target |
| Root SSH or sudo | Required for Docker, firewall, and service setup |
| Domain name | Point an `A` record at the VPS public IPv4 |
| Open ports | `80/tcp` for ACME and `443/tcp` for panel/proxy traffic |
| Small VPS | Designed for about 1 vCPU / 1 GB RAM deployments |

## Quickstart

```sh
ssh root@your.vps.public.ip
apt update && apt -y upgrade
apt install -y ca-certificates curl git gnupg ufw dnsutils chrony fail2ban unattended-upgrades
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"

cd /opt/cool-tunnel-server
nano .env
./ct install
./ct doctor
./ct admin bootstrap
```

`ct admin bootstrap` writes the setup page and one-time token to a root-only file and prints the exact `sudo cat ...` command to read it over SSH. Open the setup page, paste the token, create the first owner, delete the file, then sign in at:

```text
https://<PANEL_DOMAIN>/admin
```

Release installs download verified Docker image slices for the VPS CPU architecture and load them one at a time. The VPS uses `docker load`; it does not build Rust, Bun, Go, or Docker images during `ct install` or `ct update`.

## Daily Operation

```sh
cd /opt/cool-tunnel-server
ct doctor          # health dashboard with remediation hints
ct backup          # snapshot runtime data and secrets
ct update          # update to the current release and restart safely
ct render singbox  # re-render generated runtime config
ct recover         # diagnose/repair failed settle gates
```

For an already installed VPS:

```sh
sudo bash -lc 'set -euo pipefail; cd /opt/cool-tunnel-server; test -f .env || { echo "ERROR: .env is missing. Run: cd /opt/cool-tunnel-server && cp .env.example .env && nano .env && ./ct install"; exit 1; }; ./ct backup; ./ct update; ./ct doctor; echo; echo "Panel URL: https://<PANEL_DOMAIN>/admin"; echo "Create first owner if needed: ct admin bootstrap"'
```

Do not create a new `.env` on a VPS that was already working before; recover the old `.env` from backup instead.

## What Runs

| Service | Role |
| --- | --- |
| `caddy` | Public `:443` front door, ACME, TLS, and SNI routing |
| `singbox` | VLESS + Reality proxy service |
| `panel` | Bun/Hono/Better Auth admin UI and Rust-boundary commands |
| `db` | MariaDB store for retained core runtime data |
| `redis` | Runtime cache/compatibility service where still required |

The control plane is Bun/TypeScript for operator/admin/account work and Rust for the internal core engine. See [docs/architecture.md](./docs/architecture.md).

## Documentation

| Goal | Read |
| --- | --- |
| Install for the first time | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| Debian VPS install reference | [docs/installation-debian.md](./docs/installation-debian.md) |
| Update, backup, debug | [docs/operations.md](./docs/operations.md) |
| Troubleshoot install/update/doctor | [docs/operator-runbook.md](./docs/operator-runbook.md) |
| Understand the architecture | [docs/architecture.md](./docs/architecture.md) |
| Look up terms | [docs/glossary.md](./docs/glossary.md) |

Latest stable server release: `v0.5.1`.
