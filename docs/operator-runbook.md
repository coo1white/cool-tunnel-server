# Operator Runbook

Use this page for day-to-day VPS operations. It is intentionally short:
install once, update normally, fix only when a command says something is
wrong.

## Install

Run this on a fresh VPS after DNS points at the box.

```bash
cd /opt
git clone https://github.com/coo1white/cool-tunnel-server.git
cd cool-tunnel-server

cp .env.example .env
$EDITOR .env

make install
```

After install, verify:

```bash
docker compose ps
docker compose exec -T panel php artisan ct:version
docker compose exec -T panel ct-server-core component check --manifests /srv/manifests
```

For launch readiness, include a real proxy account password:

```bash
LNC_TEST_PROXY_URL='https://USER:PASSWORD@DOMAIN:443' make readiness
```

Expected release-ready result is at least `9/11`. DNS, ports, ACME,
and UFW are structural checks; if any of those fail, fix them first.

## Update

Normal update path:

```bash
cd /opt/cool-tunnel-server
git fetch origin --tags
git pull --ff-only origin main
make update
```

What `make update` owns:

- pulls the latest fast-forward release
- rebuilds changed images
- runs migrations
- renders sing-box and HAProxy config
- verifies `db = rendered = manifest = Mac config`
- reloads sing-box through Clash API
- restarts sing-box from the host to purge stale runtime state
- runs strict component checks

Verify after update:

```bash
git describe --tags --exact-match HEAD
docker compose exec -T panel php artisan ct:version
docker compose exec -T panel ct-server-core guard credential-lock
docker compose exec -T panel ct-server-core component check --manifests /srv/manifests
```

## Fix

Start with state, not guesses:

```bash
cd /opt/cool-tunnel-server
git status -sb
docker compose ps
make components
```

If `git pull` refuses because of a local file edit, inspect it before
discarding it:

```bash
git diff -- PATH
git restore PATH
git pull --ff-only origin main
```

Only restore the file that blocks the pull. Do not use `git reset
--hard` unless you intentionally want to drop every local edit.

If sing-box credentials or runtime state look stale:

```bash
docker compose exec -T panel ct-server-core guard credential-lock
docker compose exec -T panel ct-server-core server reload
docker compose restart sing-box
docker compose exec -T panel ct-server-core component check --manifests /srv/manifests
```

If `naiveproxy-client` is NG, compare the manifest pin to the binary:

```bash
jq -r '.version' manifests/naiveproxy-client.upstream.json
docker compose exec -T panel /usr/local/bin/naive --version
```

The manifest version must be contained in the binary output. The
Dockerfile asset tag may have a rebuild suffix such as `-2`; the
installed binary may not print that suffix.

If readiness fails, fix by category:

- DNS / ports / ACME / UFW: structural. Fix firewall, DNS, or cert
  reachability before chasing app logs.
- Kernel tuning: run the BBR sysctl block from `GETTING_STARTED.md`.
- Functional checks skipped: set `LNC_TEST_PROXY_URL`.
- Component NG: run `make update`, then `make components`; inspect the
  specific NG row if it remains.

Useful logs:

```bash
docker compose logs --tail=120 panel
docker compose logs --tail=120 sing-box
docker compose logs --tail=120 haproxy
```
