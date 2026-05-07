#!/usr/bin/env bash
# verify_supervisord.sh — pin the round-6 lifecycle invariants on
# docker/panel/supervisord.conf.
#
# Round 6 (PR #13) hardened all four supervisord programs
# (frankenphp, queue, scheduler, ct-core-daemon) with a uniform
# graceful-shutdown discipline so `docker compose stop` drains
# requests cleanly instead of getting SIGKILL'd by the cgroup at
# the 10s grace window:
#
#   stopsignal   = TERM
#   stopwaitsecs = 20
#   killasgroup  = true
#   stopasgroup  = true
#
# Plus, the frankenphp program carries `MAX_REQUESTS=500` as the
# per-worker recycle ceiling (mirrors the prior FPM
# `pm.max_requests`).
#
# These four-plus-one attrs are easy to drop accidentally in a
# future supervisord.conf edit (rename a program, copy-paste a new
# one, comment out a line "to debug"). The result wouldn't break
# any test — supervisord still works — but `docker compose stop`
# would lose in-flight requests on the affected program. This
# script is a one-shot drift detector wired into `make ci`.
#
# Round-22 process-lifecycle audit.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

CONF="docker/panel/supervisord.conf"
[[ -f "$CONF" ]] || { echo "verify_supervisord: $CONF not found" >&2; exit 1; }

# Required uniform attributes across every [program:*] block.
required_attrs=(
    "stopsignal *= *TERM"
    "stopwaitsecs *= *20"
    "killasgroup *= *true"
    "stopasgroup *= *true"
)

# Per-program required attributes — pipe-separated entries of
# `program|literal`. Avoids `declare -A` so the script runs on
# bash 3.2 (macOS default) as well as bash 4+ (Linux). Add an
# entry when a future round bakes in another program-specific
# invariant.
program_specific_attrs=(
    "frankenphp|MAX_REQUESTS=500"
)

# Extract program names — each `[program:NAME]` line. Read into an
# indexed array via a while-read loop instead of `mapfile`, which
# is bash-4-only (macOS ships bash 3.2 by default).
programs=()
while IFS= read -r line; do
    programs+=("$line")
done < <(grep -E '^\[program:[^]]+\]' "$CONF" | sed -E 's/\[program:([^]]+)\]/\1/')

if [[ ${#programs[@]} -eq 0 ]]; then
    echo "verify_supervisord: no [program:*] blocks found in $CONF" >&2
    exit 1
fi

echo "verify_supervisord: ${#programs[@]} programs found — ${programs[*]}"

failed=0

# Walk each program block (everything between [program:NAME] and
# the next [section] or EOF) and check for required attributes.
for prog in "${programs[@]}"; do
    block=$(awk -v target="[program:$prog]" '
        $0 == target { inside = 1; next }
        /^\[/ && inside { exit }
        inside { print }
    ' "$CONF")

    for attr in "${required_attrs[@]}"; do
        if ! printf '%s\n' "$block" | grep -qE "^[[:space:]]*${attr}[[:space:]]*$"; then
            echo "  ✗ [$prog] missing required attribute: ${attr}" >&2
            failed=1
        fi
    done

    for entry in "${program_specific_attrs[@]}"; do
        entry_prog="${entry%%|*}"
        entry_attr="${entry#*|}"
        if [[ "$entry_prog" == "$prog" ]]; then
            if ! printf '%s\n' "$block" | grep -qF "$entry_attr"; then
                echo "  ✗ [$prog] missing program-specific attribute: ${entry_attr}" >&2
                failed=1
            fi
        fi
    done
done

if [[ $failed -ne 0 ]]; then
    cat >&2 <<EOF

verify_supervisord: lifecycle invariants drift detected.
The round-6 ops audit pinned these so that \`docker compose stop\`
drains in-flight requests cleanly instead of being SIGKILL'd by
the cgroup. Restore the missing attribute(s), or — if you
intentionally changed the policy — update this script.
EOF
    exit 1
fi

echo "verify_supervisord: all lifecycle invariants intact"
