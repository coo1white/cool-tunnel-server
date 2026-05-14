#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# auto_update.sh — unattended Cool Tunnel release-pulling agent.
#
# When invoked, this script:
#   1. Fetches the latest release tag from origin/main.
#   2. Compares it against the currently-deployed release.
#   3. If the deployed version is older AND the running stack is
#      healthy, runs the standard ./scripts/update.sh path.
#   4. Logs every decision so an operator tailing the log can see
#      exactly why the agent did (or didn't) act.
#
# Designed to be safe-to-cron: takes an exclusive flock so two
# concurrent runs can't race, aborts on an already-broken stack
# (we won't auto-roll over an existing incident), and uses
# component-check to verify post-update health.
#
# Usage:
#
#   ./scripts/auto_update.sh                # interactive verbose
#   ./scripts/auto_update.sh --quiet        # cron-friendly (only errors)
#   ./scripts/auto_update.sh --dry-run      # report decision, no act
#
# Companions:
#
#   ct auto-update enable     adds /etc/cron.daily symlink (calls
#                             this script with --quiet at ~6am)
#   ct auto-update disable    removes the symlink
#   ct auto-update status     ls the symlink + tail the log
#   ct auto-update now        runs this script interactively
#   make auto-update          same as `./scripts/auto_update.sh`
#
# Exit codes:
#   0    up to date, OR upgraded successfully
#   1    upgrade attempted and failed (operator needs to look)
#   2    refused to upgrade (stack already unhealthy, no network,
#        not a git checkout, etc.) -- operator needs to investigate
#        the underlying issue first (start with `ct fix`)
#
# Companion to scripts/fix.sh recipe `stale_deployment`, which is
# the INTERACTIVE catch-up path. Both call the same logic; this
# script is the cron-fired version.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Don't recursively suggest `ct fix` on our own die() calls — auto-update
# failures need their own error path, not a chain to the interactive agent.
export CT_NO_FIX_HINT=1

# shellcheck source=lib.sh
. scripts/lib.sh

QUIET=false
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --quiet|-q)   QUIET=true ;;
        --dry-run|-n) DRY_RUN=true ;;
        --help|-h)
            sed -n '2,30p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            printf 'auto_update.sh: unknown flag: %s\n' "$arg" >&2
            exit 2
            ;;
    esac
done

# ---------- I/O helpers ------------------------------------------

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() {
    [[ "$QUIET" == true ]] && return 0
    printf '[%s] auto-update: %s\n' "$(ts)" "$*"
}
warn_au() {
    printf '[%s] auto-update: ! %s\n' "$(ts)" "$*" >&2
}
err_au() {
    printf '[%s] auto-update: ✗ %s\n' "$(ts)" "$*" >&2
}

# ---------- Single-flight lock -----------------------------------

LOCK_PATH=/var/lock/cool-tunnel-auto-update.lock
if [[ ! -w /var/lock ]]; then
    LOCK_PATH=/tmp/cool-tunnel-auto-update.lock
fi
exec 9>"$LOCK_PATH" || { err_au "cannot open lock $LOCK_PATH"; exit 2; }
if ! flock -n 9; then
    say "another auto-update is already running -- skipping this tick"
    exit 0
fi

# ---------- 1. Network reachable? --------------------------------

if ! git fetch --quiet --tags origin 2>/dev/null; then
    err_au "cannot reach origin (network blip, github outage, or repo unconfigured)"
    err_au "skipping this tick; will retry on next cron cycle"
    exit 2
fi

# ---------- 2. Compare versions ----------------------------------

latest_tag=$(git describe --tags --abbrev=0 origin/main 2>/dev/null || true)
if [[ -z "$latest_tag" ]]; then
    err_au "no release tags found on origin/main; nothing to compare against"
    exit 2
fi

current_version=$(grep -E "^\s*'version'\s*=>" panel/config/cool-tunnel.php 2>/dev/null \
    | head -1 | sed -E "s/.*'([0-9.]+)'.*/\1/")
if [[ -z "$current_version" ]]; then
    err_au "could not read 'version' from panel/config/cool-tunnel.php"
    exit 2
fi

# Strip leading 'v' from the tag for an apples-to-apples compare.
latest_version=${latest_tag#v}

if [[ "$latest_version" == "$current_version" ]]; then
    say "up to date (deployed=${current_version}, latest=${latest_tag}) -- nothing to do"
    exit 0
fi

say "upgrade available: ${current_version} -> ${latest_version} (tag ${latest_tag})"

if [[ "$DRY_RUN" == true ]]; then
    say "(dry-run) would now: git pull --ff-only && ./scripts/update.sh"
    say "(dry-run) exit 0"
    exit 0
fi

# ---------- 3. Pre-flight: is the stack healthy right now? -------
#
# We refuse to layer a release upgrade on top of an existing
# incident. If the running stack is already broken, the operator
# needs to fix THAT first (via ct fix or doctor) before an
# unattended agent compounds the issue.

if ! docker compose ps --status running --services 2>/dev/null \
        | grep -q '^panel$'; then
    err_au "stack pre-flight: panel container is not running"
    err_au "refusing to auto-upgrade an unhealthy stack -- run 'ct fix' first"
    exit 2
fi

# Quick component-check sanity (the strict version is in update.sh
# itself; this is a cheaper pre-flight). If credential-lock guard
# reports drift, we refuse — that's a state worth investigating
# manually.
if ! docker compose exec -T panel ct-server-core guard credential-lock \
        >/dev/null 2>&1; then
    err_au "stack pre-flight: credential-lock guard reports NG"
    err_au "refusing to auto-upgrade -- run 'ct fix' (recipe credential_drift)"
    exit 2
fi

say "pre-flight OK (panel running, credential-lock OK) -- proceeding"

# ---------- 4. Pull + update -------------------------------------

if ! git pull --ff-only origin main 2>&1 | sed 's/^/    /'; then
    err_au "git pull --ff-only failed -- working tree may have local changes"
    err_au "left at the prior release; investigate with 'git status'"
    exit 1
fi

# update.sh exit code reflects build / migration / component-check.
# We pipe stdout through `sed` to indent for readability when the
# operator is watching live; in --quiet mode we suppress stdout
# entirely (errors still flow through stderr).
if [[ "$QUIET" == true ]]; then
    if ! ./scripts/update.sh >/dev/null 2>&1; then
        err_au "./scripts/update.sh failed -- stack may be in a partial state"
        err_au "re-run interactively: ct update   (or: ct fix to walk the recipes)"
        exit 1
    fi
else
    if ! ./scripts/update.sh 2>&1 | sed 's/^/    /'; then
        err_au "./scripts/update.sh failed -- stack may be in a partial state"
        err_au "re-run interactively: ct update   (or: ct fix to walk the recipes)"
        exit 1
    fi
fi

# ---------- 5. Post-update sanity --------------------------------

new_version=$(grep -E "^\s*'version'\s*=>" panel/config/cool-tunnel.php 2>/dev/null \
    | head -1 | sed -E "s/.*'([0-9.]+)'.*/\1/")
say "upgraded: ${current_version} -> ${new_version} -- complete."
exit 0
