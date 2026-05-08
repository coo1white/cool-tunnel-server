# Cool Tunnel Server

> **Self-hosted, non-custodial operator console for borderless communication.**
>
> *Transparency over profit. Freedom over control.*

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/coo1white/cool-tunnel-server?label=release)](https://github.com/coo1white/cool-tunnel-server/releases)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

> **Read this first.** Cool Tunnel Server is the operator-side software for circumventing network censorship. Read the [Disclaimer](./Disclaimer.md) before deploying — particularly if you're outside the United States or running it for someone who is.

It is the backend for the [Cool Tunnel macOS client](https://github.com/coo1white/cool-tunnel). Once you stand it up, your client speaks to your server; everything in between looks like ordinary HTTPS to anyone observing the network. The web admin panel manages accounts, quotas, the cover site that probes see, and live operator surfaces.

---

## ⚖️ Manifesto

The internet was not designed to be partitioned. The borders we observe are policy, not topology. Cool Tunnel Server is the operator-side answer to that imposition.

We do not run servers for users. We do not custody credentials on behalf of an aggregated user base. We do not mediate trust through a centralised authority. We publish the operator console; you operate it on infrastructure you control; your users' traffic is mediated by your policy and nobody else's.

---

## ⚓ The Covenant — AGPL-3.0-only as Stewardship

This software ships under the **GNU Affero General Public License v3, no-or-later qualifier (AGPL-3.0-only)**. Copyright © 2026 coolwhite LLC.

| You may | You must |
|---|---|
| Use, study, modify, redistribute the source | Preserve the licence and source-availability |
| Run private modifications without disclosure | (no obligation while strictly private) |
| Operate a modified version as a network service | Publish those modifications under AGPL-3.0 (§ 13 — the SaaS clause) |
| Charge for hosting, support, deployment | The covenant constrains the *code*, not your operations |

The covenant is not a fence. It is the guarantee that no future hand can take this stack from the commons.

License history (forward-only): `v0.0.58–v0.0.60` shipped under AGPL-3.0-or-later; `v0.0.61–v0.0.62` shipped under PolyForm Noncommercial 1.0.0 (the "Self-Protective" era); `v0.0.63` onward returns to AGPL, this time pinned to `-only` under coolwhite LLC stewardship. Each prior tag remains available under the licence it shipped with.

---

## 🛡️ Heng — Constancy over Feature Velocity

Roadmaps invite scope creep. We practise *Heng* — constancy.

| What we ship on | What we do not ship on |
|---|---|
| Reproducibility regressions | Marketing dates |
| Audit-cycle findings (40+ codified checks) | Influencer roadmaps |
| Operator-reported defects (round-N reviews) | Feature-velocity targets |
| Upstream protocol drift | "Innovation theatre" |

The audit suite is the line we hold:

| Check | Cadence |
|---|---|
| `cargo audit` (RustSec) | weekly + every PR touching Cargo |
| `cargo deny` (license + ban + source) | weekly + every PR touching Cargo |
| `composer audit` (PHP CVEs) | weekly + every PR touching `composer.lock` |
| Manifest drift (`manifests/` ↔ `Cargo.toml` ↔ Dockerfiles) | weekly + every PR |
| Anti-tracking config smell-test | weekly + every PR |
| Stale-doc grep | weekly |
| `phpstan --level=5` + Laravel Pint + PSR-4 strict | weekly + every PR touching `panel/app/**` |
| `sqlx` offline metadata staleness | weekly + every PR |
| Tag ↔ panel-config version-sync gate | every `v*` tag push |
| Secret scan (gitleaks) | weekly |

A release ships only when this matrix is green.

---

## Protocol is Truth

| Property | Mechanism |
|---|---|
| Cover-site invariant | Every public URL on your domain returns the SAME bytes as your chosen "fake website"; probes cannot distinguish a valid endpoint from a random path. Verified end-to-end on every release. |
| TLS 1.3 only, browser-shaped handshake | The handshake itself does not fingerprint the box as a proxy. |
| No engine-fingerprint headers | `Server: Caddy` stripped; `X-Powered-By` disabled. No wire response says "Caddy", "PHP", "FrankenPHP", or "Cool Tunnel". |
| No per-connection logs | sing-box logs at `warn` only; subscription HMAC tokens never persist on disk. |
| DoH for the proxy's own DNS | Your ISP cannot observe what you resolve. |
| Three-network Docker isolation | The `ct-data` and `ct-clash` networks isolate database and management plane respectively. |
| Hot reloads in <100 ms | Add or disable accounts and the proxy picks it up without a daemon restart, without dropped connections. |

You toggle the panel-side anti-tracking flags in **Server config**. Verified by an active probe on every release.

---

## What you get

- 📡 NaiveProxy on `:443` — TLS 1.3, browser-shaped handshake.
- 🎭 Cover-site invariant on every public route.
- 👤 Multi-user with per-account expiry and byte quotas.
- 🔁 Hot reload — `<100 ms` from save to active in sing-box.
- 🛡️ Defence-in-depth — three-network isolation, no fingerprint headers, DoH, no per-connection logs.
- 🩺 Operator surface — component drift detector, self-probe canary, 11-point readiness checklist.
- 🌏 China-bound runbook — DoH default, active-probing detector, self-probe canary, "when something stops working" docs.
- 📦 One-command install — `./scripts/install.sh` walks 8 numbered steps with actionable hints on every failure.

---

## Prerequisites

- A small Linux VPS — Debian 11/12/13 recommended. **1 vCPU / 1 GB RAM is enough for a few users.**
- A domain you control (a subdomain works); A-record pointing at the VPS public IP.
- Ports `22` (SSH), `80` (Let's Encrypt), `443/tcp` (proxy) open at the cloud firewall.
- Basic comfort with `ssh` / `git` / a config-file editor. **No PHP or Rust knowledge required** — Docker handles it.

---

## Quick start

On a fresh Debian/Ubuntu VPS as `root`. Pick whichever install pattern matches your trust model.

### Pattern A — One-line install

```bash
curl -sSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash
```

Installs Docker (Compose v2), clones the repo to `/opt/cool-tunnel-server`, seeds `.env` with auto-generated DB / Redis / panel-admin secrets, prints the next-step instructions.

### Pattern B — Verify, then run

For operators who consider supply-chain integrity part of their threat model:

```bash
curl -fsSLO https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh
less bootstrap.sh                # read it
sha256sum bootstrap.sh           # cross-check against the SHA on the GitHub release page
bash bootstrap.sh
```

### Pattern C — Manual three-step

```bash
apt update && apt install -y git curl jq dnsutils apache2-utils \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
git clone https://github.com/coo1white/cool-tunnel-server.git /opt/cool-tunnel-server
cd /opt/cool-tunnel-server && cp .env.example .env && $EDITOR .env
./scripts/install.sh
```

After bootstrap (any pattern):

```bash
cd /opt/cool-tunnel-server
$EDITOR .env                     # set DOMAIN, PANEL_DOMAIN, ACME_EMAIL,
                                 # DB_PASSWORD, DB_ROOT_PASSWORD, REDIS_PASSWORD
./scripts/install.sh             # 8 numbered steps; ↳ try: hints on every failure
```

Panel at `https://panel.<your-domain>/admin`. First boot: 1–3 minutes.

> **Deploying for use from inside the Great Firewall of China?** Read [`docs/going-to-china.md`](./docs/going-to-china.md) end-to-end before you travel.

---

## What's running

| Container | Job |
| --- | --- |
| **`panel`** | Laravel 11 + Filament 3 admin. FrankenPHP + Octane worker mode. |
| **`haproxy`** | TCP-mode SNI router on `:443`. Sniffs the SNI without decrypting; forwards raw bytes — apex SNI → sing-box, panel-subdomain SNI → caddy. |
| **`sing-box`** | The proxy. Speaks NaiveProxy. Reads the config the panel renders for it. |
| **`caddy`** | ACME provider. Hands the cert to sing-box via shared volume. Reverse-proxies the panel subdomain. |
| **`db`** | MariaDB 11. Accounts, settings, traffic counters. |
| **`redis`** | Cache + the bus that pushes "this account was just disabled" to sing-box within ~100 ms. |

---

## System architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PANEL CONTAINER (single image, three runtimes)                 │
│                                                                 │
│   Filament 3 (PHP) ──┐                                          │
│   Livewire 3        │  HTTP request                             │
│                     ▼                                           │
│           ┌───────────────────┐                                 │
│           │ FrankenPHP worker │ ← long-lived; framework boot    │
│           │   (Caddy + PHP)   │   paid ONCE per worker, reused  │
│           └─────────┬─────────┘   across ~500 requests          │
│                     │ Symfony\Process exec                      │
│                     ▼                                           │
│           ┌───────────────────┐                                 │
│           │  ct-server-core   │ ← Rust subprocess; renders      │
│           │      (Rust)       │   sing-box config + Caddyfile,  │
│           └─────────┬─────────┘   talks to clash-API,           │
│                     │              scrapes Prometheus           │
└─────────────────────┼───────────────────────────────────────────┘
                      │ Unix socket / clash-API HTTP
                      ▼
                 sing-box / haproxy / caddy / db / redis
```

**Why FrankenPHP worker mode.** Every "Save" button click renders a Caddyfile, regenerates a sing-box config, and hot-reloads the proxy via the clash-API. Under classic PHP-FPM each request paid the **Laravel + Filament boot cost (~30–50 ms)** before doing real work. Worker mode keeps the framework booted across ~500 requests; per-request latency drops by the boot cost. Persistent DB connections are an additional win.

**Why a Rust subprocess for the hot path.** PHP is a comfortable place to write the admin UI; it is hostile to atomic-`fsync` writes, tight Redis pub/sub coalescing, clash-API bearer derivation, and Prometheus byte counting. `ct-server-core` (Rust, statically linked, ~8 MB) handles those four. PHP shells out via `Symfony\Process`; the boundary contract is **CLI args + JSON on stdout + structured stderr**.

Deeper walkthrough: [`docs/architecture.md`](./docs/architecture.md).

---

## QA checklist — verify your install

### Layer 1 — operator-side
- [ ] `docker compose ps` shows all six services `Up` and `healthy`.
- [ ] `LNC_TEST_PROXY_URL='https://alice:<pw>@<domain>:443' ./scripts/late-night-comeback.sh` returns ≥ 9 / 11.
- [ ] `docker compose exec panel ct-server-core component check --manifests /srv/manifests` shows 11 × OK.

### Layer 2 — PHP / FrankenPHP boundary
- [ ] `https://panel.<domain>/admin` loads, valid TLS, login page renders.
- [ ] First admin can log in.
- [ ] Five failed logins lock you out with a generic message (round-25 invariant).
- [ ] `ct:make-admin --force` recovery path works.

### Layer 3 — Filament UI → Rust subprocess
- [ ] Create a proxy account; cleartext password shown ONCE.
- [ ] Subscription URL action prints `https://panel.<domain>/api/v1/subscription/<base64-token>`.
- [ ] Server config save triggers `caddy reload` within ~5 s (`docker compose logs --tail=20 panel`).
- [ ] Activating a different cover site flips the previously-active one to inactive (round-27 invariant).
- [ ] Components page renders all 11 components, none `NG`.

### Layer 4 — end-to-end proxy traffic
- [ ] NaiveProxy client connects with `naive+https://<user>:<pw>@<domain>:443`. A real website loads.
- [ ] Cover-site invariant: `curl -sI https://<domain>/api/v1/subscription/garbage-token` returns the same `Content-Type` + `ETag` as `curl -sI https://<domain>/random-path`.
- [ ] Traffic counter increments after a few MB; `Used` bytes grow on the proxy account row.
- [ ] Set `Quota bytes = 1`; account flips to disabled within 60 minutes; client stops connecting.

If 18 / 18 tick, the install is solid.

---

## Common operations

```bash
# Live logs
docker compose logs -f --tail=20 panel
docker compose logs -f --tail=20 sing-box

# Update to latest release
git fetch --tags && git checkout main && git pull --ff-only
./scripts/update.sh

# Backup (db + .env + Caddy ACME state)
./scripts/backup.sh

# Restore onto a fresh box
./scripts/restore.sh backups/cool-tunnel-2026-05-08T05-00-00Z.tar.gz

# Pre-launch readiness gate (11-point checklist)
./scripts/late-night-comeback.sh

# Reset a forgotten admin password (round-25 recovery path)
docker compose exec panel php artisan ct:make-admin --force \
    --email=you@example.com --password=newpassword

# Full local CI gate
make ci
```

---

## Repo layout

```
cool-tunnel-server/
├── panel/              Laravel 11 + Filament 3 admin (PHP 8.4)
├── core/               Rust workspace
│   ├── ct-protocol/    Shared types future iOS / Android / etc. clients link
│   └── ct-server-core/ Server-only binary the panel shells out to
├── sing-box/           sing-box config template
├── caddy/              Caddyfile template
├── haproxy/            haproxy.cfg template (SNI router)
├── docker/             Per-service Dockerfiles
├── manifests/          Pinned versions of every component
├── scripts/            bootstrap.sh, install.sh, update.sh, backup.sh, restore.sh, late-night-comeback.sh
├── docs/               Deeper guides — installation, architecture, going-to-china
└── docker-compose.yml  Brings up the whole stack
```

Full file-by-file map: [`STRUCTURE.md`](./STRUCTURE.md).

---

## Things going wrong?

| Symptom | Cause | Fix |
| --- | --- | --- |
| Panel won't load (`connection refused`) | Cert not yet issued | `docker compose logs caddy` — wait for "certificate obtained" |
| `cargo build` killed on a 1 GB box | OOM during Rust compile (peaks ~1.5–2 GB) | Add a 2 GB swapfile + `CT_CORE_BUILD_PROFILE=release-small` in `.env` |
| `docker compose up` fails: `Pool overlaps` | Existing 172.30.0.0/24 network | Override `CT_CLASH_SUBNET` + `CT_CLASH_SINGBOX_IP` |
| Panel returns 502 after upgrade | Skipped `./scripts/update.sh` | Run it; rebuild + recreate |
| Client connects, no traffic | Account quota hit, or `expires_at` past | Check the account in the panel |
| ACME fails (`dial tcp ...:80`) | Port 80 closed at provider firewall | Open it |
| Domain doesn't resolve | DNS not propagated | `dig +short A your-domain.com` |
| Forgot admin password | No web reset (no SMTP shipped) | `docker compose exec panel php artisan ct:make-admin --force --email=... --password=...` |

Full troubleshooting: [`docs/installation-debian.md` § 10](./docs/installation-debian.md).

---

## Community

| Action | How |
| --- | --- |
| **Contribute** | Open a PR. The 18-job audit suite gates the merge. |
| **Fork** | AGPL-3.0 grants the right; preserve the licence and source-availability. AGPL § 13 obliges source-availability for any modification run as a network service. |
| **Audit** | Every push runs cargo-audit, cargo-deny, composer-audit, secret-scan (gitleaks), manifest drift, PHPStan-5, anti-tracking smell-test, and the tag↔panel-config version-sync gate. Read [`AUDIT.md`](./AUDIT.md) for the full cadence. |

The commons grows when contributors arrive. The commons survives when contributors leave.

---

## Enterprise

The code is free and will remain so. Time and expertise are the premium tier.

| Engagement | Outcome |
| --- | --- |
| Architecture review | Formal third-party assessment of your deployment, threat model, anti-tracking posture, and operational runbook. |
| Deployment consultancy | Non-trivial integrations, custom packaging, multi-region operation. |
| Excellence | Durable engineering judgement on demand. |

For commercial inquiries: open an issue tagged `enterprise:` on this repository.

---

## Pairs with

- [coo1white/cool-tunnel](https://github.com/coo1white/cool-tunnel) — macOS GUI client. Universal Apple Silicon + Intel `.app`.

The client speaks plain NaiveProxy on the wire; it works against any other NaiveProxy-protocol server too.

---

<sub>**Jurisdiction:** Wyoming, USA · **Posture:** Non-Custodial · **Philosophy:** AGPL-3.0 Hard-Copyleft · **Steward:** coolwhite LLC</sub>

<sub>Bundled upstream components ship under their own licences (Caddy Apache-2.0, sing-box GPL-3.0, NaiveProxy BSD-3, MariaDB GPL-2.0, Redis BSD-3, etc.) — see [NOTICE](./NOTICE) and [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).</sub>
