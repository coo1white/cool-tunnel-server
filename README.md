# Cool Tunnel Server

> **Heads-up.** This is a tool for circumventing online censorship.
> Read the [Disclaimer](./Disclaimer.md) before deploying.

A self-hosted proxy server you can run on a cheap Linux VPS. It's the
backend for the [Cool Tunnel macOS client][client] — once you've set
this up, your client connects to your server, and your traffic looks
like normal HTTPS browsing to anyone watching the network.

You manage it through a web admin panel: add user accounts, set
quotas, swap the "fake website" your domain shows to scanners, see
who's connected.

[client]: https://github.com/coo1white/cool-tunnel

---

## What you need before you start

- A small **Linux VPS** — Debian 11/12/13 recommended. 1 vCPU, 1 GB
  RAM is enough for a few users. Any cloud provider works.
  > **On a 1 GB box?** Add a 2 GB swapfile and set
  > `CT_CORE_BUILD_PROFILE=release-small` in `.env` before running
  > `install.sh` — the Rust core's release build peaks at ~1.5–2 GB
  > RAM and will OOM-kill the compiler otherwise. Full recipe in
  > [`docs/installation-debian.md`](./docs/installation-debian.md)
  > § "Before first boot — low-memory VPS prep".
- A **domain name** you control (e.g. `proxy.example.com`). A
  subdomain is fine. Point its `A` record at the VPS public IP.
- **Ports open** at the cloud-provider firewall: `22` (SSH),
  `80` (so Let's Encrypt can issue a TLS cert), `443/tcp` (the proxy).
- Basic comfort with the Linux command line: `ssh`, `git`, editing a
  config file. No PHP / Rust knowledge needed — Docker handles it.

---

## Quick start

```bash
# 1. SSH into your fresh Debian VPS as root. Install Docker, git,
#    and the small CLI tools install.sh's pre-flight checks for.
#    `apache2-utils` is where Debian ships `htpasswd` — there's no
#    standalone htpasswd package.
apt update && apt install -y \
    git curl jq dnsutils apache2-utils \
    docker.io docker-compose-plugin

# 2. Clone this repo.
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server

# 3. Copy the example env file and edit DOMAIN + ACME_EMAIL.
cp .env.example .env
nano .env                 # change `proxy.example.com` to your domain;
                          # change `admin@example.com` to your email.

# 4. Run the bootstrap. Walks you through 8 numbered steps with
# helpful "↳ try:" hints if anything fails.
./scripts/install.sh
```

When `install.sh` finishes, your panel is at `https://<your-domain>/admin`.
First boot takes 1–3 minutes (Docker images build, Let's Encrypt
issues a cert).

If something fails, the script tells you exactly what's wrong and how
to fix it. The most common gotchas:

- DNS hasn't propagated yet → `dig +short A your-domain.com` should
  return your VPS IP. Wait 5 minutes if not.
- Port 80 blocked → `ufw allow 80/tcp` and check your provider's
  firewall.
- Domain points at the wrong IP → ACME can't validate. Fix DNS first.

For the full step-by-step (DNS, firewall, BBR tuning, SSH hardening),
see [`docs/installation-debian.md`](./docs/installation-debian.md).

---

## What's running

| Container | Job |
| --- | --- |
| **`panel`** | Laravel + Filament admin you log into. Where you add accounts, set quotas, pick the cover website. |
| **`sing-box`** | The actual proxy. Listens on `:443`, speaks NaiveProxy. Reads the config the panel renders for it. |
| **`caddy`** | Gets the TLS certificate from Let's Encrypt. Hands it to sing-box via a shared volume. |
| **`db`** | MariaDB. Stores accounts, settings, traffic counters. |
| **`redis`** | Cache + the bus that pushes "this account was just disabled" messages to sing-box within ~100 ms. |

That's it. Everything else (the Rust core, the config rendering, the
clash-API reload) is internal plumbing you don't need to understand
to operate the server.

If you want the architecture deep-dive, see
[`docs/architecture.md`](./docs/architecture.md).

---

## Adding your first proxy user

1. Log into the panel at `https://<your-domain>/admin`.
2. Click **Proxy accounts → New proxy account**.
3. Give it a username (letters, digits, dashes). Save.
4. **The cleartext password is shown once** in a notification — copy
   it now or you'll have to regenerate.
5. In your Cool Tunnel macOS client, add a profile:

```
naive+https://<username>:<password>@<your-domain>:443
```

Done. Traffic goes through your server.

---

## Anti-tracking — what the server hides

Out of the box, the proxy is configured to look as much like a
normal HTTPS website as possible:

- **TLS 1.3 only**, browser-shaped handshake. The handshake itself
  doesn't fingerprint the box as a proxy.
- **Cover site** at the apex domain. Anyone who visits
  `https://your-domain.com/` without authentication sees a normal-
  looking website (blog / portfolio / consultancy — pick one in the
  panel). Probes can't tell it's a proxy.
- **Cover-site invariant on every public route** (v0.0.14). A probe
  hitting `/api/v1/subscription/<garbage>` gets the same status,
  same `Content-Type`, same body, same `ETag` as a probe hitting
  `/random-cover-path`. Rate-limited requests, expired tokens,
  unset `APP_KEY`, and uncaught panel exceptions all fall through
  to the cover site too — there is no failure mode that returns a
  4xx/5xx that would identify the host as a proxy. Verified
  end-to-end on every release.
- **No engine-fingerprint headers**. `Server: Caddy` stripped on
  Caddy's `:80` redirect; `X-Powered-By` disabled via PHP
  `expose_php = Off`; nginx `server_tokens off`. None of the wire
  responses say "Caddy", "PHP", "nginx", or "Cool Tunnel".
- **No per-connection logs**. Sing-box logs at `warn` level only, so
  there's no "alice connected from 1.2.3.4 at 12:34" trail on disk.
  Subscription HMAC tokens are masked in the panel's nginx access
  log so they don't persist on disk.
- **DNS over HTTPS** for the proxy's own DNS lookups. Your ISP
  can't see what you're resolving.
- **Three-network docker isolation**. The `ct-data` and `ct-clash`
  internal-only docker networks isolate the database and
  management plane respectively — a compromised Caddy can't reach
  the clash-API; a compromised database can't phone home.

You can toggle the panel-side anti-tracking flags in **Server
config** in the panel.

---

## Common operations

```bash
# View live logs
docker compose logs -f --tail=20 panel
docker compose logs -f --tail=20 sing-box

# Restart everything
docker compose restart

# Pull a new release of the server code
git fetch --tags && git checkout v0.0.20
docker compose build && docker compose up -d

# Take a backup (db + Caddy ACME state)
./scripts/backup.sh

# Restore a backup onto a fresh box (companion to backup.sh)
./scripts/restore.sh backups/cool-tunnel-2026-05-05T10-00-00Z.tar.gz

# Pre-launch readiness gate (11-point checklist)
./scripts/late-night-comeback.sh
```

---

## Where everything lives in this repo

```
cool-tunnel-server/
├── panel/              Laravel + Filament admin (PHP)
├── core/               Rust workspace
│   ├── ct-protocol/    Shared types future iOS / Android / etc. clients pull in
│   └── ct-server-core/ Server-only binary the panel shells out to
├── sing-box/           sing-box config template
├── caddy/              Caddyfile template
├── docker/             Dockerfiles for each container
├── manifests/          Pinned versions of every component (sing-box, Rust crates, etc.)
├── scripts/            install.sh, backup.sh, update.sh, late-night-comeback.sh
├── docs/               Deeper guides — installation, architecture, components
└── docker-compose.yml  Brings up the whole stack
```

For the full file-by-file map, see [`STRUCTURE.md`](./STRUCTURE.md).

---

## Things going wrong?

| Symptom | Most likely cause | Fix |
| --- | --- | --- |
| Panel won't load — `connection refused` | Cert hasn't been issued yet | `docker compose logs caddy` — wait until you see "certificate obtained" |
| Panel loads but **save does nothing** | You're on v0.0.4–v0.0.9 (broken save flow) | Upgrade to v0.0.14 or later |
| `cargo build` killed during install on a 1 GB box | OOM during Rust compile (peaks ~1.5–2 GB) | Add a 2 GB swapfile **and** set `CT_CORE_BUILD_PROFILE=release-small` in `.env` — see [`docs/installation-debian.md`](./docs/installation-debian.md) § low-memory prep |
| `docker compose up` fails: `Pool overlaps with other one on this address space` | Your docker daemon already has a network on `172.30.0.0/24` | Override `CT_CLASH_SUBNET` and `CT_CLASH_SINGBOX_IP` in `.env` to a free /24 (v0.0.14+) |
| Client connects but no traffic | Account quota hit, or expires_at is past | Check the account in the panel |
| `dial tcp ...:80: connection refused` during ACME | Port 80 closed | Open it at the cloud provider firewall |
| Domain doesn't resolve | DNS hasn't propagated | `dig +short A your-domain.com` should return your VPS IP |

Full troubleshooting table:
[`docs/installation-debian.md` § 10](./docs/installation-debian.md).

---

## Pairs with

- [coo1white/cool-tunnel](https://github.com/coo1white/cool-tunnel) —
  macOS GUI client. Universal Apple Silicon + Intel `.app`.

The client speaks plain NaiveProxy on the wire, so it'll also work
against any other NaiveProxy-protocol server you set up elsewhere.

---

## License

Proprietary — (c) 2026 the Cool Tunnel Server contributors. All Rights Reserved. See
[LICENSE](./LICENSE).

Bundled upstream components (Caddy, sing-box, Laravel, Filament,
MariaDB, Redis, etc.) ship under their own permissive / GPL licenses
— see [NOTICE](./NOTICE) and
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

Read the [Disclaimer](./Disclaimer.md) before deploying.
