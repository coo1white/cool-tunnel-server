# Operator Runbook

Short path for day-to-day VPS operations on a Cool Tunnel Server deployment.

## Goal

```text
install -> doctor -> bootstrap owner -> use
backup -> update -> doctor
doctor -> follow the remediation
```

The production VPS should not be a place for long-lived source edits. Use `.env`, `ct`, and release tags as the control surface.

## Install

```bash
apt update
apt install -y ca-certificates curl git gnupg jq openssl ufw dnsutils chrony fail2ban unattended-upgrades
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
cd /opt/cool-tunnel-server
$EDITOR .env
ct install
ct doctor
ct admin bootstrap
```

Open the printed bootstrap URL, create the owner, then sign in at `https://<PANEL_DOMAIN>/admin`.

## Update

```bash
cd /opt/cool-tunnel-server
ct backup
ct update
ct doctor
```

`ct update` owns the release path: load release images, run migrations, render Caddy and sing-box config, restart affected services, and run health gates.

## Fix

Start with state:

```bash
git status -sb
docker compose ps
./ct doctor
```

If a local edit blocks `git pull`, inspect before discarding it:

```bash
git diff --stat
git diff -- PATH
```

If generated config looks stale:

```bash
ct render singbox
ct render caddyfile
docker compose restart singbox caddy
ct doctor
```

Useful logs:

```bash
docker compose logs --tail=120 panel
docker compose logs --tail=120 caddy
docker compose logs --tail=120 singbox
docker compose logs --tail=120 db
docker compose logs --tail=120 redis
```

If `ct update` reports a missing image bundle:

```bash
./scripts/fetch_image_bundle.sh
ct update
```

If the bundle is absent from the GitHub release, the release is incomplete for that CPU architecture; publish the bundle instead of building on the VPS.
