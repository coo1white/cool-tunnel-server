#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# auto_sync.sh — credential-lock auto-audit-and-correct agent.
#
# Runs the `ct-server-core guard credential-lock` invariant
# (db == rendered == manifest == mac-config). If the four
# surfaces have drifted, attempts to bring them back into sync
# by re-rendering the sing-box config and restarting the
# container. Re-verifies after the fix.
#
# Usage:
#
#   ./scripts/auto_sync.sh         # one-shot audit + correct
#   make auto-sync                 # same, via Makefile
#
# Also runs every 5 min via Laravel's scheduler (see
# `panel/routes/console.php`) as a self-healing safety net
# distinct from the existing `singbox:render --if-changed --reload`
# task. Both fire in the same cadence; this one uses the explicit
# credential-lock guard surface, the other re-renders blindly.
#
# Exit codes:
#   0    no drift, OR drift was detected and successfully corrected
#   1    drift was detected and the correction failed (operator
#        needs to investigate manually — paste the script output)
#
# This script is read-mostly: it only writes (a) the rendered
# sing-box config file (when drift is detected), and (b) restarts
# the sing-box container. Safe to run frequently.
#
# Companion to:
#   scripts/doctor.sh           operator-friendly health dashboard
#                               (run when you want to LOOK; auto-sync
#                               is run when you want to ACT)
#   ct-server-core guard credential-lock
#                               the underlying invariant check
#                               (read-only; this script wraps it
#                               with corrective action)

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '[%s] auto-sync: %s\n' "$(ts)" "$*"; }

# ---------- 1. Initial audit -------------------------------------

guard_output=$(mktemp)
trap 'rm -f "$guard_output"' EXIT

if docker compose exec -T panel ct-server-core guard credential-lock \
        >"$guard_output" 2>&1; then
    # All four surfaces consistent. Quiet success — operators tail
    # the log if they want a heartbeat, but no action is needed.
    say "no drift detected — $(tr -d '\n' <"$guard_output" | head -c 200)"
    exit 0
fi

# ---------- 2. Drift detected — log + remediate ------------------

say "DRIFT DETECTED — credential-lock guard reported:"
sed 's/^/    /' <"$guard_output"

say "attempting corrective action — re-rendering sing-box config"
render_out=$(mktemp)
trap 'rm -f "$guard_output" "$render_out"' EXIT
if ! docker compose exec -T panel ct-server-core --json singbox render \
        >"$render_out" 2>&1; then
    say "FAILED to re-render sing-box config:"
    sed 's/^/    /' <"$render_out"
    say "manual investigation required — paste the above to operator"
    exit 1
fi
say "render output: $(tr -d '\n' <"$render_out" | head -c 200)"

say "restarting sing-box container so the new config takes effect"
if ! docker compose restart sing-box >/dev/null 2>&1; then
    say "FAILED to restart sing-box container"
    say "manual investigation required — try: docker compose ps sing-box"
    exit 1
fi

# Brief settle window before re-verification. sing-box restart is
# fast (typically <2s) but the naive inbound takes a moment to
# bind. Less than 5s is risky on a 1-vCPU box under load.
sleep 5

# ---------- 3. Re-verify ----------------------------------------

if docker compose exec -T panel ct-server-core guard credential-lock \
        >"$guard_output" 2>&1; then
    say "CORRECTED — credential-lock now reports OK:"
    sed 's/^/    /' <"$guard_output"
    say "auto-sync action complete. Drift was caught + resolved."
    exit 0
fi

say "STILL DRIFT after correction — credential-lock guard still reports:"
sed 's/^/    /' <"$guard_output"
say "manual investigation required. Most likely causes:"
say "  - panel container can't decrypt password_cleartext_encrypted (APP_KEY rotation?)"
say "  - sing-box config volume has different mount than the renderer writes to"
say "  - a writer (Filament UI?) is mutating the row between render and verify"
say "  - the sing-box restart did not pick up the new config (check container logs)"
exit 1
