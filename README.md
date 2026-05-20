# Cool Tunnel Server / Panel

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/github/v/release/coo1white/cool-tunnel-server?label=release)](https://github.com/coo1white/cool-tunnel-server/releases)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

## What is this?

A self-hosted proxy server you run on a cheap VPS. You get:

- **A web admin panel** for creating user accounts, watching health, and
  changing settings.
- **A private NaiveProxy / sing-box endpoint** your devices connect to
  with a username + password.
- **A subscription URL** you can share with your phone / laptop client.

Install it on a Linux server you rent for a few dollars a month, point
a domain at it, log in to the panel from your browser, and your devices
have a private proxy they can use.

> Unfamiliar with "VPS", "Docker", or "ACME cert"? The
> [glossary](./docs/glossary.md) defines every piece of jargon.

## Who is this for?

- **You**, if you want a proxy server you own and can audit, sized for
  a 1 vCPU / 1 GB Debian VPS (~$3-5/month).
- **Not for you** if you want a hosted-as-a-service VPN — this is a
  thing you install and maintain yourself.

You don't need prior Docker / Laravel / Rust experience. You do need
root SSH access to a Linux VPS and a domain you control.

## 60-second quickstart

```sh
# 1. SSH to your VPS as root
ssh root@your.vps.public.ip

# 2. Run the bootstrap (downloads project, installs Docker, scaffolds .env)
curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash

# 3. Edit .env to set DOMAIN, PANEL_DOMAIN, ACME_EMAIL
cd /opt/cool-tunnel-server && nano .env

# 4. Install (takes ~10-15 min on a 1 vCPU VPS)
make install

# 5. Verify
make doctor
```

For the step-by-step walkthrough with expected output, DNS sanity
checks, and recovery hints:
**[GETTING_STARTED.md](./GETTING_STARTED.md)**.

If something breaks during install, run `./ct doctor` and follow the
PASS / WARN / FAIL remediation hints.

After install, daily operator life is mostly three commands:

```sh
ct doctor        # health dashboard (PASS / WARN / FAIL + remediation)
ct update        # pull latest release, rebuild, hot-swap
ct backup        # snapshot DB + .env + ACME certs
```

## Common VPS workflows

### Update to a release

Latest confirmed release: `v0.4.9`.

Run this on the VPS:

```sh
cd /opt/cool-tunnel-server

./ct backup

git fetch origin --tags
git checkout v0.4.9

./ct update
./ct doctor
```

If the VPS is very old and `./ct` is missing or broken, refresh the
checkout and fetch the operator binary first:

```sh
cd /opt/cool-tunnel-server
git fetch origin --tags
git checkout v0.4.9
chmod +x ./ct ./scripts/*.sh
./scripts/fetch_operator_binary.sh || true
./ct update
./ct doctor
```

If `git checkout v0.4.9` complains about local changes:

```sh
git status
```

If you did not intentionally edit those files on the VPS, stash them and
continue:

```sh
git stash push -m "pre-v0.4.9-vps-local-changes"
git checkout v0.4.9
./ct update
./ct doctor
```

Do not skip the backup. `ct update` handles legacy `.env` migration,
rebuilds containers, runs database migrations, re-renders config, and
restarts the stack.

### Register or recover an admin user

Fresh installs prompt for the first Filament admin user. Updates do not
create or reset admins automatically, so use the panel container command
when you need to create an admin later:

```sh
docker compose exec panel php artisan ct:make-admin
```

To reset an existing admin password, re-promote the account to admin,
and re-enable it:

```sh
docker compose exec panel php artisan ct:make-admin --force --email=you@example.com
```

For a fully non-interactive create or reset:

```sh
docker compose exec panel php artisan ct:make-admin \
  --name="Admin" \
  --email="you@example.com" \
  --password="change-this-long-password"
```

Then log in at:

```text
https://<PANEL_DOMAIN>/admin
```

## What's running

A live deployment has five containers:

| Service | Role |
|---------|------|
| `caddy` | Public `:443` — layer-4 SNI splitter (via `mholt/caddy-l4`) routes panel traffic to itself, everything else to sing-box; also terminates TLS for the panel and gets certs from Let's Encrypt (ACME) |
| `singbox` | The sing-box VLESS+Reality proxy users connect to; config rendered by `singbox-core render-server`, file-watched and respawned by `singbox-core supervise` |
| `panel` | The Laravel + Filament admin UI + Rust control-plane binary; FrankenPHP worker mode |
| `db` | MariaDB; stores accounts + settings |
| `redis` | Cache + queue + revocation bus |

The control plane is split between PHP (Laravel + Filament for the UI)
and Rust (`ct-server-core` for config rendering, probes,
and a deterministic daemon FSM). For diagrams and rationale, see
[`docs/architecture.md`](./docs/architecture.md).

## Documentation map

| Your goal | Read |
|-----------|------|
| Install for the first time | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| Deep Debian-specific install reference | [docs/installation-debian.md](./docs/installation-debian.md) |
| Update / backup / rotate passwords / debug | [docs/operations.md](./docs/operations.md) |
| Troubleshoot a specific failure | [docs/operator-runbook.md](./docs/operator-runbook.md) |
| Smoke-test a release on a throwaway VPS | [docs/test-vps.md](./docs/test-vps.md) |
| Understand the architecture | [docs/architecture.md](./docs/architecture.md) |
| Look up a term | [docs/glossary.md](./docs/glossary.md) |
| Read the design rationale for v0.x decisions | [docs/architectural-decisions-2026.md](./docs/architectural-decisions-2026.md) |
| Set up monitoring (Prometheus / Grafana) | [docs/observability-dashboard.md](./docs/observability-dashboard.md) |
| Read about client platforms (macOS, iOS, etc.) | [docs/cross-platform-clients.md](./docs/cross-platform-clients.md) |
| Operate from inside the GFW | [docs/going-to-china.md](./docs/going-to-china.md) |
| Contribute | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Report a security issue | [SECURITY.md](./SECURITY.md) |

Once installed, every operator script has a built-in mini-manual:
`make help-topics` lists them all.

## License + posture

- **Active license**: [AGPL-3.0-only](./LICENSE).
- **Stricter LTSC-Heng draft** (under legal review):
  [LTSC-HENG-LICENSE-DRAFT.md](./LTSC-HENG-LICENSE-DRAFT.md).
- **No user tracking.** Internal health metrics are allowed; per-user
  destination logging is a posture violation. See
  [docs/observability-dashboard.md](./docs/observability-dashboard.md)
  for the allowed/forbidden boundary.
- **Disclaimer.** Read [Disclaimer.md](./Disclaimer.md) before deploying
  to production. You are responsible for local law, provider terms,
  and the traffic you route.

Bundled upstream components keep their own licenses — see
[NOTICE](./NOTICE) and [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

<sub>Jurisdiction: Wyoming, USA. Steward: coolwhite LLC.</sub>
