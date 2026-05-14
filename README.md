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

In plain terms: install it on a Linux server you rent for a few dollars
a month, point a domain at it, log in to the panel from your browser,
and your devices have a private proxy they can use.

> If you're not sure what a "VPS", "Docker", or "ACME cert" is, the
> [glossary](./docs/glossary.md) defines every piece of jargon used
> across the project.

## Who is this for?

- **You**, if you want a proxy server you own and can audit, sized for
  a 1 vCPU / 1 GB Debian VPS (~$3-5/month).
- **Not for you** if you want a hosted-as-a-service VPN — this is a
  thing you install and maintain yourself.

You don't need prior Docker / Laravel / Rust experience to install it.
You do need root SSH access to a Linux VPS and a domain you control.

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
make readiness
```

That's the whole flow. For a step-by-step walkthrough with expected
output at each step, DNS sanity checks, and recovery hints when things
go sideways:

→ **[GETTING_STARTED.md](./GETTING_STARTED.md)** — friendly 30-minute walkthrough

After install, daily operator life is mostly three commands:

```sh
ct doctor        # health dashboard (PASS / WARN / FAIL + remediation)
ct update        # pull latest release, rebuild, hot-swap
ct backup        # snapshot DB + .env + ACME certs
```

## Documentation map

Pick by your goal:

| Your goal | Read |
|-----------|------|
| Install for the first time | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| Same, with deeper Debian-specific detail | [docs/installation-debian.md](./docs/installation-debian.md) |
| Update / backup / rotate passwords / debug | [docs/operations.md](./docs/operations.md) |
| Understand the architecture | [docs/architecture.md](./docs/architecture.md) |
| Look up a term I don't recognize | [docs/glossary.md](./docs/glossary.md) |
| Read the design rationale for v0.x decisions | [docs/architectural-decisions-2026.md](./docs/architectural-decisions-2026.md) |
| Troubleshoot a specific failure | [docs/operator-runbook.md](./docs/operator-runbook.md) |
| Set up monitoring (Prometheus / Grafana) | [docs/observability-dashboard.md](./docs/observability-dashboard.md) |
| Read about client platforms (macOS, iOS, etc.) | [docs/cross-platform-clients.md](./docs/cross-platform-clients.md) |
| Operate from inside the GFW | [docs/going-to-china.md](./docs/going-to-china.md) |

### Help from the command line

Once installed, every operator script has a built-in mini-manual you
can read without opening source:

```sh
make help-topics                # list of topics
make help-getting-started       # what to do on a fresh VPS
make help-update                # what update.sh does + common failures
make help-doctor                # how to read the health dashboard
make help-troubleshooting       # top 8 issues, ranked by frequency
```

## What's running

A live deployment has six containers:

| Service | Role |
|---------|------|
| `haproxy` | Public `:443` TCP SNI router; routes to either sing-box or caddy without terminating TLS itself |
| `sing-box` | The NaiveProxy server users connect to with their username + password |
| `caddy` | Gets the TLS cert from Let's Encrypt (ACME), reverse-proxies the admin panel |
| `panel` | The Laravel + Filament admin UI + Rust control-plane binary; FrankenPHP worker mode |
| `db` | MariaDB; stores accounts + settings |
| `redis` | Cache + queue + revocation bus |

The control plane is split between PHP (Laravel + Filament for the UI)
and Rust (`ct-server-core` for config rendering, probes, drift checks,
and a deterministic daemon FSM). The split keeps state-management in
PHP where developer velocity matters, and bounded-parsing / artifact-
writing / probe logic in Rust where determinism matters.

For the deeper version with diagrams and rationale, see
[`docs/architecture.md`](./docs/architecture.md).

## License + posture

- **Active license**: [AGPL-3.0-only](./LICENSE).
- **Stricter LTSC-Heng draft** (under legal review):
  [LTSC-HENG-LICENSE-DRAFT.md](./LTSC-HENG-LICENSE-DRAFT.md).
- **No user tracking.** Internal health metrics (container memory,
  FSM state counts, latency distributions) are allowed; per-user
  destination logging is a posture violation. See
  [docs/observability-dashboard.md](./docs/observability-dashboard.md)
  for the full allowed/forbidden boundary.
- **Disclaimer.** Read [Disclaimer.md](./Disclaimer.md) before deploying
  to production. You are responsible for local law, provider terms,
  and the traffic you route.

Bundled upstream components keep their own licenses — see
[NOTICE](./NOTICE) and [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

## Reference index

| Document | Use |
|----------|-----|
| [GETTING_STARTED.md](./GETTING_STARTED.md) | First-deploy walkthrough |
| [docs/operations.md](./docs/operations.md) | Updating, backing up, restoring, log inspection, password rotation |
| [docs/glossary.md](./docs/glossary.md) | Plain-English definitions for every term used in the project |
| [docs/installation-debian.md](./docs/installation-debian.md) | Deep Debian-specific install reference |
| [docs/architecture.md](./docs/architecture.md) | System design, layer diagram, why each container exists |
| [docs/operator-runbook.md](./docs/operator-runbook.md) | Update, repair, incident commands |
| [docs/components.md](./docs/components.md) | OK/NG component model, the 12 pinned components |
| [docs/daemon-fsm.md](./docs/daemon-fsm.md) | Rule Maker connection FSM, transition table, constancy probe |
| [docs/observability-dashboard.md](./docs/observability-dashboard.md) | Prometheus scrape config, alert rules, Grafana queries |
| [docs/release-stress-test.md](./docs/release-stress-test.md) | Runtime gate for tagging a release |
| [docs/architectural-decisions-2026.md](./docs/architectural-decisions-2026.md) | Closing record of the 2026 self-audit programme |
| [docs/cross-platform-clients.md](./docs/cross-platform-clients.md) | Client family roadmap |
| [docs/going-to-china.md](./docs/going-to-china.md) | GFW-resistance operator runbook |
| [docs/ai-unit-test-generation.md](./docs/ai-unit-test-generation.md) | Retrieval anchors for AI maintainers |
| [LTSC.md](./LTSC.md) | Long-term servicing commitments and 2026 milestones |
| [AUDIT.md](./AUDIT.md) | Audit cycle map and release gates |
| [SECURITY.md](./SECURITY.md) | Security model and reporting path |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contributor rules and code posture |

<sub>Jurisdiction: Wyoming, USA. Steward: coolwhite LLC.</sub>
