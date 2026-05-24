# Debian VPS Installation Guide for Cool Tunnel Server

Step-by-step setup for Cool Tunnel Server on **Debian 12 (bookworm) and
newer**. This guide turns a
fresh Debian VPS into a self-hosted proxy server with Docker Compose,
Caddy, sing-box, VLESS + Reality, MariaDB, Redis, and the web admin
panel.

This guide is for the *operator* — somebody who has just spun up a
fresh VPS, has root, and wants a working proxy with the Filament
admin panel in about 20 minutes. Every command is explicit and
copy-pasteable; per-Debian-version differences are called out
inline.

> **Tested on** Debian 12 minimal cloud images. Debian 12+ is the
> supported path for release installs.
>
> **Reference:** this guide builds on the original bare Caddy
> deployment shape and adds the panel plus sing-box VLESS+Reality.

---

## Before you start — what you need

| Thing | Detail |
| --- | --- |
| **VPS** | 1 vCPU, 1 GB RAM, 10 GB disk, public IPv4. 2 GB RAM is more comfortable once the panel + MariaDB + Caddy are all running. |
| **Domain** | A real domain you control. ACME (Let's Encrypt) needs to validate it via HTTP-01 on port 80. Subdomains are fine (e.g. `proxy.example.com`). |
| **DNS records** | `A` pointing at the VPS public IPv4, **TTL 300**, **proxy disabled** (Cloudflare grey cloud, not orange). |
| **Ports open** at the cloud-provider firewall | `22/tcp` (SSH, your IP only is best), `80/tcp` (ACME), `443/tcp`, `443/udp` (HTTP/3 / QUIC). |
| **SSH access** | Key-based, root or a sudoer. The commands below assume you're `root`; prefix with `sudo` otherwise. |

### Quick DNS sanity check

Before *anything else*, confirm DNS resolves to the box you're sitting on:

```bash
# Replace with your domain. Should print the VPS public IP.
dig +short A   proxy.example.com

# And confirm what the box thinks its public IP is:
curl -s4 https://ifconfig.co
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
    ca-certificates curl git gnupg jq openssl apache2-utils ufw dnsutils \
    htop tmux less rsync \
    unattended-upgrades chrony fail2ban
```

### Enable unattended security updates

```bash
dpkg-reconfigure -plow unattended-upgrades
# Verify:
cat /etc/apt/apt.conf.d/20auto-upgrades
# Should show:
#   APT::Periodic::Update-Package-Lists "1";
#   APT::Periodic::Unattended-Upgrade "1";
```

### Add a small swap file (for 1 GB VPSs)

The release install path does not build images on the VPS, but a small
swap file still gives 1 GB servers breathing room during package
updates and Docker image loading. Skip on 2 GB+.

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

BBR is built into supported Debian 12+ kernels. No backport is needed.

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
ignoreip = 127.0.0.1/8
# ignoreip = 127.0.0.1/8 203.0.113.42

# Use the modern nftables backend.
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

> **On the Caddy side**, fail2ban's role is small — `probe_resistance`
> already makes brute-force basic_auth attempts indistinguishable
> from "wrong page" 404s, so there's nothing in the (default-disabled)
> access log to ban on. The SSH jail is the real win.

---

## 4. Firewall (UFW)

```bash
ufw allow OpenSSH
ufw allow 80/tcp                    # ACME HTTP-01 + http→https redirect
ufw allow 443/tcp                   # HTTPS — sing-box VLESS+Reality
ufw --force enable
ufw status verbose
```

Debian 12+ uses `nftables`; UFW handles that transparently. If you've
previously installed `nftables` and have your own table, switch to it
instead of UFW.

🟢 **Cloud-provider firewall:** *also* allow these ports at the
provider level (DigitalOcean Cloud Firewall, AWS Security Group,
Hetzner Cloud Firewall, etc.) — UFW only protects what reaches the
box.

---

## 5. Install Docker Engine + Compose v2

Cool Tunnel Server runs as a Docker Compose stack. Don't use the
distro-packaged `docker.io` — it's almost always too old; use
Docker's own repo.

🟢 **Supported Debian 12+ versions** — same recipe, same repo, Docker
handles the per-codename split automatically.

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
# Install the latest official release into /opt/cool-tunnel-server.
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
cd /opt/cool-tunnel-server

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

## Before first boot — low-memory VPS prep (1 vCPU / 1 GB)

The minimum spec — **1 vCPU, 1 GB RAM** — is enough to *run* the
stack (idle ≈ 240 MiB, moderate load ≈ 400-500 MiB). Tagged releases
download a verified image BOM plus Docker image slices for the VPS CPU
architecture and load them one component at a time. The normal
production path does **not** build Rust, Bun, Go, PHP extensions, or
Docker images on the VPS.

The swap step below is optional runtime safety for very small servers.
It is no longer required for release installs, because release installs
must not compile or build runtime images locally. If `ct install` says a
prebuilt Docker image bundle is missing, the release assets are
incomplete for your architecture; the fix is to publish the image BOM
and slices, not to compile on the VPS.

### a. Add a 2 GB swapfile

Cloud images often ship without swap. Swap gives a 1 GB box more room
for temporary runtime spikes and package installation.

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

### b. Confirm the runtime tuning knobs (already low-mem-friendly by default)

The shipped defaults are already sized for a 1 GB box.
FrankenPHP's worker pool size is configured in
`docker/panel/Caddyfile` via the `frankenphp { worker { num 4 } }`
block — NOT via env. To grow the pool: edit the `num` value in
that file and rebuild the panel image on a maintainer build host, then
publish a new image BOM and image slices. Default
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

### c. Steady-state expectation

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
ct install
```

`ct install` does, in order:

1. Disk headroom check. If space is low, safe temp/build-cache cleanup
   runs automatically; it may remove stale `core/target` and Docker
   build cache, but never Docker volumes, backups, `.env`, or database
   data.
2. `./scripts/fetch_image_bundle.sh` — download the release image
   bundle, verify it through `SHA256SUMS`, and load it with
   `docker load`.
3. `docker compose up -d db redis` — bring up the data layer first.
4. Wait for MariaDB healthcheck to go green.
5. `docker compose up -d panel` — runs the entrypoint, which applies
   app setup, migrations, and the initial `sing-box config.json`
   render.
6. Creates the bootstrap admin when needed:
   `holder` with the VPS-local `CT_BOOTSTRAP_ADMIN_PASSWORD` from `.env`.
7. `docker compose up -d caddy singbox` — Caddy gets the panel cert
   and routes non-panel SNI to sing-box.
8. Tails Caddy and sing-box logs until the panel cert is available
   and sing-box is running.

When it finishes, open:

```text
https://${PANEL_DOMAIN}/admin
```

Log in as `holder` with `CT_BOOTSTRAP_ADMIN_PASSWORD` from `.env`.
The panel requires you to change that bootstrap password before using
the admin area.

### Check the certificate landed

```bash
echo | openssl s_client -servername proxy.example.com \
    -connect proxy.example.com:443 2>/dev/null \
    | openssl x509 -noout -issuer -subject -dates
```

You want `issuer=… Let's Encrypt`. If you see a self-signed cert,
ACME hasn't completed yet — `docker compose logs --tail=120 caddy`
will tell you why
(usually port 80 not reachable, or DNS not yet propagated).

---

## 8. Create your first proxy account

In the Filament panel: **Proxy Accounts → New**.

- **Username** — any ASCII you like (`alice`).
- **UUID** — generated automatically and shown once after create.
- **Expires at** — datetime, blank = never.

When you save, the panel:

1. Writes the account row and VLESS UUID to `proxy_accounts`.
2. Queues a Messenger render job after the DB commit.
3. Renders `/data/config/singbox.json`; the sing-box supervisor
   watches that file and restarts sing-box when it changes.

The create page shows a subscription URL. Import that URL in the Cool
Tunnel client; it contains the server, UUID, Reality public key,
Reality dest_host, short ID, and local SOCKS default.

---

## 9. Day-2 ops

### Update to a new release

```bash
cd /opt/cool-tunnel-server
./ct update
```

`ct update` does `git pull`, downloads and loads the verified release
image bundle, runs new migrations, re-renders the sing-box config, and
starts the updated containers.

If an install or update stops after containers are mostly up, run:

```bash
./ct recover diagnose
```

For the common stale rendered-config case, use:

```bash
./ct recover fix-stale-singbox
```

If `singbox:render` reports `Could not decrypt the data` and the old
`APP_KEY` is gone, use:

```bash
./ct recover reset-reality
```

That resets only the Reality keypair; clients must re-import their
subscription URLs afterward.

### Back up

```bash
./ct backup
# → backups/cool-tunnel-YYYY-MM-DD.tar.gz   (mode 0600 — operator-only)
#   contains: .env (APP_KEY + DB / Redis secrets), db dump
#             (--single-transaction), caddy_data.tgz (ACME certs +
#             private keys), manifests/, and deployment templates
```

The tarball mode is `0600` — the contents are operator-secret
(APP_KEY signs subscription URLs and decrypts sealed server secrets).
Move it off the VPS to a private storage bucket / encrypted disk ASAP.

### Restore

```bash
./ct restore backups/cool-tunnel-YYYY-MM-DDTHH-MM-SSZ.tar.gz
```

Documented disaster-recovery procedure (works on a fresh VPS):

1. Provision the new VPS (1 vCPU / 1 GB minimum, same region or
   the closest one to your users).
2. Install the same base tools and Docker Engine from this guide, then
   bootstrap the latest official release:
   ```bash
   LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
   BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
   cd /opt/cool-tunnel-server
   ```
3. Copy the backup tarball into `backups/`.
4. **Repoint DNS** — update both `${DOMAIN}` and `${PANEL_DOMAIN}`
   A records to the new VPS IP. Wait for propagation
   (`dig +short ${DOMAIN}` matches the new IP).
5. `./ct restore backups/cool-tunnel-YYYY-MM-DDTHH-MM-SSZ.tar.gz`
6. Verify: `./ct doctor` has no FAIL rows,
   and `curl -ksI https://${PANEL_DOMAIN}/admin` returns 200/302.

The restored `.env` brings APP_KEY, DB, and Redis settings across,
so existing signed subscription URLs and VLESS UUID credentials remain
valid. The restored `caddy_data` brings the existing Let's Encrypt
certs across, avoiding LE rate-limit budget on re-issue (5 duplicate
certs per 7 days).

### Tail logs

```bash
docker compose logs -f --tail=200 caddy      # ACME + routing
docker compose logs -f --tail=200 singbox    # proxy runtime
docker compose logs -f --tail=200 panel      # Laravel + queue worker
docker compose logs -f --tail=200 db
```

### Rotate a leaked UUID

Filament panel → Proxy accounts → **Regenerate UUID**. The new UUID
and subscription URL are shown once. The panel writes a fresh sing-box
config immediately when it can; otherwise the queued worker or
scheduled render reconciles it.

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
| `unable to verify the first certificate` from `curl` | ACME hasn't completed yet (self-signed in use) | `docker compose logs --tail=120 caddy` and wait |
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
- **Run the health gates** every release. `./ct doctor` and
  `php artisan credential-lock:check` catch
  most deployment drift before users do.
- **Use `./ct backup`** — it captures `caddy_data` (ACME
  certs + private keys; ACME moved from sing-box to Caddy in
  v0.0.4) plus the DB dump, the three render-input templates,
  manifests/, and `.env`. Run weekly to a private storage bucket;
  store with the same security posture as your DB password.
  Without `caddy_data`, every `docker compose down -v` resets
  your cert and burns LE rate-limit budget (5 duplicate-cert
  issuances per 7-day window).
- **IPv4-only networking** — the installer pins the host and Docker
  daemon to IPv4-only routing before release downloads. Use an `A`
  record for the proxy hostname.
- **Protect the panel hostname.** Use a dedicated `PANEL_DOMAIN`,
  keep admin passwords unique, and leave Cloudflare proxying off for
  the panel/proxy records so ACME and Reality routing stay predictable.

---

## Debian 12+ cheat sheet

| Step | Debian 12 (bookworm) | Debian 13+ |
| --- | --- | --- |
| Apt sources for security | `security.debian.org/debian-security bookworm-security main` | Use the matching Debian security suite |
| Default kernel | 6.1 | 6.x or newer |
| BBR module | built-in | built-in |
| NFTables default | yes | yes |
| Docker repo codename | `bookworm` | matching codename, or `bookworm` while a new Debian release is still settling |
| Compose v2 plugin pkg | `docker-compose-plugin` | `docker-compose-plugin` |
| systemd-resolved enabled by default | no | no |

---

## What this guide does *not* cover

- **Notarised domains / EV certs.** Let's Encrypt DV is fine; you do
  not need a paid CA.
- **TLS pinning.** VLESS+Reality clients pin the Reality public key
  delivered in the subscription manifest; no extra CA pinning is
  needed.
- **Multi-tenant separation.** Every proxy account in this guide
  lives in the same Caddy process. If you want isolation between
  customers, run multiple stacks on different VPSs and federate the
  panel — out of scope for v0.0.1.
- **CDN fronting.** You can put Caddy behind a CDN that supports
  HTTP/2 CONNECT (rare), but most won't work — just point DNS
  straight at the box.
