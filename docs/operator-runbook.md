# Operator Runbook

Short path for day-to-day VPS operations on a Cool Tunnel Server
deployment. Use this runbook for install, update, backup, doctor, and
failure recovery on a self-hosted proxy server.

## Goal

Keep operations simple:

```text
install -> doctor -> use
backup -> update -> doctor
doctor -> follow the remediation
```

The production VPS should not be a place for long-lived source edits.
Use `.env`, the admin UI/API, and release tags as the control surface.

## Install

```bash
apt update
apt install -y ca-certificates curl git gnupg jq openssl apache2-utils ufw dnsutils chrony fail2ban unattended-upgrades
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
cd /opt/cool-tunnel-server
$EDITOR .env
ct install
```

Verify:

```bash
docker compose ps
docker compose exec -T admin-api bun -e 'await fetch("http://127.0.0.1:9000/up").then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); })'
./ct doctor
```

## Update

```bash
cd /opt/cool-tunnel-server
ct backup
ct update
ct doctor
```

`ct update` owns the release path: load release images, run
migrations, render Caddy and sing-box config, restart affected
services, and run the health gates.

Verify after update:

```bash
docker compose exec -T admin-api bun -e 'await fetch("http://127.0.0.1:9000/up").then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); })'
./ct doctor
```

If git state blocks the update and this is a normal production VPS,
reset to published main:

```bash
cd /opt/cool-tunnel-server
git fetch origin
git checkout main
git reset --hard origin/main
./scripts/fetch_operator_binary.sh || true
ct update
ct doctor
```

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

If you did not intentionally keep those edits, use the reset flow in
the update section.

If credentials or rendered config look stale:

```bash
ct render singbox
docker compose restart singbox
./ct doctor
```

Useful logs:

```bash
docker compose logs --tail=120 admin-api
docker compose logs --tail=120 admin-web
docker compose logs --tail=120 caddy
docker compose logs --tail=120 singbox
```

If `ct update` reports a missing image bundle:

```bash
./scripts/fetch_image_bundle.sh
ct update
```

If the bundle is absent from the GitHub release, the release is
incomplete for that CPU architecture; publish the bundle instead of
building on the VPS.
