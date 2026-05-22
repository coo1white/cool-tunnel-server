# cool-tunnel-server

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/badge/release-v0.4.20-1c5cdc)](https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.4.20)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

## What is this?

A self-hosted proxy server you run on a cheap VPS. You get:

- **A web admin panel** for creating user accounts, watching health, and
  changing settings.
- **A private sing-box VLESS+Reality endpoint** your devices connect
  to with a per-user UUID.
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

## Project rule

The operator experience should stay simple:

```text
install simple -> update simple -> doctor simple -> fix simple
```

That means:

- the server owns the published runtime plugins (`sing-box` and
  `cool-tunnel-core`);
- the client fetches those plugins from `cool-tunnel-server` releases;
- `ct install`, `ct update`, and `ct doctor` are the normal user
  surface;
- when something fails, the diagnostic should name the next command to
  run.

## Current release

Latest stable server release: `v0.4.20`.

For VPS installs and updates, use the repository default branch plus
`ct update`; the operator resolves the current release and applies the
safe deploy flow.

```sh
cd /opt/cool-tunnel-server
ct backup
ct update
ct doctor
```

Release packaging stays intentionally small:

- one server package/source release;
- one `SHA256SUMS` file;
- server-owned runtime assets for `sing-box` and `cool-tunnel-core`.

The macOS client and future clients should fetch `sing-box` and
`cool-tunnel-core` from
[`cool-tunnel-server` releases](https://github.com/coo1white/cool-tunnel-server/releases),
so client and server stay on the same runtime parts.

## 60-second quickstart

The bootstrap follows the same copy/paste installer shape as
[Homebrew](https://brew.sh/): it explains what it will do, then pauses
before making changes.

```sh
# 1. SSH to your VPS as root
ssh root@your.vps.public.ip

# 2. Run the latest release bootstrap (downloads project, installs Docker, scaffolds .env)
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"

# 3. Edit .env to set DOMAIN, PANEL_DOMAIN, ACME_EMAIL
cd /opt/cool-tunnel-server && nano .env

# 4. Install (takes ~10-15 min on a 1 vCPU VPS)
ct install

# 5. Verify
ct doctor
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

Run this on the VPS for normal updates:

```sh
cd /opt/cool-tunnel-server

ct backup
ct update
ct doctor
```

If the VPS checkout is old, broken, or pinned to a stale tag, reset to
the published main first:

```sh
cd /opt/cool-tunnel-server
git fetch origin
git checkout main
git reset --hard origin/main
chmod +x ./ct ./scripts/*.sh
./scripts/fetch_operator_binary.sh || true
ct update
ct doctor
```

If `git reset --hard origin/main` feels scary, stop and inspect first:

```sh
git status
git diff --stat
```

For a production VPS, the repo should normally be clean. Put custom
notes in a separate file outside the repo, not by editing tracked
source files.

If a Rust/Docker build fails after the project already enforced
IPv4-only routing, check outbound IPv4 reachability:

```sh
curl -4 -I https://static.rust-lang.org/
curl -4 -I https://index.crates.io/
docker builder prune -af
ct update
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
| `redis` | Cache + Messenger queue |

The control plane is split between PHP (Laravel + Filament for the UI),
TypeScript (`singbox-core` for sing-box rendering), and Rust
(`ct-server-core` for Caddyfile rendering plus the deterministic daemon
FSM). For diagrams and rationale, see
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

Once installed, the operator CLI has built-in mini-manuals:
`ct help` lists them all.

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
