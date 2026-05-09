#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# update.sh — pull a new release, rebuild, run component check, swap in.
#
# Safe to run on a live server. We bring up the new images alongside
# the old ones, run the OK/NG check, and only swap traffic over if
# everything reports OK. On NG we leave the old images running.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

require_file .env "cp .env.example .env  &&  \$EDITOR .env"
require_docker

step "git pull (fast-forward only)"
git pull --ff-only \
    || die "git pull failed (uncommitted changes?)" \
           "stash or commit your local edits first"

# v0.0.54 — auto-heal legacy .env files. Pre-v0.0.33 .env files (and
# operator-managed copies that predate v0.0.33's R1-1/R1-2 SNI router
# introduction) may be missing PANEL_DOMAIN entirely, and may set
# APP_URL=https://${DOMAIN}/admin (apex hostname). Both forms cause
# Livewire 3's origin-check middleware to return 419 PAGE EXPIRED on
# every Filament form submit because the browser's Origin header
# (panel.<base>) doesn't match the configured app URL host (apex).
#
# Fixed idempotently — every check is a no-op on already-canonical
# .env files. Mirrors install.sh's first-bootstrap PANEL_DOMAIN logic
# for the upgrade path that never re-runs install.sh, and additionally
# corrects the legacy APP_URL=${DOMAIN} → ${PANEL_DOMAIN} substitution
# install.sh never handled.
#
# v0.0.68 — canonical placement of the inserted PANEL_DOMAIN line.
# Pre-v0.0.68 the backfill used `>> .env`, leaving PANEL_DOMAIN at
# file-end. docker compose's `.env` parser interpolates ${VAR}
# references top-down; with .env.example's canonical
# `APP_URL=https://${PANEL_DOMAIN}/admin` (line 52) appearing far
# above the appended PANEL_DOMAIN definition, every
# `docker compose ...` invocation warned
#     The "PANEL_DOMAIN" variable is not set. Defaulting to a blank
#     string.
# (three times per call — once per substitution pass) and the panel
# container booted with APP_URL=https:///admin. Filament/Livewire then
# emitted broken redirect URLs and 419'd on every form submit. Phase 1
# now inserts directly after the DOMAIN= line; phase 2 relocates an
# already-misplaced PANEL_DOMAIN for operators upgrading from a
# pre-v0.0.68 build that already ran the buggy migration. Both phases
# are idempotent on already-canonical .env files.
step "Auto-migrate legacy .env (PANEL_DOMAIN canonical placement + APP_URL hostname)"
LEGACY_DOMAIN=$(grep -E '^DOMAIN=' .env | head -n1 | cut -d= -f2- | tr -d '"')

# Phase 1 — backfill PANEL_DOMAIN immediately after DOMAIN= when missing.
if ! grep -qE '^PANEL_DOMAIN=' .env; then
    if [ -n "${LEGACY_DOMAIN:-}" ]; then
        derived="panel.${LEGACY_DOMAIN}"
        awk -v val="$derived" '
            { print }
            /^DOMAIN=/ && !inserted {
                print "# v0.0.54 auto-migration — PANEL_DOMAIN added (was missing in pre-v0.0.33 .env)"
                print "PANEL_DOMAIN=" val
                inserted = 1
            }
        ' .env > .env.tmp && mv .env.tmp .env
        ok "added PANEL_DOMAIN=${derived} after DOMAIN= in .env"
    else
        warn "DOMAIN missing in .env — cannot auto-derive PANEL_DOMAIN; manual fix required"
    fi
else
    ok "PANEL_DOMAIN already present in .env"
fi

# Phase 2 — relocate PANEL_DOMAIN if it sits AFTER any non-comment line
# that interpolates ${PANEL_DOMAIN}. Catches operators upgrading from
# the pre-v0.0.68 buggy migration. Comments are excluded so the
# canonical .env.example header block (which references ${PANEL_DOMAIN}
# above the definition for documentation purposes) doesn't trip a
# false positive on a fresh-from-template .env.
panel_line=$(awk '/^PANEL_DOMAIN=/{print NR; exit}' .env)
ref_line=$(awk '!/^[[:space:]]*#/ && /\$\{PANEL_DOMAIN\}/{print NR; exit}' .env)
if [ -n "${panel_line:-}" ] && [ -n "${ref_line:-}" ] && [ "$panel_line" -gt "$ref_line" ]; then
    panel_val=$(awk -F= '/^PANEL_DOMAIN=/{sub("^[^=]*=",""); print; exit}' .env)
    awk -v val="$panel_val" '
        /^PANEL_DOMAIN=/ { next }
        { print }
        /^DOMAIN=/ && !inserted { print "PANEL_DOMAIN=" val; inserted = 1 }
    ' .env > .env.tmp && mv .env.tmp .env
    ok "relocated PANEL_DOMAIN to precede \${PANEL_DOMAIN} reference (was line ${panel_line}, ref at line ${ref_line})"
fi

# APP_URL ${DOMAIN} → ${PANEL_DOMAIN} correction.
if grep -qE '^APP_URL=https?://\$\{DOMAIN\}' .env; then
    # shellcheck disable=SC2016
    # ^ literal ${PANEL_DOMAIN} on purpose — phpdotenv expands it at PHP
    # boot, not bash here.
    sed -i.bak -E 's|^(APP_URL=https?://)\$\{DOMAIN\}|\1${PANEL_DOMAIN}|' .env
    rm -f .env.bak
    ok "APP_URL legacy form (\${DOMAIN}) corrected to \${PANEL_DOMAIN}"
else
    ok "APP_URL already canonical"
fi

step "Rebuild ct-server-core (Rust)"
compose --profile build-only build core-builder

step "Rebuild sing-box + panel + haproxy"
# v0.0.44 added haproxy to this list. The haproxy 2.9 → 3.0 hardening
# upgrade lands as a Dockerfile FROM bump (2.9-alpine → 3.0-alpine);
# without an explicit `compose build haproxy` here, the operator's
# `make update` would leave the haproxy container running the prior
# image while the Dockerfile change sits unbuilt — the v0.0.43
# drift-detection probe would then trip VersionMismatch indefinitely.
# Adding haproxy to the build set keeps the existing rebuild-then-
# swap discipline intact for any future haproxy-side change too.
compose build sing-box panel haproxy

# IMPORTANT — order: bring new image up BEFORE running migrations.
# Pre-v0.0.15 update.sh ran `php artisan migrate` against the
# OLD panel container while the new code lived only in the
# bind-mounted source tree. New migrations applied via the OLD
# PHP runtime — the OLD code then briefly executed against the
# new schema (or vice versa, depending on the migration shape),
# producing a window where queue workers and the scheduler could
# read columns that didn't exist yet, or write to columns whose
# constraints had just changed. Today's migrations happen to be
# additive-with-defaults (safe in either order), but the order
# here is fragile by accident; pin it.
# v0.0.51 — defensive chown of the haproxy_admin volume's root.
# Pre-v0.0.51 the volume was created with root:root ownership,
# which caused HAProxy (running as the haproxy user post-privilege-
# drop) to fail with "cannot bind UNIX socket (Permission denied)"
# on the v0.0.43 stats-socket directive. v0.0.51's haproxy
# Dockerfile pre-creates the directory with the right ownership for
# fresh volumes, but Docker's named-volume initialisation does NOT
# overwrite an existing volume's contents — so upgrade paths from
# v0.0.43..v0.0.50 still need the chown applied to the existing
# volume. Idempotent: a no-op when ownership is already correct.
# Quiet-skipped when the volume doesn't exist yet (first-ever
# deploy — Dockerfile handles that case).
step "Ensure haproxy_admin volume ownership (one-time fix for pre-v0.0.51 deploys)"
HAPROXY_VOL=$(docker volume ls --format '{{.Name}}' | grep -E '_haproxy_admin$' | head -n1)
if [ -n "${HAPROXY_VOL:-}" ]; then
    if docker run --rm --user root --entrypoint chown \
            -v "${HAPROXY_VOL}":/v \
            haproxy:3.0.21-alpine \
            -R haproxy:haproxy /v 2>/dev/null; then
        ok "haproxy_admin ownership verified"
    else
        ok "haproxy_admin chown skipped (volume may be empty or already correct)"
    fi
else
    ok "haproxy_admin volume not yet created (fresh deploy)"
fi

step "Bring new panel image up (entrypoint runs migrate + render)"
# v0.0.51 added haproxy to this list. v0.0.44 added haproxy to the
# `compose build` list above but missed it here; without
# `compose up -d haproxy` the rebuilt image just sits cached while
# the running container persists with whatever state it had before
# — including the old haproxy.cfg without the v0.0.43 stats-socket
# directive. The drift probe then trips VerifyFailed on every
# component check, and the operator has to manually `docker compose
# up -d haproxy` to recover.
compose up -d panel sing-box haproxy

# The panel code is bind-mounted from ./panel, while Laravel's
# bootstrap/cache lives under that same mount and can carry a cached
# config.php from the previous release. `compose up -d` returns after
# the container starts, not after entrypoint.sh has re-run package
# discovery and rebuilt config/route/view caches. Running the
# component drift probe before the sentinel races that cache rebuild;
# the panel row can report the prior release even though the new code
# is present. Wait for the entrypoint contract before all post-swap
# probes and renders.
WAIT_FOR_HINT="docker compose logs --tail=120 panel" \
    wait_for "panel entrypoint sentinel" 90 5 \
    bash -c 'docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete'

step "Verify migrations applied (idempotent re-run)"
compose exec -T panel php artisan migrate --force --no-interaction

step "Re-render sing-box config"
compose exec -T panel ct-server-core --json singbox render

step "Re-render haproxy config (v0.0.51)"
# Mirrors the sing-box render step above. Pre-v0.0.51 the haproxy
# render only fired when ServerConfig was mutated (Eloquent
# booted/updated event in app/Models/ServerConfig.php), which
# meant the v0.0.43 cfg.tpl change to add the stats-socket
# directive sat dormant for any operator who didn't happen to edit
# ServerConfig between releases. Forcing the render here closes
# that gap.
compose exec -T panel ct-server-core haproxy render

step "Reload haproxy (SIGHUP — graceful re-exec)"
# HAProxy in master-worker mode (default haproxy:alpine entrypoint
# uses `-W -db`) reloads on SIGHUP: master spawns a new worker
# with the new cfg, drains the old worker's existing connections
# (timeout: see backend `timeout client/server`), then exits the
# old worker. Connection-preserving, no downtime. If the new cfg
# is invalid, the master keeps the old worker running and logs an
# alert — fail-safe.
compose kill -s HUP haproxy

step "Component check (post-swap)"
component_check_strict /srv/manifests \
    || die "post-swap check NG — investigate logs" \
           "docker compose logs --tail=100 panel sing-box haproxy"

step "Reload sing-box via clash API"
compose exec -T panel ct-server-core server reload

ok "Update complete."
