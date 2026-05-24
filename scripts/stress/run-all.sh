#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# run-all.sh — release-gate stress test orchestrator.
#
# Runs every stress test in scripts/stress/[a-z]_*.sh against the
# live stack on this VPS. Each individual test:
#   - prints its goal
#   - runs in a bounded time budget
#   - emits PASS / FAIL with a one-line reason
#   - writes a JSON artifact to results/<timestamp>/
#
# Usage:
#   ./scripts/stress/run-all.sh             # full battery
#   ./scripts/stress/run-all.sh a c g       # only A, C, G
#
# Exit code: 0 if all run tests passed, non-zero count of failures
# otherwise. Designed to be a release gate: green run-all = OK to
# tag the next semver bump.
#
# Reproducibility contract: each test depends ONLY on:
#   - the live stack as currently brought up by docker compose
#   - an initialized admin database with an owner created via bootstrap
#   - one stress-test proxy account auto-provisioned on first run
#     (username "stress-runner", regenerated each invocation)
# Nothing on the host (no rust, no cargo). All workload generators
# (wrk, vegeta, iperf3) run inside ephemeral docker containers
# attached to the project's ct-net network so they reach the
# server the same way a real client would.

set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

# shellcheck source=../lib.sh
. scripts/lib.sh

require_file .env "stress tests need a populated .env"
require_docker
load_env .env

DOMAIN_OK="${DOMAIN:-}"
if [[ -z "$DOMAIN_OK" || "$DOMAIN_OK" == "proxy.example.com" ]]; then
    die "DOMAIN unset or placeholder; stress tests need a real domain" \
        "edit .env to set DOMAIN=your.real.domain"
fi

ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
out_dir="results/stress/${ts}"
mkdir -p "$out_dir"

# Filter argument list: empty = all tests, otherwise = letter codes.
selected=("$@")

discover_tests() {
    find scripts/stress -maxdepth 1 -name '[a-z]_*.sh' -type f | sort
}

is_selected() {
    local letter="$1"
    if [[ ${#selected[@]} -eq 0 ]]; then return 0; fi
    for s in "${selected[@]}"; do
        [[ "${s,,}" == "${letter,,}" ]] && return 0
    done
    return 1
}

passed=0
failed=0
skipped=0
failed_tests=()
tests=()
while IFS= read -r tpath; do
    tests+=("$tpath")
done < <(discover_tests)

if [[ ${#tests[@]} -eq 0 ]]; then
    warn "no live stress tests are currently enabled; use ct doctor and CI gates for this release"
fi

for tpath in "${tests[@]}"; do
    fname=$(basename "$tpath" .sh)        # e.g. a_connections
    letter=${fname%%_*}                   # a
    label=${fname#*_}                     # connections

    if ! is_selected "$letter"; then
        skipped=$((skipped + 1))
        continue
    fi

    step "Stress test [$letter] $label"
    log_file="$out_dir/${fname}.log"
    json_file="$out_dir/${fname}.json"
    if STRESS_OUT_JSON="$json_file" \
       STRESS_OUT_DIR="$out_dir" \
       bash "$tpath" 2>&1 | tee "$log_file" >&2; then
        ok "PASS [$letter] $label  (log: $log_file)"
        passed=$((passed + 1))
    else
        warn "FAIL [$letter] $label  (log: $log_file)"
        failed=$((failed + 1))
        failed_tests+=("$letter:$label")
    fi
    echo ""
done

# ---------- Summary ------------------------------------------------

step "Summary"
echo "    out:     $out_dir"
echo "    passed:  $passed"
echo "    failed:  $failed"
echo "    skipped: $skipped"
if [[ $failed -gt 0 ]]; then
    echo ""
    echo "    failed tests:"
    for t in "${failed_tests[@]}"; do
        echo "      - $t"
    done
fi

# Aggregate JSON for Mac-Claude / CI to parse.
agg="$out_dir/summary.json"
{
    echo '{'
    echo "  \"timestamp\": \"$ts\","
    echo "  \"domain\": \"$DOMAIN_OK\","
    echo "  \"passed\": $passed,"
    echo "  \"failed\": $failed,"
    echo "  \"skipped\": $skipped,"
    echo '  "tests": ['
    first=1
    for j in "$out_dir"/*.json; do
        [[ -f "$j" ]] || continue
        [[ "$j" == "$agg" ]] && continue
        if [[ $first -eq 0 ]]; then echo "    ,"; fi
        cat "$j"
        first=0
    done
    echo '  ]'
    echo '}'
} > "$agg"
ok "summary written to $agg"

exit "$failed"
