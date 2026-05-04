# Getting Started

You SSH'd into a fresh Debian VPS. You want a working Cool Tunnel
Server in 30 minutes. This page is the friendly walkthrough — no
deep dives, no architecture detours, just commands you paste and
sentences explaining what each one does.

If something fails, the install script tells you exactly what to
try next. Read the failure block when it appears; it almost always
ends with a `↳ try:` line that's the right next step.

> The deeper, "I want to understand every choice" version of this
> guide is [`docs/installation-debian.md`](./docs/installation-debian.md).
> Start there once you've finished this page and want to know *why*.

---

## What you need

| Thing | Why |
| --- | --- |
| A VPS running Debian 11, 12, or 13 (1 vCPU, 1+ GB RAM) | Where the proxy lives |
| `root` SSH access (or a sudoer) | To install Docker |
| A real domain pointing at the VPS (`A` and ideally `AAAA` records, TTL 300, **proxy disabled** if it's behind Cloudflare) | sing-box uses Let's Encrypt to issue a real cert; ACME needs a real domain |
| Ports 80, 443/tcp, 443/udp open at the cloud-provider firewall | Sing-box binds 80 for ACME and 443 for the proxy itself |

Five-minute sanity check: from your local machine,

```sh
dig +short A   proxy.example.com   # should match the VPS public IP
ping -c1 -W2   proxy.example.com   # should reach it
```

If those don't work, fix DNS first. Everything below assumes DNS
resolves to the box you're working on.

---

## Step 1 — Get the box ready (one-time prep)

SSH into the VPS as root (or use `sudo -i`). Then:

```sh
apt update && apt -y upgrade

apt install -y \
    ca-certificates curl gnupg ufw dnsutils \
    chrony fail2ban unattended-upgrades \
    git apache2-utils
```

What this does:

- `ca-certificates curl gnupg` — Docker's apt repo needs them.
- `ufw` — the firewall we'll use; very Debian-friendly.
- `dnsutils` — gives you `dig` so you can verify DNS at any point.
- `chrony` — keeps the clock right. TLS handshakes fail with a
  drifting clock; this prevents that.
- `fail2ban` — auto-bans SSH brute-forcers.
- `unattended-upgrades` — applies security patches automatically.
- `git` — to clone this repository.
- `apache2-utils` — gives you `htpasswd`, used to bcrypt-hash the
  panel admin password.

### Open the firewall

```sh
ufw allow OpenSSH
ufw allow 80/tcp        # ACME + http→https
ufw allow 443/tcp       # the proxy
ufw allow 443/udp       # HTTP/3
ufw --force enable
```

### Install Docker (official repo, not Debian's old one)

```sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
  | tee /etc/apt/sources.list.d/docker.list >/dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io \
              docker-buildx-plugin docker-compose-plugin

# Confirm.
docker version
docker compose version
```

If any of those fail, you'll see a clear error from apt.
[`docs/installation-debian.md`](./docs/installation-debian.md#5-install-docker-engine--compose-v2)
has the per-Debian-version notes.

### A bit of kernel tuning (BBR + bigger UDP buffers for HTTP/3)

```sh
cat >/etc/sysctl.d/99-cool-tunnel.conf <<'EOF'
net.core.default_qdisc            = fq
net.ipv4.tcp_congestion_control   = bbr
net.ipv4.tcp_fastopen             = 3
net.core.rmem_max                 = 7500000
net.core.wmem_max                 = 7500000
EOF
sysctl --system
```

You can do this *after* getting the proxy running too — it's not
on the critical path, just a measurable performance win.

---

## Step 2 — Pull the server

```sh
cd /opt
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server
```

`/opt` is conventional for site-local stacks. Pick anywhere you like.

---

## Step 3 — Fill in `.env`

```sh
cp .env.example .env
$EDITOR .env       # nano, vim, vi — whichever you have
```

You **must** edit:

| Key | What to put |
| --- | --- |
| `DOMAIN` | the domain you set up DNS for |
| `ACME_EMAIL` | a real email — Let's Encrypt sends renewal warnings here |
| `DB_ROOT_PASSWORD` | run `openssl rand -base64 32` and paste the output |
| `DB_PASSWORD` | a different `openssl rand -base64 32` |
| `REDIS_PASSWORD` | a third `openssl rand -base64 32` |
| `PANEL_BASIC_AUTH_HASH` | run `htpasswd -nbB admin '<your-password>' \| cut -d: -f2-` and paste the output (the bcrypt part after `admin:`) |

The other keys can stay at their defaults.

### Why two admin passwords?

The Filament login page is reached over the public internet. To stop
drive-by scanners from even *seeing* it, sing-box's fallback inbound
forces an extra HTTP basic-auth challenge first (the
`PANEL_BASIC_AUTH_*` keys). Use a different password from the
Filament admin password so the two layers really are independent.

---

## Step 4 — Run the installer

```sh
./scripts/install.sh
```

The script is interactive: it tells you what each step is doing,
asks before destructive choices, and prints a `↳ try:` hint if any
step fails.

When it finishes, it'll print the URL of your panel and the
command to make your first proxy account.

---

## Step 5 — Make a proxy account

The admin panel is bound to `127.0.0.1:9000` on the VPS, **not**
public on `:443/admin`. Public reachability is a deferred v0.1
item (see `docs/design/sni-router-v0.1.md`). Open it through an
SSH local-port-forward:

```sh
# In a separate terminal on your laptop:
ssh -N -L 9000:127.0.0.1:9000 root@your-vps

# Leave that running; in your browser, open:
http://127.0.0.1:9000/admin
```

Filament's login page asks for the admin user the installer asked
you to create. TLS is provided by the SSH session.

Inside the panel:

1. **Proxy accounts → New**.
2. Fill in a username (`alice`).
3. Click **Create**.
4. **Copy the password from the green notification at the top.**
   This is the only time you'll see it. The bcrypt hash plus a
   Laravel-Crypt-encrypted copy of the cleartext lands in the DB
   (sing-box needs the cleartext to check basic_auth).

---

## Step 6 — Point the macOS client at it

In Cool Tunnel (the [macOS app](https://github.com/coo1white/cool-tunnel)),
add a profile with:

```
naive+https://alice:<password>@your-domain.com:443
```

Pick *Smart* mode. Click **Start**. From any browser on the laptop,
visit https://ifconfig.co — it should show the **server's** IP, not
the laptop's.

---

## Step 7 — Verify the launch is solid

There's a built-in readiness check that does ten things and gives
you a percentage score:

```sh
LNC_TEST_PROXY_URL='https://alice:<password>@your-domain.com:443' \
  ./scripts/late-night-comeback.sh
```

It checks DNS, ports, ACME, UFW, BBR, NTP, components, the Redis
revocation bridge, a synthetic CONNECT, and the anti-tracking probe.

≥ 8 / 10 = ready to ship.
≤ 7 / 10 = read the NG lines, fix them, run again.

The four "structural" checks (DNS / ports / ACME / UFW) cap your
score at 7 if any is NG, regardless of the other six — those are
non-negotiable.

---

## When something goes wrong

In rough order of "most common first":

| Symptom | Most likely cause | What to do |
| --- | --- | --- |
| Browser shows the cover site instead of the panel | Cloudflare proxy is on (orange cloud) — turn it OFF | DNS-only mode in Cloudflare |
| `dig +short A your-domain` returns nothing or wrong IP | DNS not propagated yet | Wait 5 min, try again |
| ACME never finishes (cert is self-signed) | Port 80 not reachable | `ufw status` and your cloud firewall |
| `docker compose logs sing-box` shows clock-skew | NTP not running | `timedatectl set-ntp true` |
| `docker compose logs panel` shows "could not decrypt" | APP_KEY mismatch between containers | regenerate one proxy account in the panel — that re-encrypts under the current key |
| Connections feel slow even at low load | BBR not active | `sysctl net.ipv4.tcp_congestion_control` should print `bbr` |

For deeper debugging, [`docs/installation-debian.md`](./docs/installation-debian.md#10-common-gotchas-by-symptom)
has a full troubleshooting table.

---

## What lives where

A one-screen overview of the codebase you just installed:

| Thing | Where | Language |
| --- | --- | --- |
| Sing-box config template | `sing-box/config.json.tpl` | Go template |
| Sing-box server | `docker/sing-box/Dockerfile` | Dockerfile |
| Rust core (renders the template, hot-reloads sing-box) | `core/ct-server-core/` | Rust |
| Cross-platform shared crate | `core/ct-protocol/` | Rust |
| Filament admin panel | `panel/app/Filament/`, `panel/app/Models/`, `panel/app/Services/` | PHP |
| Cover site templates | `panel/resources/views/fake-sites/` | Blade |
| Database migrations | `panel/database/migrations/` | PHP |
| Operator scripts | `scripts/` (sourcing `scripts/lib.sh`) | Bash |
| Component pin manifests | `manifests/*.upstream.json` | JSON |

If you want a longer "what each layer does" tour, read
[`docs/architecture.md`](./docs/architecture.md). For the
component-as-machine-part story, read
[`docs/components.md`](./docs/components.md).

---

## Read before you let anyone else use it

`Disclaimer.md` covers operator responsibility and what the bundled
components are. It's short. Read it.
