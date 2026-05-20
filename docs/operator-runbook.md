# Operator Runbook

Short path for day-to-day VPS operations.

## Install

```bash
cd /opt
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server
cp .env.example .env
$EDITOR .env
make install
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
git fetch origin --tags
git pull --ff-only origin main
make update
```

`make update` owns the release path: rebuild changed images, run
migrations, render Caddy and sing-box config, restart affected
services, verify credential lock, and run the health gates.

Verify after update:

```bash
docker compose exec -T panel php artisan ct:version
docker compose exec -T panel php artisan credential-lock:check
./ct doctor
```

## Fix

Start with state:

```bash
git status -sb
docker compose ps
./ct doctor
```

If a local edit blocks `git pull`, inspect only that path before
discarding it:

```bash
git diff -- PATH
git restore PATH
git pull --ff-only origin main
```

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
