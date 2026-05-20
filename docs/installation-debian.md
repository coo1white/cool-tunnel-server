# Debian Installation Guide

Step-by-step setup for Cool Tunnel Server on **Debian 10 (buster), 11
(bullseye), 12 (bookworm), 13 (trixie), and later**.

This guide is for the *operator* — somebody who has just spun up a
fresh VPS, has root, and wants a working proxy with the Filament
admin panel in about 20 minutes. Every command is explicit and
copy-pasteable; per-Debian-version differences are called out
inline.

> **Tested on** Debian 12 minimal cloud images. Steps that diverge
> on 10 / 11 / 13 are flagged with a `🟢` badge under each section.
>
> **Reference:** this guide builds on the original bare Caddy + naive
> deployment shape and adds the panel layer.

---

## Before you start — what you need

| Thing | Detail |
| --- | --- |
| **VPS** | 1 vCPU, 1 GB RAM, 10 GB disk, public IPv4 (and ideally IPv6). 2 GB RAM is more comfortable once the panel + MariaDB + Caddy are all running. |
| **Domain** | A real domain you control. ACME (Let's Encrypt) needs to validate it via HTTP-01 on port 80. Subdomains are fine (e.g. `proxy.example.com`). |
| **DNS records** | `A` (and `AAAA` if you have v6) pointing at the VPS, **TTL 300**, **proxy disabled** (Cloudflare grey cloud, not orange). |
| **Ports open** at the cloud-provider firewall | `22/tcp` (SSH, your IP only is best), `80/tcp` (ACME), `443/tcp`, `443/udp` (HTTP/3 / QUIC). |
| **SSH access** | Key-based, root or a sudoer. The commands below assume you're `root`; prefix with `sudo` otherwise. |

### Quick DNS sanity check

Before *anything else*, confirm DNS resolves to the box you're sitting on:

```bash
# Replace with your domain. Should print the VPS public IP.
dig +short A   proxy.example.com
dig +short AAAA proxy.example.com   # only if you set an AAAA

# And confirm what the box thinks its public IP is:
curl -s4 https://ifconfig.co
curl -s6 https://ifconfig.co        # only if you have v6
```

If `dig` returns nothing or the wrong address, **fix DNS first**.
ACME will fail otherwise and you'll waste rate-limit budget.

---

## 1. System hygiene (all versions)

```bash
# Make sure the system clock is right — TLS handshakes fail if it's
# even a few minutes off. systemd-timesyncd ships on every supported
# Debian; if for some reason it's not enabled, install chrony.
timedatectl set-ntp true
timedatectl                              # verify "System clock synchronized: yes"

# Set a sensible hostname and timezone.
hostnamectl set-hostname ct-server
timedatectl set-timezone UTC

# Pull current package lists and apply security updates.
apt update
apt -y upgrade

# Common tools we'll use throughout this guide.
apt install -y \
    ca-certificates curl gnupg ufw dnsutils \
    htop tmux less rsync \
    unattended-upgrades chrony fail2ban
```

🟢 **Debian 10 (buster) only** — buster is EOL for regular security
updates (LTS ended June 2024). You can still run it, but apply this
extra step to pull security patches from the Debian archive:

```bash
# Replace deb.debian.org/security with archive.debian.org if your
# mirror has dropped buster.
sed -i 's|http://security.debian.org|http://archive.debian.org|g' /etc/apt/sources.list
sed -i 's|http://deb.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list
apt update
```

Even after this, **plan to upgrade**. We won't be issuing patches
specifically for buster much longer.

### Enable unattended security updates

```bash
dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
# Verify:
cat /etc/apt/apt.conf.d/20auto-upgrades
# Should show:
#   APT::Periodic::Update-Package-Lists "1";
#   APT::Periodic::Unattended-Upgrade "1";
```

### Add a small swap file (for 1 GB VPSs)

Composer + Caddy build occasionally peaks above 1 GB. Skip on 2 GB+.

```bash
fallocate -l 1G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 2. Kernel + sysctl tuning

A proxy server is a network workload. Three tweaks pay back hugely:

1. **BBR congestion control** — much smoother than `cubic` on
   high-latency links, which is exactly the case for cross-region
   proxying.
2. **TCP fast open** — shaves an RTT off short-lived connections.
3. **Larger UDP buffers** — HTTP/3 (QUIC) on `:443/udp` wants ~7 MB
   sockets; the Linux defaults are 200 KB and you'll see
   `failed to sufficiently increase receive buffer size` warnings
   in Caddy's logs without this.

🟢 **Per-version note:** BBR is built into every supported Debian
kernel — buster (4.19), bullseye (5.10), bookworm (6.1), trixie (6.x).
No backport needed.

```bash
cat >/etc/sysctl.d/99-cool-tunnel.conf <<'EOF'
# --- Congestion control (BBR) -------------------------------------
# Why BBR: model-based congestion control that probes for available
# bandwidth and minimum RTT. Drop-in win for proxy workloads which
# have long fat pipes between the client's network and the server's
# upstream — cubic gives up too early on transient loss; BBR doesn't.
net.core.default_qdisc            = fq
net.ipv4.tcp_congestion_control   = bbr

# --- TCP fast open (client + server) -------------------------------
net.ipv4.tcp_fastopen             = 3

# --- HTTP/3 (QUIC) buffer headroom --------------------------------
net.core.rmem_max                 = 7500000
net.core.wmem_max                 = 7500000

# --- General throughput knobs ---------------------------------------
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_mtu_probing           = 1
EOF

sysctl --system

# Verify BBR is active:
sysctl net.ipv4.tcp_congestion_control   # should print "bbr"
lsmod | grep bbr                          # should show tcp_bbr
```

If `lsmod | grep bbr` is empty, force-load and persist:

```bash
modprobe tcp_bbr
echo tcp_bbr > /etc/modules-load.d/bbr.conf
```

---

## 3. SSH hardening (recommended, optional)

You'll be administering this box; a leaked SSH password ruins
everything else.

```bash
# Disable password auth and root password login. Make sure your SSH
# *key* is in /root/.ssh/authorized_keys before doing this — if it
# isn't, you're about to lock yourself out.
test -s /root/.ssh/authorized_keys || { echo "STOP: no SSH key installed"; exit 1; }

sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/'  /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config

systemctl restart sshd

# fail2ban already installed above; the default jail.conf protects
# sshd. Confirm:
systemctl enable --now fail2ban
fail2ban-client status sshd
```

### Tighten fail2ban for cool-tunnel-server

The defaults are decent but worth a tighter sshd jail. Drop a config
snippet under `/etc/fail2ban/jail.d/` so it survives package upgrades
(don't edit `jail.conf` directly):

```bash
cat >/etc/fail2ban/jail.d/cool-tunnel.local <<'EOF'
[DEFAULT]
# Ban for 1 hour after 5 failures inside 10 minutes.
findtime = 10m
maxretry = 5
bantime  = 1h

# Whitelist your own management IPs so you don't lock yourself out.
# Replace with your operator's static IP / CIDR. Multiple values are
# space-separated.
ignoreip = 127.0.0.1/8 ::1
# ignoreip = 127.0.0.1/8 ::1 203.0.113.42

# Use the modern nftables backend on Debian 11+. On Debian 10
# (iptables-legacy) change to "iptables-multiport".
banaction = nftables-multiport
banaction_allports = nftables-allports

[sshd]
enabled = true
mode    = aggressive
maxretry = 4

# sing-box access-log jail. Disabled by default because
# cool-tunnel-server does not write proxy access logs (privacy).
# Enable only if YOU explicitly turn on sing-box log output that
# captures auth failures and accept the privacy trade-off.
# [singbox-auth]
# enabled  = false
# port     = http,https
# filter   = singbox-auth
# logpath  = /var/log/sing-box/access.log
# maxretry = 10
# findtime = 5m
# bantime  = 6h
EOF

# Reload to pick up the new jail.
systemctl restart fail2ban

# Verify the SSH jail is active and the new bantime is in effect.
fail2ban-client status sshd
fail2ban-client get sshd bantime         # should show 3600
fail2ban-client banned 2>/dev/null | head -5
```

🟢 **Debian 10 (buster):** `nftables` isn't the default backend.
Switch the two `banaction` lines to `iptables-multiport` and
`iptables-allports` respectively. Everything else is identical.

> **On the Caddy side**, fail2ban's role is small — `probe_resistance`
> already makes brute-force basic_auth attempts indistinguishable
> from "wrong page" 404s, so there's nothing in the (default-disabled)
> access log to ban on. The SSH jail is the real win.

---

## 4. Firewall (UFW)

```bash
ufw allow OpenSSH
ufw allow 80/tcp                    # ACME HTTP-01 + http→https redirect
ufw allow 443/tcp                   # HTTPS — sing-box NaiveProxy CONNECT
ufw allow 443/udp                   # HTTP/3 (QUIC)
ufw --force enable
ufw status verbose
```

🟢 **Debian 10 (buster)** uses `iptables-legacy` by default. UFW
works fine on top of it — no extra steps. **Debian 11+** uses
`nftables`; UFW handles that transparently too. If you've previously
installed `nftables` and have your own table, switch to it instead
of UFW.

🟢 **Cloud-provider firewall:** *also* allow these ports at the
provider level (DigitalOcean Cloud Firewall, AWS Security Group,
Hetzner Cloud Firewall, etc.) — UFW only protects what reaches the
box.

---

## 5. Install Docker Engine + Compose v2

Cool Tunnel Server runs as a Docker Compose stack. Don't use the
distro-packaged `docker.io` — it's almost always too old; use
Docker's own repo.

🟢 **All Debian versions** — same recipe, same repo, Docker handles
the per-codename split automatically.

```bash
# Make the keyring directory.
install -m 0755 -d /etc/apt/keyrings

# Fetch Docker's signing key.
curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repo for *this* Debian codename.
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    | tee /etc/apt/sources.list.d/docker.list >/dev/null

apt update
apt install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

# Confirm.
docker version
docker compose version          # note: 'compose' is a subcommand now,
                                # NOT 'docker-compose' (that's v1, EOL)
```

🟢 **Debian 10 (buster)** — Docker dropped buster from their CI in
2024 but the repo entries still exist. If `apt update` complains
about a missing release, you may need to use `bullseye` packages
instead — Docker binaries are statically built and run fine on
buster:

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian bullseye stable" \
    | tee /etc/apt/sources.list.d/docker.list >/dev/null
apt update && apt install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
```

### Stop conflicting web servers (if any)

ACME needs port 80 free.

```bash
systemctl stop nginx apache2 caddy 2>/dev/null || true
systemctl disable nginx apache2 caddy 2>/dev/null || true

# Confirm nothing is on 80 or 443.
ss -ltnup | grep -E ':80\b|:443\b' || echo "ports clear"
```

---

## 6. Pull and configure Cool Tunnel Server

```bash
# A neutral install location. /opt is conventional for site-local
# stacks; pick anything you like.
mkdir -p /opt && cd /opt
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server

# Copy the env template.
cp .env.example .env

# Generate strong random values for every secret. Three calls because
# we need three independent passwords (DB_ROOT_PASSWORD, DB_PASSWORD,
# REDIS_PASSWORD); APP_KEY is generated automatically by artisan.
DB_ROOT=$(openssl rand -base64 32 | tr -d '\n')
DB_PASS=$(openssl rand -base64 32 | tr -d '\n')
REDIS_PASS=$(openssl rand -base64 32 | tr -d '\n')

# Edit DOMAIN, ACME_EMAIL, and the *_PASSWORD lines. Pick any editor.
sed -i "s|^DOMAIN=.*|DOMAIN=proxy.example.com|"                .env
sed -i "s|^PANEL_DOMAIN=.*|PANEL_DOMAIN=panel.proxy.example.com|" .env
sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=admin@example.com|"        .env
sed -i "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=${DB_ROOT}|"    .env
sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASS}|"              .env
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|"     .env
```

> The admin panel is served at `https://${PANEL_DOMAIN}/admin`.
> Use a dedicated panel hostname such as `panel.proxy.example.com`;
> Caddy routes that SNI to the panel and forwards other SNI traffic
> to sing-box.

---

## ⚠️ Before first boot — low-memory VPS prep (1 vCPU / 1 GB)

The minimum spec — **1 vCPU, 1 GB RAM** — is enough to *run* the
stack (idle ≈ 240 MiB, moderate load ≈ 400-500 MiB) but tight for
the *initial build* of `ct-server-core` (the Rust core peaks at
~1.5-2 GB during `cargo build --release` with full LTO). Without
the prep below, `install.sh` will OOM-kill the compiler partway
through and you'll see one of:

- `signal: 9, SIGKILL: kill` from cargo
- `error: linking with cc failed` after a long pause
- the compose build process simply vanishing

If your VPS has **≥ 2 GB RAM**, skip this section and go straight
to step 7. Everything below is a no-op overhead on a bigger box.

### a. Add a 2 GB swapfile

Cloud images often ship without swap. The build briefly needs more
RAM than the box has; swap is the safety net.

```bash
# Skip if `swapon --show` already lists ≥2 GB.
swapon --show

# Create a 2 GB swapfile (faster than dd, works on ext4 / xfs).
fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
chmod 0600 /swapfile
mkswap /swapfile
swapon /swapfile

# Persist across reboot.
grep -q '^/swapfile ' /etc/fstab \
  || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Be conservative about reaching for swap. 10 = "only when there's
# real memory pressure". Default vm.swappiness=60 starts swapping
# too eagerly for a single-purpose box.
sysctl -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.d/99-cool-tunnel.conf \
  || echo 'vm.swappiness=10' >> /etc/sysctl.d/99-cool-tunnel.conf

swapon --show
free -h
```

### b. Pick the low-memory build profile

`core/Cargo.toml` ships two release profiles:

| Profile | Peak compile RAM | Build time | Runtime cost |
| --- | --- | --- | --- |
| `release` (default) | ~1.5-2 GB | ~6-8 min | baseline |
| `release-small` | ~0.6-0.9 GB | ~1-2 min | ~5-15 % slower CPU paths |

The runtime cost is invisible in practice — the panel is request /
response over a network and DB, not CPU-bound. Switch in `.env`:

```bash
# Edit .env and append (or change the existing line):
echo 'CT_CORE_BUILD_PROFILE=release-small' >> .env
```

`install.sh` reads `CT_CORE_BUILD_PROFILE` and passes it through to
`docker compose build` as `--build-arg CARGO_PROFILE=…`. Do this
**before** step 7.

### c. Confirm the runtime tuning knobs (already low-mem-friendly by default)

The shipped defaults are already sized for a 1 GB box.
FrankenPHP's worker pool size is configured in
`docker/panel/Caddyfile` via the `frankenphp { worker { num 4 } }`
block — NOT via env. To grow the pool: edit the `num` value in
that file and rebuild the panel image (`docker compose build
panel && docker compose up -d --force-recreate panel`). Default
`num 4` matches the prior PHP-FPM `pm.max_children` cap and
keeps steady-state ~250 MiB inside the panel container's 320 MiB
mem_limit. Raising past 4 should usually be paired with a
mem_limit raise in `docker-compose.yml`.

(Pre-FrankenPHP-runtime-swap this section documented
`PHP_FPM_*` env vars, then briefly `OCTANE_*` env vars during
the swap iterations. Both code paths were dropped — see
`CHANGELOG.md` for context. The Caddyfile `num` literal is the
single source of truth today.)

The MariaDB tuning lives in `docker-compose.yml` (`db.command:`
flags: `innodb-buffer-pool-size=64M`, `performance-schema=OFF`,
`max-connections=20`, etc.). Operators with ≥2 GB RAM can override
in a `docker-compose.override.yml`:

```yaml
# docker-compose.override.yml — committed only on bigger boxes.
services:
  db:
    command:
      - --innodb-buffer-pool-size=256M
      - --max-connections=50
      - --performance-schema=ON
```

### d. Watch for OOM during build (sanity)

In a second SSH session while `install.sh` is running, tail
`dmesg` for `Out of memory` events. None should appear with the
swap + `release-small` combo above:

```bash
dmesg -wT | grep -E 'Out of memory|invoked oom-killer|Killed process'
```

If you do see one, the build was killed before completion. Either
your swapfile didn't activate (`swapon --show` should list it) or
your `.env` didn't pick up `CT_CORE_BUILD_PROFILE=release-small`
(check with `docker compose --profile build-only config | grep
CARGO_PROFILE`).

### e. Steady-state expectation

After install completes, `docker stats --no-stream` should show
something like:

```
ct-db        ~ 95-100 MiB    (mariadb, performance_schema OFF)
ct-panel     ~220-280 MiB    (frankenphp parent + 4 PHP workers
                             + ct-server-core daemon + queue:work +
                             scheduler; each PHP worker holds a
                             Laravel + Filament boot resident
                             across requests, ~30-50 MiB each)
ct-singbox   ~ 10-15 MiB
ct-caddy     ~ 15-20 MiB
ct-haproxy   ~  5-10 MiB
ct-redis     ~  9-12 MiB
                    ─────
TOTAL        ~ 350-400 MiB  → ~600 MiB free on a 1 GB box
```

Under moderate load (10-20 active proxy users + admin browsing in
a tab) the panel container sits around 250-300 MiB (4 long-lived
PHP workers + queue + scheduler + ct-core daemon, each worker
holding the Filament boot in memory); total stack peaks around
400-500 MiB. The `R-panel-1` queue refactor caps growth from
bulk-delete admin actions at ~600 MiB.

---

## 7. First boot

```bash
./scripts/install.sh
```

`install.sh` does, in order:

1. `docker compose build` — sing-box (binary download),
   panel + Composer install.
2. `docker compose up -d db redis` — bring up the data layer first.
3. Wait for MariaDB healthcheck to go green.
4. `docker compose up -d panel` — runs the entrypoint, which does
   `composer install`, `key:generate`, `migrate`, and renders the
   initial `sing-box config.json`.
5. Prompts you for a first Filament admin user (email + password).
6. `docker compose up -d caddy singbox` — Caddy gets the panel cert
   and routes non-panel SNI to sing-box.
7. Tails Caddy and sing-box logs until the panel cert is available
   and sing-box is running.

When it finishes, open:

```text
https://${PANEL_DOMAIN}/admin
```

Filament's login page asks for the admin user you created in step 5.

### Check the certificate landed

```bash
echo | openssl s_client -servername proxy.example.com \
    -connect proxy.example.com:443 2>/dev/null \
    | openssl x509 -noout -issuer -subject -dates
```

You want `issuer=… Let's Encrypt`. If you see a self-signed cert,
ACME hasn't completed yet — `docker logs ct-singbox` will tell you why
(usually port 80 not reachable, or DNS not yet propagated).

---

## 8. Create your first proxy account

In the Filament panel: **Proxy Accounts → New**.

- **Username** — any ASCII you like (`alice`).
- **Password** — leave blank to auto-generate; the cleartext is
  shown **once** at the top of the next page. Copy it; the panel
  only stores the bcrypt hash.
- **Quota** — bytes/month, blank = unlimited.
- **Expires at** — datetime, blank = never.

When you save, the panel:

1. Writes the bcrypt hash AND a Laravel-Crypt-encrypted cleartext to
   `proxy_accounts`.
2. Publishes a `cool_tunnel:revocations` Redis message.
3. The ct-server-core daemon (subscribed) re-renders the sing-box
   `config.json` and PUTs `/configs?force=true&path=…` to sing-box's
   clash-API unix socket — zero-downtime reload.

Verify from another machine:

```bash
curl -v --proxy "https://alice:<password>@proxy.example.com:443" \
    https://ipinfo.io
```

Expected: `ipinfo.io` shows the **server's** IP (not yours).

### Point the macOS client at it

Open Cool Tunnel, *+* a profile:

```
naive+https://alice:<password>@proxy.example.com:443
```

Pick *Smart* mode. Click **Start**. Done.

---

## 9. Day-2 ops

### Update to a new release

```bash
cd /opt/cool-tunnel-server
./ct update
```

`update.sh` does `git pull`, `docker compose build --pull`, runs new
migrations, re-renders the sing-box config, and `docker compose up -d`.

### Back up

```bash
./ct backup
# → backups/cool-tunnel-YYYY-MM-DD.tar.gz   (mode 0600 — operator-only)
#   contains: .env (APP_KEY + DB / Redis secrets), db dump
#             (--single-transaction), caddy_data.tgz (ACME certs +
#             private keys), manifests/, and deployment templates
```

The tarball mode is `0600` — the contents are operator-secret
(APP_KEY decrypts every cleartext password in the DB dump). Move
it off the VPS to a private storage bucket / encrypted disk
ASAP.

### Restore

```bash
./ct restore backups/cool-tunnel-YYYY-MM-DDTHH-MM-SSZ.tar.gz
```

Documented disaster-recovery procedure (works on a fresh VPS):

1. Provision the new VPS (1 vCPU / 1 GB minimum, same region or
   the closest one to your users).
2. Install Docker + clone the repo:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/coo1white/cool-tunnel-server.git
   cd cool-tunnel-server
   ```
3. Copy the backup tarball into `backups/`.
4. **Repoint DNS** — update both `${DOMAIN}` and `${PANEL_DOMAIN}`
   A records to the new VPS IP. Wait for propagation
   (`dig +short ${DOMAIN}` matches the new IP).
5. `./ct restore backups/cool-tunnel-YYYY-MM-DDTHH-MM-SSZ.tar.gz`
6. Verify: `./ct doctor` has no FAIL rows, `make readiness` passes,
   and `curl -ksI https://${PANEL_DOMAIN}/admin` returns 200/302.

The restored `.env` brings APP_KEY + DB + Redis + clash secrets
across, so every existing proxy account's encrypted cleartext
password decrypts correctly. The restored `caddy_data` brings
the existing Let's Encrypt certs across, avoiding LE rate-limit
budget on re-issue (5 duplicate certs per 7 days).

### Tail logs

```bash
docker compose logs -f --tail=200 sing-box   # ACME + proxy access
docker compose logs -f --tail=200 panel   # Laravel + queue worker
docker compose logs -f --tail=200 db
```

### Rotate a leaked password

Filament panel → ProxyAccounts → click the user → **Regenerate
password**. New cleartext shown once; old credential stops working
within ~100 ms (Redis pub/sub → sing-box reload).

### Renew TLS

Caddy is the ACME side; it renews automatically and writes the
fresh cert + key to the `caddy_data` volume. The cert mtime is
folded into the sing-box render-change hash, so the next
`singbox:render --if-changed` (scheduled every five minutes)
picks the new material up automatically — no manual reload step.

To force a renewal cycle, restart Caddy (it re-checks on boot):

```bash
docker compose restart caddy
```

---

## 10. Common gotchas, by symptom

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `dial tcp ...:80: connection refused` during ACME | Port 80 not open at cloud firewall, or another web server running | Check `ss -ltnp | grep :80`; open port at provider firewall |
| `unable to verify the first certificate` from `curl` | ACME hasn't completed yet (self-signed in use) | `docker logs ct-singbox` and wait |
| `SSL_ERROR_SYSCALL` from the macOS client | sing-box up but config did not load | `docker compose logs --tail=120 singbox`; `docker compose exec -T singbox sing-box check -c /data/config/singbox.json` |
| Connections work but feel slow | BBR not active | `sysctl net.ipv4.tcp_congestion_control` should be `bbr` |
| QUIC (`Alt-Svc h3`) not advertised | UDP/443 blocked or buffer too small | Open UDP/443 at provider; verify `sysctl net.core.rmem_max` ≥ 7500000 |
| Browser shows your fake site instead of proxying | Client misconfigured, subscription stale, or UUID wrong | Re-import the subscription URL and run `./ct doctor` |
| `ERR_QUIC_PROTOCOL_ERROR` from clients on some networks | Some Chinese ISPs throttle UDP/443 | Tell client to disable QUIC; clients fall back to HTTP/2 transparently |
| Cloudflare orange cloud + ACME failing | Cloudflare proxy mangles ACME and re-encrypts traffic | Set the DNS record to **DNS-only** (grey cloud) |
| Time-related TLS errors | Clock drift | `timedatectl` should say "synchronized: yes" |

---

## 11. Things to consider beyond this guide

- **Domain hygiene.** Don't use a freshly-registered domain on a
  cheap TLD (`.xyz`, `.top`, etc.) for a long-lived proxy — those
  TLDs see disproportionate abuse and end up on collective
  blocklists. A 1+ year old domain on a "boring" TLD (`.com`,
  `.net`, `.org`) is far less fingerprintable.
- **Cover-site choice matters.** The fake site sing-box serves via
  fallback at the apex is what unauthenticated probes see. Pick (or
  generate, in the panel) a cover that *fits the domain* — a `.tech`
  site shouldn't render a coffee-shop landing page.
- **Don't reuse credentials.** One proxy account per real human.
  If a credential leaks, you can rotate just that one without
  disturbing anyone else.
- **Don't share the panel password.** The Filament admin sees every
  user's bcrypt hash, every traffic log, every regen-password
  click. Treat it like root.
- **Two boxes are better than one.** Run a second instance on a
  different cloud / different region as a hot-spare. The macOS
  client supports profile switching.
- **Run the health gates** every release. `./ct doctor`,
  `make readiness`, and `php artisan credential-lock:check` catch
  most deployment drift before users do.
- **Use `./ct backup`** — it captures `caddy_data` (ACME
  certs + private keys; ACME moved from sing-box to Caddy in
  v0.0.4) plus the DB dump, the three render-input templates,
  manifests/, and `.env`. Run weekly to a private storage bucket;
  store with the same security posture as your DB password.
  Without `caddy_data`, every `docker compose down -v` resets
  your cert and burns LE rate-limit budget (5 duplicate-cert
  issuances per 7-day window).
- **Public IPv6** — if your VPS has v6, set the `AAAA` record. Some
  censorship systems are weaker over v6, and clients pick up the
  faster path automatically (Happy Eyeballs).
- **Protect the panel hostname.** Use a dedicated `PANEL_DOMAIN`,
  keep admin passwords unique, and leave Cloudflare proxying off for
  the panel/proxy records so ACME and Reality routing stay predictable.

---

## Per-version cheat sheet

| Step | Debian 10 (buster) | Debian 11 (bullseye) | Debian 12 (bookworm) | Debian 13 (trixie) |
| --- | --- | --- | --- | --- |
| Apt sources for security | `archive.debian.org` (LTS off) | `security.debian.org/debian-security bullseye-security main` | `security.debian.org/debian-security bookworm-security main` | `security.debian.org/debian-security trixie-security main` |
| Default kernel | 4.19 | 5.10 | 6.1 | 6.x |
| BBR module | built-in | built-in | built-in | built-in |
| NFTables default | no (iptables-legacy) | yes | yes | yes |
| Docker repo codename | use `bullseye` packages | `bullseye` | `bookworm` | `trixie` (or `bookworm` while trixie ships) |
| Compose v2 plugin pkg | `docker-compose-plugin` | `docker-compose-plugin` | `docker-compose-plugin` | `docker-compose-plugin` |
| systemd-resolved enabled by default | no | no | no | no |

---

## What this guide does *not* cover

- **Notarised domains / EV certs.** Let's Encrypt DV is fine; you do
  not need a paid CA.
- **TLS pinning.** NaiveProxy clients use the system trust store; no
  pinning needed on either end.
- **Multi-tenant separation.** Every proxy account in this guide
  lives in the same Caddy process. If you want isolation between
  customers, run multiple stacks on different VPSs and federate the
  panel — out of scope for v0.0.1.
- **CDN fronting.** You can put Caddy behind a CDN that supports
  HTTP/2 CONNECT (rare), but most won't work — just point DNS
  straight at the box.
