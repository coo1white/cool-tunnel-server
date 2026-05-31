# cool-tunnel-server

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/badge/release-v0.8.0-1c5cdc)](https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.8.0)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

Open-source, self-hosted proxy server for a Debian VPS.

Cool Tunnel Server runs Caddy, sing-box, VLESS + Reality, a Next.js
admin web app, and a Bun/Hono API with Better Auth and SQLite in Docker
Compose. You point a domain at your VPS, install the stack, create user
accounts in the admin UI, and connect devices through per-user
subscription URLs.

It is a VPS-hosted VPN alternative for people who want to own and audit
their server. It is not a managed VPN service: you are responsible for
the VPS, domain, updates, backups, provider terms, and local law.

## What You Get

- **Next.js admin UI** for accounts, settings, health, audit history,
  and subscription URLs.
- **Bun/Hono admin API** with Better Auth, RBAC, and SQLite storage.
- **Private VLESS + Reality endpoint** generated from admin state — the
  live sing-box config re-renders automatically on every account change,
  with a grace window on UUID rotation so clients aren't dropped mid-rotate.
- **`ct` operator CLI** for install, update, doctor, backup, restore,
  and config rendering.
- **Docker Compose runtime** with Caddy SNI routing, sing-box,
  `admin-api`, `admin-web`, and an allowlist-only `docker-proxy` that
  keeps the Docker socket out of the panel process.
- **Release-pinned Docker image bundles** (one per architecture) with
  `SHA256SUMS` verification.
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
| Disk | ~25 GB free recommended — the ~420 MB image bundle, the loaded Docker images, and update headroom can push a smaller disk to "tight" in `ct doctor` |

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

Generate the Reality keypair — a production install requires it, and the
bootstrap generates `BETTER_AUTH_SECRET` but not these:

```sh
A=$([ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64)
curl -fsSL "https://github.com/coo1white/cool-tunnel-server/releases/latest/download/singbox-core-linux-${A}" -o /tmp/singbox-core
chmod +x /tmp/singbox-core && /tmp/singbox-core reality-keygen
```

Configure and install (set the values below in `.env`, including the two
`REALITY_*` keys from the command above):

```sh
cd /opt/cool-tunnel-server
nano .env
./ct install
./ct doctor
```

Release installs download the verified Docker image bundle for the VPS
CPU architecture and load it in one step. The VPS uses `docker load`;
it does not build Rust, Bun, Go, Node/Next, or Docker images
during `ct install` or `ct update`.

Set at least these `.env` values before running `./ct install`:

| Key | Meaning |
| --- | --- |
| `DOMAIN` | Proxy/base domain |
| `PANEL_DOMAIN` | Admin panel hostname, usually `panel.<DOMAIN>` |
| `ACME_EMAIL` | Email for certificate renewal notices |
| `REALITY_PRIVATE_KEY` | `private_key` from `singbox-core reality-keygen` (43-char base64url) |
| `REALITY_PUBLIC_KEY` | Matching `public_key` from the same command |

For the full install walkthrough, expected output, DNS checks, and
recovery hints, read [GETTING_STARTED.md](./GETTING_STARTED.md).

## Panel Login and Account Setup

Open the admin UI:

```text
https://<PANEL_DOMAIN>/login
```

Create the first owner from the VPS. The token is one-time only and
expires:

```sh
cd /opt/cool-tunnel-server
ct admin bootstrap
```

Open the root-only setup URL from the generated file once; the API
stores the one-time token in an HttpOnly cookie and immediately
redirects to a clean `/setup` page. Create the owner account, then log
in at `/login`. Public signup is disabled by default. After that, create
a proxy account:

```text
Users -> New proxy account -> Save
```

After the account is created, open the account row's **Subscription
URL** action and copy the **Import URL** into the Cool Tunnel client.
That URL contains the per-account subscription token, so treat it like a
password. If you lose the URL, open the same action again; if you rotate
the UUID, copy the fresh URL after rotation.

If you need to recover access:

```sh
cd /opt/cool-tunnel-server
printf '%s\n' '<new long password>' | ct admin create-owner --email you@example.com --username you --password-stdin
printf '%s\n' '<temporary long password>' | ct admin users reset-password --id <user-id> --password-stdin
```

## Daily Operation

Most VPS operation should stay inside the `ct` command:

```sh
cd /opt/cool-tunnel-server

ct doctor   # health dashboard with PASS / WARN / FAIL remediation
ct backup   # snapshot DB + .env + ACME certs
ct update   # update to the current release and restart safely
```

### Copy-Paste VPS Update

For an already installed VPS, SSH into the server and paste:

```sh
sudo bash -lc 'set -euo pipefail; cd /opt/cool-tunnel-server; test -f .env || { echo "ERROR: .env is missing. This looks like a fresh or unfinished install, not an update."; echo "Run: cd /opt/cool-tunnel-server && cp .env.example .env && nano .env && ./ct install"; exit 1; }; ./ct backup; ./ct update; ./ct doctor; echo; echo "Admin URL:"; . ./.env; echo "https://${PANEL_DOMAIN}/login"; echo; echo "If first-owner setup is still needed, run: ct admin bootstrap"'
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
Better Auth, SQLite, Reality, and bootstrap-admin secrets for that
deployment.

## What Runs

| Service | Role |
| --- | --- |
| `caddy` | Public `:443` front door, ACME, TLS, and SNI routing |
| `singbox` | VLESS + Reality proxy service |
| `admin-api` | Hono/Bun API, Better Auth, SQLite store, subscription endpoint, and render actions |
| `admin-web` | Next.js admin dashboard |
| `docker-proxy` | Allowlist-only Docker-socket forwarder — the **only** service mounting the socket (read-only). It permits just container health reads and restarts, so `admin-api` never holds socket access that could reach the host daemon |

The control plane is the Better-T-Stack monorepo: `apps/web`,
`apps/api`, `packages/shared`, `packages/db`, `packages/security`,
`packages/config`, the TypeScript operator CLI, `singbox-core`, and the
shared Rust `ct-protocol` crate. See [docs/architecture.md](./docs/architecture.md)
for diagrams and design rationale.

## Security

Defense-in-depth for protecting admin and proxy-user data:

- **Docker-socket isolation.** Only the minimal `docker-proxy` holds the Docker
  socket (read-only) and forwards just container health reads and restarts, so a
  panel compromise cannot reach the host daemon to escape the container.
- **RBAC with peer-admin limits.** Owner / admin / operator / viewer roles are
  enforced in the API and re-checked in the data layer; admins manage only
  operator/viewer (never a peer admin or owner), and the last active owner
  cannot be removed.
- **Auth hardening.** Argon2id password hashing, secure-by-default forced
  rotation for admin-created accounts, per-IP **and** per-account login
  throttling against brute-force/spray, session-bound CSRF tokens, and
  HSTS + a strict CSP on the panel.
- **Secrets at rest.** `.env` and the SQLite database (with its WAL/SHM
  sidecars) are mode `0600`; subscription tokens are unforgeable HMACs; audit
  entries and logs redact secret values.

Found something? See [SECURITY.md](./SECURITY.md).

## Project Rule

The operator experience should stay simple:

```text
install simple -> update simple -> doctor simple -> fix simple
```

That means `ct install`, `ct update`, and `ct doctor` are the normal
surface, and diagnostics should name the next command to run when
something fails.

## Release

Latest stable server release: `v0.8.0`.

Server releases own the runtime assets used by clients:

- server package/source release;
- `SHA256SUMS`;
- `ct-operator-linux-x64` and `ct-operator-linux-arm64`;
- `singbox-core-linux-*`;
- per-architecture `cool-tunnel-server-images-linux-*.tar.gz` image
  bundle for VPS `ct install` and `ct update`;
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
