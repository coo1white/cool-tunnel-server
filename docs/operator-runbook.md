# Operator Runbook

Short path for day-to-day VPS operations.

## Goal

Keep operations simple:

```text
install -> doctor -> use
backup -> update -> doctor
doctor -> follow the remediation
```

The production VPS should not be a place for long-lived source edits.
Use `.env`, the panel, and release tags as the control surface.

## Install

```bash
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
cd /opt/cool-tunnel-server
$EDITOR .env
ct install
```

Verify:

```bash
docker compose ps
docker compose exec -T panel php artisan ct:version
docker compose exec -T panel php artisan credential-lock:check
./ct doctor
```

## Update

```bash
cd /opt/cool-tunnel-server
ct backup
ct update
ct doctor
```

`ct update` owns the release path: rebuild changed images, run
migrations, render Caddy and sing-box config, restart affected
services, verify credential lock, and run the health gates.

Verify after update:

```bash
docker compose exec -T panel php artisan ct:version
docker compose exec -T panel php artisan credential-lock:check
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
docker compose exec -T panel php artisan credential-lock:check
docker compose exec -T panel php artisan singbox:render --no-interaction
docker compose restart singbox
./ct doctor
```

Useful logs:

```bash
docker compose logs --tail=120 panel
docker compose logs --tail=120 caddy
docker compose logs --tail=120 singbox
docker compose logs --tail=120 db
docker compose logs --tail=120 redis
```

If the Rust core build fails with `NetworkUnreachable`:

```bash
curl -4 -I https://static.rust-lang.org/
curl -4 -I https://index.crates.io/
docker builder prune -af
ct update
```

If either `curl -4` command fails, fix VPS outbound HTTPS/DNS first.
