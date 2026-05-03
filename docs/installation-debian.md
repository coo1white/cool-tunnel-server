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
> **Reference:** the author's earlier walk-through at
> [blog.coolwhite.space/?page_id=59](https://blog.coolwhite.space/?page_id=59)
> covers the original bare Caddy + naive recipe; this guide builds
> on it and adds the panel layer.

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
sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=admin@example.com|"        .env
sed -i "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=${DB_ROOT}|"    .env
sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASS}|"              .env
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|"     .env

# Generate the bcrypt hash for edge-level basic auth on /admin.
# Pick a strong password — this is what you'll type in front of the
# Filament login page (a second factor before the Filament password).
read -r -s -p "Admin edge password: " ADMIN_PW; echo
# bcrypt-hash the admin password. Any tool works; we use httpd's
# htpasswd helper here because it's tiny and ubiquitous.
apt install -y apache2-utils
ADMIN_HASH=$(htpasswd -nbB admin "$ADMIN_PW" | cut -d: -f2-)
sed -i "s|^PANEL_BASIC_AUTH_HASH=.*|PANEL_BASIC_AUTH_HASH='${ADMIN_HASH}'|" .env
unset ADMIN_PW
```

> **Why two passwords for the admin panel?** Filament auth lives
> behind another layer (the edge `basic_auth` block in sing-box's
> fallback) so the Filament login page is never directly probable.
> Use two different passwords; the edge layer is what stops drive-by
> scanners from even seeing the Laravel login form.

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
6. `docker compose up -d sing-box` — ACME kicks in, certs land in
   `singbox_data` volume.
7. Tails sing-box logs until it prints `certificate obtained` (or
   the equivalent ACME success line) for your domain.

When it finishes, browse to:

```
https://<your-domain>/admin
```

The browser will challenge you for the **edge** basic auth first
(the username + password you set in `PANEL_BASIC_AUTH_*`), then
Filament's own login page asks for the admin you created in step 5.

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
./scripts/update.sh
```

`update.sh` does `git pull`, `docker compose build --pull`, runs new
migrations, re-renders the sing-box config, and `docker compose up -d`.

### Back up

```bash
./scripts/backup.sh
# → backups/cool-tunnel-YYYY-MM-DD.tar.gz
#   contains: .env, db dump, singbox_data (certs), singbox_etc (config.json)
```

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

sing-box's built-in ACME renews automatically. To force a renewal,
either bump the renewal threshold in `sing-box/config.json.tpl` and
re-render, or restart the container (it will re-check on boot):

```bash
docker compose restart sing-box
```

---

## 10. Common gotchas, by symptom

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `dial tcp ...:80: connection refused` during ACME | Port 80 not open at cloud firewall, or another web server running | Check `ss -ltnp | grep :80`; open port at provider firewall |
| `unable to verify the first certificate` from `curl` | ACME hasn't completed yet (self-signed in use) | `docker logs ct-singbox` and wait |
| `SSL_ERROR_SYSCALL` from the macOS client | sing-box up but config didn't load — check `docker logs ct-singbox` for the last clash-API reload | `docker exec ct-singbox sing-box check -c /etc/sing-box/config.json` |
| Connections work but feel slow | BBR not active | `sysctl net.ipv4.tcp_congestion_control` should be `bbr` |
| QUIC (`Alt-Svc h3`) not advertised | UDP/443 blocked or buffer too small | Open UDP/443 at provider; verify `sysctl net.core.rmem_max` ≥ 7500000 |
| Browser shows your fake site instead of proxying | Client misconfigured (using HTTP instead of CONNECT), or password wrong | Re-check `naive+https://...` URL on the client |
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
- **Audit `ct-server-core component check`** every release. If the
  panel build ever produces a sing-box image that's missing the
  `naive` inbound (e.g. someone swapped to a build without it),
  the proxy will silently degrade to "just an ACME endpoint" and
  client connections will fail. The OK/NG check is the canary.
- **Backup the `singbox_data` volume**, not just the DB. ACME state
  lives there; without it, every `docker compose down -v` resets
  your cert and burns LE rate-limit budget.
- **Public IPv6** — if your VPS has v6, set the `AAAA` record. Some
  censorship systems are weaker over v6, and clients pick up the
  faster path automatically (Happy Eyeballs).
- **Don't run the panel publicly without the edge basic_auth.** The
  Filament login is bcrypt-hashed and rate-limited, but a bare login
  page is still a fingerprint. The two-layer setup hides it from
  drive-by scanners.

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
