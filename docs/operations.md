# Cool Tunnel Server Operations

You've finished [GETTING_STARTED.md](../GETTING_STARTED.md) and your
self-hosted Docker proxy server is live. This page covers the regular
VPS operations for Cool Tunnel Server: health checks, release updates,
backups, restores, logs, password rotation, and troubleshooting.

Use it when you need to operate a sing-box VLESS Reality server and
Better-T-Stack admin surface after the first install:

- [Daily checklist](#daily-checklist)
- [Updating to a new release](#updating-to-a-new-release)
- [Backing up](#backing-up)
- [Restoring from backup](#restoring-from-backup)
- [Migrating v0.5.1 to v0.5.2](#migrating-v051-to-v052)
- [Looking at logs when something seems off](#looking-at-logs-when-something-seems-off)
- [Rotating passwords](#rotating-passwords)
- [Watching health over time](#watching-health-over-time)
- [Common problems and one-command fixes](#common-problems-and-one-command-fixes)
- [What `ct update` actually does](#what-ct-update-actually-does)
- [Command reference](#command-reference)

The examples below assume you are in `/opt/cool-tunnel-server` or have
added `ct` to your shell path.

Run `ct help` for the built-in operator mini-manuals.

---

## Simple operations rule

Keep the VPS boring:

```text
ct install  # first setup
ct update   # release update
ct doctor   # health + next fix
ct backup   # safety before changes
```

Do not maintain a private fork directly on the VPS. Do not hand-edit
rendered Caddy or sing-box config. The repo should stay clean so
`ct update` can fast-forward and the admin API can regenerate runtime
config from one source of truth.

The server release owns these portable runtime plugins:

- `sing-box`
- `cool-tunnel-core`

Clients fetch both from the `cool-tunnel-server` GitHub release and
verify them with the release `SHA256SUMS` file.

---

## Daily checklist

If you're checking in on the server in the morning, this is all you
need:

```sh
ct doctor
```

That prints a colour-coded PASS / WARN / FAIL dashboard across ~13
checks (DNS, ports, ACME cert expiry, container health, admin API
/up endpoint, direct-dial settings, disk + RAM headroom). Any
FAIL row comes with a one-line "↳" hint at the bottom telling you
exactly what to run next.

Exit code 0 means everything is green or only warnings (no FAILs).
Cron-suitable.

Use `ct doctor` after launch, after updates, and after incidents. It
shows everything an operator should glance at and exits non-zero when a
FAIL row needs attention.

---

## Updating to a new release

The single most common operation. Run this whenever a new release is
announced (every few days during active development):

```sh
ct backup     # always FIRST — protects you if the update goes wrong
ct update     # pull + load release images + restart
ct doctor     # confirm everything still works
```

If the checkout is stale, pinned, or locally edited and you just want
the published server state:

```sh
cd /opt/cool-tunnel-server
git fetch origin
git checkout main
git reset --hard origin/main
./scripts/fetch_operator_binary.sh || true
ct update
ct doctor
```

That reset discards tracked local source edits. On a production VPS,
that is usually correct because config belongs in `.env`, the database,
and the admin UI/API, not in patched source files.

What `ct update` does, in plain terms:

1. **Pre-flight**: checks network reachability for release downloads,
   runs a safe temp/build-cache cleanup, checks disk headroom, stack is
   up, working tree is clean.
   If your tree has uncommitted edits (e.g. a hand-patched Dockerfile),
   it can continue as install-style reconciliation if the stack is down.
2. **Locks** so no one else can run an update at the same time.
3. **Pulls** the latest code from GitHub (`git pull --ff-only`).
4. **Auto-migrates** legacy `.env` shape if needed (idempotent).
5. **Loads** the verified Docker image bundle for the release.
6. **Migrates** the admin SQLite database and reports the schema status.
7. **Re-renders** the Caddyfile and sing-box config through the
   `admin-api` render boundary.
8. **Recreates** `admin-api`, `admin-web`, `singbox`, and `caddy`.
9. **Reloads** Caddy from the host-side
   operator.
10. **Health gates** on the post-swap runtime; reports remediation
   hints when `doctor` fails.

✅ **Good**: ends with `✓ Update complete.` and `ct doctor` afterward
shows mostly PASS.

❌ **Bad**: every failure path now prints a multi-line `Diagnostic:`
block with what happened, why, and what to do next. The most common
classes:

| What you see | Why | What to do |
|--------------|-----|-----------|
| `auto-stashing local edits before update` | Working tree has local edits | `ct update` stashes them automatically; recover with `git stash pop` |
| `network: cannot reach ...` | Outbound HTTPS broken from the VPS | Check the diagnostic block's command ladder (ping / dig / curl) |
| `low disk under repo path: NG free` | The VPS is still too full after auto-clean | Follow the diagnostic block; usually `docker system prune -af` + checking large host directories |
| `prebuilt Docker image bundle is required` | Release asset is missing for this CPU architecture | Run `./scripts/fetch_image_bundle.sh`; if it says no entry in `SHA256SUMS`, publish the missing image BOM/slices |
| `post-swap check NG: <component>` | A specific service didn't come up clean | The diagnostic block lists which component + the targeted `docker compose logs ...` to run |

Before install/update loads release images, `ct install` and
`ct update` check disk headroom. If the check is already healthy, they
skip cleanup. If free space is below the safety threshold, they
automatically run conservative cleanup:

- removes stale `core/target` only when repo-path free space is below
  the safety threshold
- runs `docker builder prune -f` and `docker system prune -f`
- never removes Docker volumes, backups, `.env`, database data, or
  live containers

If `docker load` cannot recover enough room, it is disk pressure on the
Docker root:

```sh
docker system prune -af && docker builder prune -af
df -h /var/lib/docker     # should be >= 4G free
ct update                  # retry
```

If the image BOM or slices are missing from the release:

```sh
./scripts/fetch_image_bundle.sh
ct update
```

If you need to roll back to the previous known-good release:

```sh
git checkout v0.0.<X>      # the prior known-good tag
./ct update        # loads that release's images and redeploys
```

---

## Backing up

```sh
ct backup
```

Creates `backups/cool-tunnel-<UTC-timestamp>.tar.gz` containing:

- Admin SQLite database (`admin.sqlite`)
- The `caddy_data` Docker volume (ACME certificates + private keys)
- Your `.env` (with all secrets)
- The manifest set and render templates

The tarball is mode 0600 by default. Two important things:

1. **The backup contains every admin and proxy secret on your VPS** —
   `BETTER_AUTH_SECRET`, Reality keys, bootstrap material if present,
   SQLite user/password hashes, subscription tokens, and ACME private
   keys. Treat it like a secret.
2. **Copy it off-server.** A fire / VPS termination otherwise takes
   both your live data and the backup with it. From your laptop:

   ```sh
   scp root@your-vps:/opt/cool-tunnel-server/backups/cool-tunnel-*.tar.gz \
       ~/backups/cool-tunnel/
   ```

   For automated off-server backup, consider [Backblaze B2](https://www.backblaze.com/cloud-storage),
   [rclone](https://rclone.org/) with end-to-end encryption, or
   [restic](https://restic.net/). Avoid any provider that holds the
   key for you.

How often: at least before every `ct update`, daily-via-cron if you
have active users, and any time you're about to do something risky
(rotating passwords, swapping hosting providers, etc.).

---

## Restoring from backup

If your VPS dies and you need to bring up a new one:

1. **Provision a fresh VPS** the same way you did the first time.
2. **Run `ct install`** to bring up an empty stack (Steps 1-4 of
   GETTING_STARTED.md). This gets Docker + base images + an empty
   SQLite database.
3. **Copy your backup tarball** back to the new VPS:

   ```sh
   scp ~/backups/cool-tunnel/cool-tunnel-LATEST.tar.gz \
       root@new-vps:/opt/cool-tunnel-server/backups/
   ```
4. **Restore**:

   ```sh
   cd /opt/cool-tunnel-server
   ./ct restore backups/cool-tunnel-LATEST.tar.gz
   ct doctor
   ```

You're back online with the same accounts, same password hashes, same
subscription tokens, same Reality credentials, and same SSL certs.

> **Destructive.** The DB import step drops + recreates the
> Docker volumes for the restored stack. There's no "are you sure?"
> prompt — run with intent.

---

## Migrating from the retired PHP runtime

v0.5.2 was a control-plane rebuild. It replaced the old PHP admin
runtime with `apps/web` plus `apps/api`, and replaced MariaDB/Redis
control-plane storage with SQLite at `./data/admin/admin.sqlite`.

There is no automated importer from the retired PHP/Laravel runtime:
fresh deployments start on the native SQLite schema, and `ct admin
migrate` only brings that schema to the required version. If you still
operate a pre-rebuild VPS, run `ct backup` first, then provision a clean
v0.5.x install and recreate accounts through `ct admin` and the admin UI.

---

## Looking at logs when something seems off

```sh
# Last few minutes of the admin API (the most-common place to look)
docker compose logs --tail=60 admin-api

# Same, but follow live (Ctrl+C to stop)
docker compose logs -f admin-api

# Just the errors, no info noise
docker compose logs --tail=200 admin-api \
  | grep -iE 'error|fatal|critical|warn'
```

Replace `admin-api` with one of: `admin-web`, `singbox`, `caddy`.

Quick triage rules:

- **Admin API restart-loops** → config validation or SQLite migration
  failed. Check `docker compose logs --tail=120 admin-api`.
- **502 from the panel domain** → Caddy can't reach `admin-web`. Check
  `docker compose ps admin-web admin-api`.
- **Subscription URLs don't reach sing-box** → Caddy SNI routing or
  sing-box startup issue. Check `docker compose logs caddy` and
  `docker compose logs singbox`.
- **Cert errors in browser** → Caddy ACME failure. Check
  `docker compose logs caddy | grep -iE 'acme|cert'`.

---

## Rotating secrets

Recommended cadence: rotate admin passwords when staff changes and
rotate `BETTER_AUTH_SECRET` only as an incident response. `BETTER_AUTH_SECRET`
signs sessions, bootstrap tokens, and subscription URL tokens; changing
it logs admins out and invalidates existing subscription URLs until you
open each proxy account and copy a fresh URL.

Do not rotate Reality keys casually. They are part of the client
connection profile and require clients to re-import subscriptions after
the server is re-rendered.

Always back up first:

```sh
ct backup
```

### Admin Passwords

Owners and admins can reset user passwords from the admin UI. From the
VPS shell:

```sh
ct admin users list
printf '%s\n' '<temporary long password>' | ct admin users reset-password --id <user-id> --password-stdin
```

### Better Auth Secret

Back up first, then replace `BETTER_AUTH_SECRET` in `.env`, restart the
admin API, and copy fresh subscription URLs for active clients:

```sh
ct backup
NEW_SECRET=$(openssl rand -base64 48 | tr -d '\n')
awk -v p="$NEW_SECRET" '/^BETTER_AUTH_SECRET=/ { print "BETTER_AUTH_SECRET=" p; next } { print }' \
  .env > .env.tmp && mv .env.tmp .env && chmod 0600 .env
docker compose up -d --no-build --pull never --force-recreate admin-api admin-web
unset NEW_SECRET
ct doctor
```

---

## Watching health over time

The Rust daemon can expose Prometheus-format metrics for Grafana,
Alertmanager, etc. Off by default.

To enable:

1. Edit `.env`, add: `CT_METRICS_BIND=127.0.0.1:9292`
2. `ct update` (or `docker compose restart admin-api`)
3. Scrape from inside the admin API container:

   ```sh
   docker compose exec -T admin-api curl -fsS http://127.0.0.1:9292/metrics
   ```

Three counters worth alarming on:

- `ct_threshold_80pct_crossings_total` — the daemon got close to a
  resource limit (frame buffer, latency budget). Investigate client
  behaviour.
- `ct_daemon_fsm_hard_resets_total` — the daemon rejected a
  malformed protocol message. A non-zero rate usually means a
  misbehaving client.
- `otel_network_turn_latency_milliseconds` — daemon-side latency
  distribution.

Full Prometheus scrape config + Grafana queries:
[docs/observability-dashboard.md](./observability-dashboard.md).

---

## Common problems and one-command fixes

If something goes wrong, check this table first — most issues have
a one-command fix:

| What you're seeing | What it means | What to do |
|--------------------|---------------|-----------|
| `ct update` died mid-way (SSH dropped, disk full, etc.) | Build was interrupted but state is fine | Re-run `ct update` — idempotent and safe to repeat |
| Build fails with `curl: (22) error 404` | Upstream package got renamed | `git pull && ct update` for the latest fix |
| Admin API restart-loops | Usually missing `BETTER_AUTH_SECRET`, invalid Reality keys, or SQLite migration failure | `docker compose logs --tail=120 admin-api` shows the exact line |
| `doctor` shows `/up endpoint connection failed` | `admin-api` down or unreachable | `docker compose ps admin-api` + `docker compose logs --tail=80 admin-api` |
| `doctor` shows `Containers <N>/4 running` with one missing | One container failed | The diagnostic block lists which one + its log-tail command |
| Admin login fails after secret rotation | `BETTER_AUTH_SECRET` changed | Log in again and copy fresh subscription URLs for clients |
| Browser shows `ERR_SSL_PROTOCOL_ERROR` | Certificate hasn't been issued or expired | `docker compose logs caddy \| tail -40` shows the ACME error; usually DNS or port-80 reachability |
| Component drift | Pinned version bumped in code | `ct update` brings everything in lockstep |

For deeper troubleshooting: [docs/operator-runbook.md](./operator-runbook.md).

For the operator-side troubleshooting mini-manual:

```sh
ct help troubleshooting   # top 8 issues, ranked by frequency
```

---

## What `ct update` actually does

For operators who want to understand the exact sequence:

1. Acquires an exclusive `flock` so a second operator can't race the
   update (v0.0.80 hardening).
2. Pre-flight: network reachable, disk headroom, stack up, working
   tree clean (v0.0.96).
3. `git pull --ff-only` to the latest tag on `main`.
4. Auto-migrates legacy `.env` shape (PANEL_DOMAIN placement, APP_URL
   hostname) if needed; idempotent on already-canonical files.
5. Loads the verified Docker image bundle for the release.
6. Runs SQLite migrations through the shared DB package.
7. Re-renders the Caddyfile and sing-box config through `admin-api`.
8. Recreates `admin-api`, `admin-web`, `singbox`, and `caddy`.
9. Reloads Caddy from the host-side operator and health gates on the
   post-swap runtime.

If anything fails mid-update, the `flock` auto-releases on script
exit and the whole script is idempotent — just re-run `ct update`.

---

## Command reference

The most-used `ct` commands:

| Command | What it does |
|---------|--------------|
| `ct doctor` | Health dashboard (PASS / WARN / FAIL + remediation hints) |
| `ct status` | Quick "are containers up?" check |
| `ct update` | Pull, load release images, migrate, render, verify, reload |
| `ct backup` | Snapshot DB + .env + ACME state |
| `ct install` | First-time bootstrap (idempotent on re-run) |
| `ct logs` | Tail all container logs |
| `ct help` | List operator mini-manual topics |
| `ct help <topic>` | Print the mini-manual for one topic |

Developer gates:

```sh
make fmt          # cargo fmt --all
make lint         # cargo clippy
make test         # cargo test
make ci           # full local CI gate (mirrors GitHub Actions)
make sbom         # generate CycloneDX SBOMs
```
