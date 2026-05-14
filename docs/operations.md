# Operations — running it day-to-day

You've finished [GETTING_STARTED.md](../GETTING_STARTED.md) and your
proxy is live. This page is what to do next:

- [Daily checklist](#daily-checklist)
- [Updating to a new release](#updating-to-a-new-release)
- [Backing up](#backing-up)
- [Restoring from backup](#restoring-from-backup)
- [Looking at logs when something seems off](#looking-at-logs-when-something-seems-off)
- [Rotating passwords](#rotating-passwords)
- [Watching health over time](#watching-health-over-time)
- [Common problems and one-command fixes](#common-problems-and-one-command-fixes)
- [What `ct update` actually does](#what-ct-update-actually-does)
- [Command reference](#command-reference)

The examples below assume you added the `ct` shell shortcut from the
end of GETTING_STARTED.md. If you haven't, just `cd /opt/cool-tunnel-server`
first and use `make ...` in place of `ct ...`.

> Every script in `scripts/` also has a plain-English mini-manual:
> `make help-update`, `make help-doctor`, `make help-troubleshooting`,
> etc. Run `make help-topics` to see the list.

---

## Daily checklist

If you're checking in on the server in the morning, this is all you
need:

```sh
ct doctor
```

That prints a colour-coded PASS / WARN / FAIL dashboard across ~13
checks (DNS, ports, ACME cert expiry, container health, supervisord
programs, /up endpoint, component check, disk + RAM headroom). Any
FAIL row comes with a one-line "↳" hint at the bottom telling you
exactly what to run next.

Exit code 0 means everything is green or only warnings (no FAILs).
Cron-suitable.

For a stricter "is the system ready to publicly launch?" gate (≥9/10
checks PASS, structural fails cap the score at 7), use:

```sh
ct readiness
```

The two answer different questions. `doctor` shows you everything an
operator should glance at; `readiness` is the formal launch / post-
incident gate.

---

## Updating to a new release

The single most common operation. Run this whenever a new release is
announced (every few days during active development):

```sh
ct backup     # always FIRST — protects you if the update goes wrong
ct update     # pull + rebuild + restart — takes 1-10 minutes
ct doctor     # confirm everything still works
```

What `ct update` does, in plain terms:

1. **Pre-flight**: checks network reachability (github.com + Docker
   registry), disk headroom, stack is up, working tree is clean.
   If your tree has uncommitted edits (e.g. a hand-patched Dockerfile),
   it offers to stash / discard / abort.
2. **Locks** so no one else can run an update at the same time.
3. **Pulls** the latest code from GitHub (`git pull --ff-only`).
4. **Auto-migrates** legacy `.env` shape if needed (idempotent).
5. **Rebuilds** the Docker images (fast on second run thanks to
   buildkit caching).
6. **Brings up** the new panel image and waits for the entrypoint
   sentinel.
7. **Runs migrations** (no-op if nothing pending).
8. **Re-renders** sing-box config; asserts `db = rendered = manifest =
   mac-config` credential-lock invariant (refuses to proceed on drift,
   without printing passwords).
9. **Restarts** sing-box for a clean state purge.
10. **SIGHUPs** HAProxy for a graceful re-exec.
11. **Component check** on the post-swap runtime; reports any NG with
    a named component and per-component log-tail recipe.

✅ **Good**: ends with `✓ Update complete.` and `ct doctor` afterward
shows mostly PASS.

❌ **Bad**: every failure path now prints a multi-line `Diagnostic:`
block with what happened, why, and what to do next. The most common
classes:

| What you see | Why | What to do |
|--------------|-----|-----------|
| `uncommitted changes block git pull` | Working tree has local edits | Interactive prompt offers `[s]tash / [d]iscard / [a]bort`; pick stash if unsure |
| `network: cannot reach ...` | Outbound HTTPS broken from the VPS | Check the diagnostic block's command ladder (ping / dig / curl) |
| `low disk under repo path: NG free` | Build cache filled the disk | `docker system prune -af` typically reclaims 1-5 GB |
| `post-swap check NG: <component>` | A specific service didn't come up clean | The diagnostic block lists which component + the targeted `docker compose logs ...` to run |

If a build dies mid-way (panel image's `apk add` step is the most
expensive), it's usually disk pressure on the docker root, NOT OOM:

```sh
docker system prune -af && docker builder prune -af
df -h /var/lib/docker     # should be >= 4G free
ct update                  # retry
```

If you need to roll back to the previous known-good release:

```sh
git checkout v0.0.<X>      # the prior known-good tag
./scripts/update.sh        # rebuilds + redeploys that version
```

---

## Backing up

```sh
ct backup
```

Creates `backups/cool-tunnel-<UTC-timestamp>.tar.gz` containing:

- MariaDB dump (full schema + data)
- The `caddy_data` Docker volume (ACME certificates + private keys)
- The `haproxy_admin` volume
- Your `.env` (with all secrets)
- The current sing-box config template
- The current Caddyfile template

The tarball is mode 0600 by default. Two important things:

1. **The backup contains every password on your VPS** — `DB_PASSWORD`,
   `REDIS_PASSWORD`, `APP_KEY`. Treat it like a secret.
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
2. **Run `make install`** to bring up an empty stack (Steps 1-4 of
   GETTING_STARTED.md). This gets Docker + base images + an empty
   database.
3. **Copy your backup tarball** back to the new VPS:

   ```sh
   scp ~/backups/cool-tunnel/cool-tunnel-LATEST.tar.gz \
       root@new-vps:/opt/cool-tunnel-server/backups/
   ```
4. **Restore**:

   ```sh
   cd /opt/cool-tunnel-server
   ./scripts/restore.sh backups/cool-tunnel-LATEST.tar.gz
   ct doctor
   ```

You're back online with the same accounts, same passwords, same
SSL certs.

> **Destructive.** The DB import step drops + recreates the
> `cool_tunnel` schema. There's no "are you sure?" prompt — run with
> intent.

---

## Looking at logs when something seems off

```sh
# Last few minutes of the panel (the most-common place to look)
docker compose logs --tail=60 panel

# Same, but follow live (Ctrl+C to stop)
docker compose logs -f panel

# Just the errors, no info noise
docker compose logs --tail=200 panel \
  | grep -iE 'error|fatal|critical|warn'
```

Replace `panel` with one of: `singbox`, `caddy`, `haproxy`, `db`, `redis`.

Quick triage rules:

- **Panel restart-loops** → the entrypoint failed. Look for "composer
  install" errors, migration errors, or APP_KEY-missing in the panel
  log.
- **502 from the panel domain** → Caddy can't reach FrankenPHP. Check
  panel container is running (`docker compose ps panel`).
- **Subscription URLs don't reach sing-box** → SNI router misroute.
  Check `docker compose logs haproxy`.
- **Cert errors in browser** → Caddy ACME failure. Check
  `docker compose logs caddy | grep -iE 'acme|cert'`.

---

## Rotating passwords

Recommended cadence: every 90 days for `DB_PASSWORD` + `REDIS_PASSWORD`.
**Never rotate `APP_KEY`** — it encrypts every proxy account's stored
cleartext password; rotating it makes them all unreadable and breaks
every subscription URL.

> ⚠️ **Read the whole section before running anything.** Done wrong,
> the panel can't connect to its database and goes down. Done right,
> you have new secrets and ~30 seconds of downtime.

Always back up first:

```sh
ct backup
```

### Redis (lowest blast radius — do this first)

```sh
cd /opt/cool-tunnel-server
NEW=$(openssl rand -base64 32)
awk -v p="$NEW" '/^REDIS_PASSWORD=/ { print "REDIS_PASSWORD=" p; next } { print }' \
  .env > .env.tmp && mv .env.tmp .env && chmod 0600 .env
docker compose up -d --force-recreate redis panel
unset NEW; history -d $((HISTCMD-1)) 2>/dev/null
sleep 15 && ct doctor   # should be all PASS
```

### MariaDB

Order matters: update the database first, then `.env`, then restart.

```sh
cd /opt/cool-tunnel-server
NEW_DB=$(openssl rand -base64 32)
NEW_ROOT=$(openssl rand -base64 32)

# 1) Tell MariaDB about the new passwords (uses OLD root password from .env)
docker compose exec -T -e MYSQL_PWD="$(grep '^DB_ROOT_PASSWORD=' .env | cut -d= -f2-)" db \
  mariadb -u root -e "
    ALTER USER 'cooltunnel'@'%' IDENTIFIED BY '$NEW_DB';
    SET PASSWORD FOR 'root'@'%' = PASSWORD('$NEW_ROOT');
    SET PASSWORD FOR 'root'@'localhost' = PASSWORD('$NEW_ROOT');
    FLUSH PRIVILEGES;
  "

# 2) Update .env with the new values
awk -v db="$NEW_DB" -v dbroot="$NEW_ROOT" \
  '/^DB_PASSWORD=/      { print "DB_PASSWORD=" db; next }
   /^DB_ROOT_PASSWORD=/ { print "DB_ROOT_PASSWORD=" dbroot; next }
   { print }' \
  .env > .env.tmp && mv .env.tmp .env && chmod 0600 .env

# 3) Restart panel so it picks up the new DB_PASSWORD
docker compose up -d --force-recreate panel

# 4) Wipe new values from shell + verify
unset NEW_DB NEW_ROOT; history -d $((HISTCMD-1)) 2>/dev/null
sleep 15 && ct doctor
```

---

## Watching health over time

The Rust daemon can expose Prometheus-format metrics for Grafana,
Alertmanager, etc. Off by default.

To enable:

1. Edit `.env`, add: `CT_METRICS_BIND=127.0.0.1:9292`
2. `ct update` (or `docker compose restart panel`)
3. Scrape from inside the panel container:

   ```sh
   docker compose exec -T panel curl -fsS http://127.0.0.1:9292/metrics
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
| `credential-lock` reports NG | DB password and rendered config disagree | Re-run `ct update`; if it persists, the rotation playbook above probably wasn't run cleanly — restore from backup |
| Panel container restart-loops | Usually empty `APP_KEY`, wrong `OCTANE_SERVER`, or composer install failure | `docker compose logs --tail=80 panel` shows the exact line; reports starting with `[frankenphp-worker]` are the most informative |
| `doctor` shows `/up endpoint connection failed` | Panel container down or FrankenPHP crashed | `docker compose ps panel` + `docker compose logs --tail=80 panel` |
| `doctor` shows `Containers <N>/6 running` with one missing | One container failed | The diagnostic block lists which one + its log-tail command |
| `readiness` check 8 NG with `Redis URL did not parse` | You rotated `REDIS_PASSWORD` to a value with `/`, `+`, or `=` on a pre-v0.0.88 install | Upgrade to v0.0.88+ (`ct update`) or rotate to a hex-only value (`openssl rand -hex 32`) |
| Filament login returns `419 PAGE EXPIRED` on every form submit | Pre-v0.0.68 `.env` issue with `APP_URL` | `ct update` — auto-migration fixes it |
| Browser shows `ERR_SSL_PROTOCOL_ERROR` | Certificate hasn't been issued or expired | `docker compose logs caddy \| tail -40` shows the ACME error; usually DNS or port-80 reachability |
| Component drift (e.g. `mariadb` reports VersionMismatch) | Pinned version bumped in code | `ct update` brings everything in lockstep |

For deeper troubleshooting: [docs/operator-runbook.md](./operator-runbook.md).

For the operator-side mini-manual on each script:

```sh
make help-troubleshooting   # top 8 issues, ranked by frequency
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
5. Rebuilds the Rust core + panel + sing-box + HAProxy images.
   Subsequent runs hit the BuildKit cache and finish in seconds.
6. Brings the new panel image up and waits for the entrypoint
   sentinel.
7. Runs Laravel migrations (no-op if nothing pending).
8. Re-renders sing-box config; asserts `ct-server-core guard
   credential-lock` (`db = rendered = manifest = mac-config`) —
   refuses to proceed on drift, without printing passwords.
9. Restarts sing-box for a clean state purge.
10. SIGHUPs HAProxy for a graceful re-exec.
11. Component check on the post-swap runtime.

If anything fails mid-update, the `flock` auto-releases on script
exit and the whole script is idempotent — just re-run `ct update`.

---

## Command reference

The most-used `make` targets:

| Command | What it does |
|---------|--------------|
| `make doctor` | Health dashboard (PASS / WARN / FAIL + remediation hints) |
| `make readiness` | Strict ≥9/10 readiness gate (cron/CI suitable) |
| `make status` | Quick "are containers up?" check |
| `make components` | 12-row table of every dependency |
| `make update` | Pull, rebuild, migrate, render, verify, reload |
| `make backup` | Snapshot DB + .env + ACME state |
| `make install` | First-time bootstrap (idempotent on re-run) |
| `make logs` | Tail all container logs |
| `make help` | List all targets |
| `make help-topics` | List operator mini-manual topics |
| `make help-<topic>` | Print the mini-manual for one topic |

Developer gates:

```sh
make fmt          # cargo fmt --all
make lint         # cargo clippy
make test         # cargo test
make ci           # full local CI gate (mirrors GitHub Actions)
make sbom         # generate CycloneDX SBOMs
```
