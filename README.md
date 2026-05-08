# Cool Tunnel Server

> A self-hosted, censorship-resistant proxy server for Linux VPS — looks like normal HTTPS on the wire, runs in Docker, comes with a web admin panel.

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/coo1white/cool-tunnel-server)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/coo1white/cool-tunnel-server?label=release)](https://github.com/coo1white/cool-tunnel-server/releases)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

> [!IMPORTANT]
> This is a tool for circumventing online censorship. Read the [Disclaimer](./Disclaimer.md) before deploying — particularly if you're outside the United States or running it for someone who is.

It's the backend for the [Cool Tunnel macOS client](https://github.com/coo1white/cool-tunnel) — once you've set this up, your client connects to your server and your traffic looks like normal HTTPS browsing to anyone watching the network. You manage everything (user accounts, quotas, the "fake website" your domain shows to scanners, who's connected) through a web admin panel.

---

## Contents

- [What you get](#what-you-get)
- [What you need before you start](#what-you-need-before-you-start)
- [Quick start](#quick-start)
- [What's running](#whats-running)
- [Adding your first proxy user](#adding-your-first-proxy-user)
- [Anti-tracking — what the server hides](#anti-tracking--what-the-server-hides)
- [Common operations](#common-operations)
- [Repo layout](#repo-layout)
- [Things going wrong?](#things-going-wrong)
- [Pairs with](#pairs-with)
- [Releases](#releases)
- [License](#license)

---

## What you get

- 📡 **NaiveProxy on `:443`** — TLS 1.3, browser-shaped handshake, indistinguishable from regular HTTPS to network observers
- 🎭 **Cover-site invariant** — every public URL on your domain returns the SAME bytes as your chosen "fake website"; probes can't distinguish a valid endpoint from a random path
- 👤 **Multi-user**, with per-account expiry and byte quotas, all manageable from the admin UI
- 🔁 **Hot reloads** — add / disable accounts and the proxy picks it up in <100 ms (no daemon restart, no connection drops)
- 🛡️ **Defence-in-depth** — three-network Docker isolation, no engine-fingerprint headers (`Server`/`X-Powered-By` stripped), DoH for the proxy's own DNS, no per-connection logs on disk
- 🩺 **Operator surface** — built-in component drift detector, self-probe canary, 11-point readiness checklist, structured panel logs grep-able by event type
- 🌏 **China-bound runbook** — DoH default flip, active-probing detector, self-probe canary all documented in [`docs/going-to-china.md`](./docs/going-to-china.md)
- 📦 **One-command install** — `./scripts/install.sh` walks you through 8 numbered steps with actionable hints if anything fails

---

## What you need before you start

- A small **Linux VPS** — Debian 11/12/13 recommended. **1 vCPU, 1 GB RAM is enough for a few users**, any cloud provider works.
  > **On a 1 GB box?** Add a 2 GB swapfile and set `CT_CORE_BUILD_PROFILE=release-small` in `.env` before running `install.sh` — the Rust core's release build peaks at ~1.5–2 GB RAM and will OOM-kill the compiler otherwise. Full recipe in [`docs/installation-debian.md`](./docs/installation-debian.md) § "Before first boot — low-memory VPS prep".
- A **domain name** you control (e.g. `proxy.example.com`). A subdomain works. Point its `A` record at the VPS public IP.
- **Ports open** at the cloud-provider firewall: `22` (SSH), `80` (so Let's Encrypt can issue a TLS cert), `443/tcp` (the proxy).
- Basic comfort with the Linux command line: `ssh`, `git`, editing a config file. **No PHP / Rust knowledge needed** — Docker handles it.

---

## Quick start

On a fresh Debian VPS as `root`:

```bash
# 1. Install Docker (skip if already installed via your VPS image).
#    Full apt-key + apt-source recipe + recovery from
#    docker.io / docker-ce conflict is in
#    docs/installation-debian.md § 5.
apt update && apt install -y git curl jq dnsutils apache2-utils \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

# 2. Clone + configure.
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server
cp .env.example .env
$EDITOR .env                     # set DOMAIN, ACME_EMAIL, passwords

# 3. Bootstrap. 8 numbered steps; ↳ try: hints on every failure.
./scripts/install.sh
```

When `install.sh` finishes, your panel is at `https://panel.<your-domain>/admin`. First boot takes 1–3 minutes (Docker images build, Let's Encrypt issues a cert).

If something fails, the script prints exactly what's wrong and the next command to run. Most common gotchas:

- **DNS hasn't propagated** → `dig +short A your-domain.com` should return your VPS IP. Wait 5 minutes if not.
- **Port 80 blocked** → `ufw allow 80/tcp` and check your provider's firewall.
- **Domain points at the wrong IP** → ACME can't validate. Fix DNS first.

For the full step-by-step (DNS, firewall, BBR tuning, SSH hardening), see [`docs/installation-debian.md`](./docs/installation-debian.md).

---

## What's running

| Container | Job |
| --- | --- |
| **`panel`** | Laravel 11 + Filament 3 admin you log into. FrankenPHP + Octane worker mode. Where you add accounts, set quotas, pick the cover website. |
| **`haproxy`** | TCP-mode SNI router on `:443`. Sniffs each TLS ClientHello's SNI without decrypting it, then forwards raw bytes — apex SNI → sing-box (proxy), panel-subdomain SNI → caddy (panel reverse-proxy). |
| **`sing-box`** | The actual proxy. Listens on the container's `:443` (no host port — haproxy fronts it), speaks NaiveProxy. Reads the config the panel renders for it. |
| **`caddy`** | Gets the TLS certificate from Let's Encrypt. Hands it to sing-box via a shared volume. Also reverse-proxies the panel-subdomain on `:8444` → panel's FrankenPHP. |
| **`db`** | MariaDB 11. Stores accounts, settings, traffic counters. |
| **`redis`** | Cache + the bus that pushes "this account was just disabled" messages to sing-box within ~100 ms. |

That's the operator-visible surface. Internal plumbing — the Rust `ct-server-core` binary doing config rendering / clash-API hot-reload / metrics scraping — runs inside the panel container. Architecture deep-dive: [`docs/architecture.md`](./docs/architecture.md).

> **Deploying for use from inside the Great Firewall of China?** Read [`docs/going-to-china.md`](./docs/going-to-china.md) end-to-end before you travel. It covers the DoH-resolver default switch, the self-probe canary, the active-probing detector, and a "when something stops working" runbook tuned for that threat model.

---

## Adding your first proxy user

1. Log into the panel at `https://panel.<your-domain>/admin`.
2. Click **Proxy accounts → New proxy account**.
3. Give it a username (letters, digits, dashes). Save.
4. **The cleartext password is shown once** in a notification — copy it now or you'll have to use the **Regenerate password** action later.
5. In your Cool Tunnel macOS client (or any NaiveProxy client), add a profile:

```
naive+https://<username>:<password>@<your-domain>:443
```

Done. Traffic goes through your server.

---

## Anti-tracking — what the server hides

Out of the box, the proxy is configured to look as much like a normal HTTPS website as possible:

- **TLS 1.3 only**, browser-shaped handshake. The handshake itself doesn't fingerprint the box as a proxy.
- **Cover site** at the apex domain. Anyone hitting `https://your-domain.com/` without authentication sees a normal-looking website (blog / portfolio / consultancy — pick one in the panel). Probes can't tell it's a proxy.
- **Cover-site invariant on every public route**. A probe hitting `/api/v1/subscription/<garbage>` gets the same status, same `Content-Type`, same body, same `ETag` as a probe hitting `/random-cover-path`. Rate-limited requests, expired tokens, unset `APP_KEY`, even uncaught panel exceptions all fall through to the cover site too — there is no failure mode that returns a 4xx/5xx that would identify the host as a proxy. Verified end-to-end on every release.
- **No engine-fingerprint headers**. `Server: Caddy` stripped at both the apex Caddy and the panel's in-process FrankenPHP/Caddy; `X-Powered-By` disabled via PHP `expose_php = Off`. No wire response says "Caddy", "PHP", "FrankenPHP", or "Cool Tunnel".
- **No per-connection logs**. Sing-box logs at `warn` level only — no "alice connected from 1.2.3.4 at 12:34" trail on disk. The panel's Caddy access log skips `/api/v1/subscription/*` entirely so subscription HMAC tokens never persist on disk.
- **DoH for the proxy's own DNS**. Your ISP can't see what you're resolving.
- **Three-network Docker isolation**. The `ct-data` and `ct-clash` internal-only docker networks isolate the database and management plane respectively — a compromised Caddy can't reach the clash-API; a compromised database can't phone home.

You can toggle the panel-side anti-tracking flags in **Server config** in the panel.

---

## Common operations

```bash
# View live logs
docker compose logs -f --tail=20 panel
docker compose logs -f --tail=20 sing-box

# Restart everything
docker compose restart

# Update to the latest release (preserves .env, runs migrations,
# rebuilds containers, hot-reloads sing-box)
git fetch --tags && git checkout main && git pull --ff-only
./scripts/update.sh

# Take a backup (db + .env + Caddy ACME state in one tarball)
./scripts/backup.sh

# Restore a backup onto a fresh box
./scripts/restore.sh backups/cool-tunnel-2026-05-08T05-00-00Z.tar.gz

# Pre-launch readiness gate (11-point checklist, see docs/going-to-china.md)
./scripts/late-night-comeback.sh

# Reset a forgotten admin password (round-25 recovery path)
docker compose exec panel php artisan ct:make-admin --force \
    --email=you@example.com --password=newpassword

# Run the full local CI gate (rust-fmt + clippy + tests, php-syntax,
# composer audit, shellcheck, manifests-jq, SoT parity, supervisord
# invariants drift detector)
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
├── caddy/              Caddyfile template (apex + panel ACME)
├── haproxy/            haproxy.cfg template (SNI router)
├── docker/             Per-service Dockerfiles
├── manifests/          Pinned versions of every component
├── scripts/            install.sh, update.sh, backup.sh, restore.sh, late-night-comeback.sh
├── docs/               Deeper guides — installation, architecture, going-to-china
└── docker-compose.yml  Brings up the whole stack
```

Full file-by-file map: [`STRUCTURE.md`](./STRUCTURE.md).

---

## Things going wrong?

| Symptom | Most likely cause | Fix |
| --- | --- | --- |
| Panel won't load — `connection refused` | Cert hasn't been issued yet | `docker compose logs caddy` — wait until you see "certificate obtained" |
| `cargo build` killed during install on a 1 GB box | OOM during Rust compile (peaks ~1.5–2 GB) | Add a 2 GB swapfile **and** set `CT_CORE_BUILD_PROFILE=release-small` in `.env` — see [`docs/installation-debian.md`](./docs/installation-debian.md) § low-memory prep |
| `docker compose up` fails: `Pool overlaps with other one on this address space` | Your docker daemon already has a network on `172.30.0.0/24` | Override `CT_CLASH_SUBNET` and `CT_CLASH_SINGBOX_IP` in `.env` to a free /24 |
| Panel returns 502 from `/admin` after upgrade | You skipped `./scripts/update.sh` after `git pull` (containers still on old image) | Run `./scripts/update.sh` to rebuild + recreate |
| Client connects but no traffic | Account quota hit, or `expires_at` is past | Check the account in the panel |
| `dial tcp ...:80: connection refused` during ACME | Port 80 closed | Open it at the cloud provider firewall |
| Domain doesn't resolve | DNS hasn't propagated | `dig +short A your-domain.com` should return your VPS IP |
| Forgot the admin password | No web reset (no SMTP shipped) | `docker compose exec panel php artisan ct:make-admin --force --email=... --password=...` |

Full troubleshooting table: [`docs/installation-debian.md` § 10](./docs/installation-debian.md).

---

## Pairs with

- [coo1white/cool-tunnel](https://github.com/coo1white/cool-tunnel) — macOS GUI client. Universal Apple Silicon + Intel `.app`.

The client speaks plain NaiveProxy on the wire, so it'll also work against any other NaiveProxy-protocol server you set up elsewhere.

---

## Releases

Tagged releases live on [the GitHub releases page](https://github.com/coo1white/cool-tunnel-server/releases) with per-version notes. Full per-PR history in [`CHANGELOG.md`](./CHANGELOG.md).

The version increment is fast (0.0.X today) and operator-driven — each release notes the operator-visible behaviour change. `make update` on the VPS is the documented in-place upgrade path between any two versions.

---

## License

**AGPL-3.0-or-later** — (c) 2026 the Cool Tunnel Server contributors. See [LICENSE](./LICENSE) for the full GNU Affero General Public License v3.0 text.

The AGPL is a strict copyleft license. Two implications worth calling out for this specific project shape:

1. **If you modify Cool Tunnel Server and run it as a network service** (which is the only way anyone runs it — it's a proxy server), you must publish your modifications under the same terms and make the source available to your users. This closes the SaaS loophole that GPL-3.0 leaves open.
2. **Distribution OR network use of a modified version triggers the source-availability requirement.** Same trigger as Mastodon, Nextcloud, Pleroma, BookStack — the standard choice for self-hosted services that want to stay open.

Bundled upstream components (Caddy, sing-box, Laravel, Filament, MariaDB, Redis, etc.) ship under their own permissive / GPL licenses — see [NOTICE](./NOTICE) and [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

Read the [Disclaimer](./Disclaimer.md) before deploying.
