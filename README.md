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

## Step-by-step for first-time operators

For new operators, one-by-one. Each step is paste-and-go on a fresh
Debian 12 or 13 VPS as root. Copy a step, run it, wait for it to
finish, then continue. About 30 minutes start to finish.

### Step 1 — Get a VPS

A 1 vCPU / 1 GB Debian 12 or 13 VPS is enough (~$3-5/month). Tested
providers: Vultr, RackNerd, Hetzner, DigitalOcean. After provisioning
you'll have a public IPv4 address (e.g. `142.171.7.233`).

### Step 2 — Point your domain at the VPS

You need **two** DNS A records. Both point at the same VPS IP:

| Record | Purpose |
|--------|---------|
| `your-proxy-name.com` | The hostname your clients connect to (proxy traffic) |
| `panel.your-proxy-name.com` | The hostname for the admin panel (separate, by design) |

After you've set them, verify from your laptop:

```sh
dig +short A your-proxy-name.com
dig +short A panel.your-proxy-name.com
# Both should return your VPS's IPv4 address. If empty, wait 5-15 min
# for DNS to propagate, then try again.
```

Don't continue until both `dig` commands return the VPS IP. ACME will
fail at step 6 otherwise.

### Step 3 — SSH into the VPS as root

```sh
ssh root@YOUR_VPS_IP
# You should see something like:
#   Linux vultr 6.12.85+deb13-amd64 ...
#   root@vultr:~#
```

### Step 4 — Run the one-line bootstrap

```sh
curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash
```

This installs Docker, clones the repo to `/opt/cool-tunnel-server`,
generates strong random passwords in `.env`, and (v0.1.9+) auto-disables
broken IPv6 on cheap-VPS hosts. Takes 30-90 seconds.

When it finishes, it prints `Bootstrap complete.` and your next steps.

### Step 5 — Edit `.env`

```sh
cd /opt/cool-tunnel-server
nano .env
```

Change these three lines (everything else, including passwords, is
already set):

```
DOMAIN=your-proxy-name.com
PANEL_DOMAIN=panel.your-proxy-name.com
ACME_EMAIL=you@your-real-email.com
```

In `nano`: edit → `Ctrl+O` → `Enter` → `Ctrl+X` to save and exit.

### Step 6 — Run the installer

```sh
./scripts/install.sh
```

This is the long step — 5 to 15 minutes on a 1 vCPU box. You'll see
numbered colour-coded steps. At one point it asks for an email and
password for the **panel admin** user — pick what you'll log in with
in step 7.

> ⚠️ **If install.sh fails halfway and you re-run it, press `N` to the
> "Wipe prior state?" prompt.** Pressing `y` destroys the database
> volumes you just created. install.sh is idempotent and will pick up
> where it failed without wiping. Only press `y` if you genuinely want
> to start from a blank slate.

### Step 7 — Open the admin panel

In a browser on your laptop:

```
https://panel.your-proxy-name.com/admin
```

Log in with the email + password you set in step 6.

### Step 8 — Create your first proxy account

In the panel sidebar: **Proxy Accounts** → **New proxy account** →
type a username (any string, e.g. `me`) → click Save.

A green notification appears with **Username**, **Password**, and a
**Subscription URL**. **Copy all three NOW** — the cleartext
password is shown once. (If you miss it, click **Regenerate password**
on the account's detail page to issue a new one.)

### Step 9 — Install and configure the macOS client

Download the latest macOS client from
[coo1white/cool-tunnel releases](https://github.com/coo1white/cool-tunnel/releases).
Open the app, paste the Subscription URL from step 8 into the
**Import from subscription URL** field, click **Import**, then
**Start**.

### Step 10 — Verify it works

In the client's Live log you should see:

```
✓ baseline (direct, no proxy) https://www.baidu.com ...
✓ via proxy https://www.google.com/generate_204 ...
latency: 2 samples in 363ms
```

Both probes ✓ = the proxy works end-to-end. You're done.

## Common first-deploy failures (and how to fix each)

Real failure modes from real operator sessions, with paste-able fixes.
Most are auto-handled from v0.1.9 onward — listed here so you know
what the underlying issue is when something does go wrong.

### Rust build dies with `Network unreachable`

```
error: failed to download file ... static.rust-lang.org ...
   Network unreachable (os error 101)
```

**Cause:** your VPS has IPv6 enabled in the kernel but no working
global IPv6 route (common on Vultr / RackNerd / similar). Docker
buildkit prefers IPv6 and times out.

**Fix (v0.1.9+ does this automatically in `bootstrap.sh` and
`install.sh`'s pre-flight):**

```sh
sudo tee /etc/sysctl.d/99-disable-ipv6.conf <<'EOF'
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
EOF
sudo sysctl --system
echo '{"ipv6":false,"dns":["1.1.1.1","8.8.8.8"]}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
./scripts/install.sh
```

### "address already in use" on port 80, but `ss -tlnp` shows nothing

```
failed to bind host port 0.0.0.0:80/tcp: address already in use
```

**Cause:** a previous failed install left `ct-caddy` in Docker's
`Created` state. Docker reserves the host port at create-time, not at
start-time — so the port is locked even though no process is listening.

**Fix (v0.1.9+ does this automatically before `compose up -d caddy`):**

```sh
docker rm -f ct-caddy
./scripts/install.sh
```

### sing-box crash-loops with "missing domain resolver"

```
FATAL: create service: initialize DNS server[0]:
       missing domain resolver for domain server address
```

**Cause:** sing-box 1.13 requires a bootstrap DNS server when the
DoH server is in hostname form (`dns.alidns.com`). Pre-v0.1.9
templates didn't include one.

**Fix (v0.1.9+ ships the bootstrap in `sing-box/config.json.tpl`;
v0.1.10+ `ct fix --auto` self-heals existing deploys):**

```sh
docker compose exec -T panel sed -i \
  's|"server": "dns.alidns.com"|"server": "1.1.1.1"|' /etc/sing-box/config.json
docker compose restart sing-box
```

### macOS client connects, TLS succeeds, then RST after handshake

```
[debug handshake error] post-CONNECT read failed:
   Connection reset by peer (os error 54)
```

Live log recv shows `HTTP/1.1 200 OK\r\nPadding: <random>` then close.

**Cause:** the server returned the project's anti-fingerprint
cover-site response because your client's credentials don't match a
real proxy account. Usually happens when you imported the subscription
URL **before** creating the proxy account, then created the account
later — the client cached placeholder credentials.

**Fix:**

1. Verify the proxy account exists and is enabled:
   ```sh
   docker compose exec -T panel cat /etc/sing-box/config.json | grep -A2 '"users"'
   ```
   It should show a real username, not `__no_active_accounts__`.
2. In the macOS client, **click `−` to delete the cached profile**.
   Re-pasting the URL alone is a no-op; the client must delete the
   profile to refresh credentials.
3. Re-paste the subscription URL from the panel → Import → Start.

### "Local port must be ≥ 1024" in the macOS client

**Cause:** Local port is the port the **client** listens on on your
laptop's `127.0.0.1` — not the server port. Setting it to 443 is the
common confusion.

**Fix:** Local port `1080`. Server port stays `443`.

### Disk space failure in pre-flight: `low disk under docker root`

```
✗ low disk under docker root (/var/lib/docker): 3G free, need >= 4G
```

**Cause:** accumulated image layers from prior builds.

**Fix:**

```sh
docker system prune -af
docker builder prune -af
df -h /var/lib/docker   # confirm >= 4G free
./ct update
```

### Tinker says `Call to a member function ... on null`

Common when poking around the DB via `php artisan tinker`. Laravel's
`$hidden` mechanism filters sensitive columns from `toArray()`, and
some lookups have global scopes.

**Fix:** use `getAttributes()` to bypass `$hidden` and the panel UI
for everything else:

```sh
docker compose exec -T panel php artisan tinker --execute='print_r(\App\Models\ProxyAccount::first()->getAttributes());'
```

For routine operator tasks, **use the panel UI** — it's there for
this reason.

### The escape hatch: `ct fix --auto`

If something else goes wrong and you don't want to read this list:

```sh
./ct fix --auto
```

v0.1.10+ walks every known failure mode (the ones above plus more),
auto-applies the fix on any detected issue, and reports what changed.
Cron-safe and tired-operator-safe.

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
