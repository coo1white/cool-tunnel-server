#!/usr/bin/env bash
# g_anti_tracking_probe.sh — verify the anti-tracking guarantees
# (hide_ip, hide_via, probe_resistance) actually work end-to-end
# against a public echo endpoint.
#
# Wraps `ct-server-core probe anti-tracking` (already shipped) and
# turns its JSON output into a stress-test pass/fail.
#
# Pass criteria:
#   - reachable             == true
#   - hide_ip_effective     == true
#   - hide_via_effective    == true
#   - probe_resistance_eff. == true (only when ServerConfig has it on)

set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

# shellcheck source=../lib.sh
. scripts/lib.sh
load_env .env

JSON_OUT="${STRESS_OUT_JSON:-/dev/null}"

step "Provision stress-runner credentials"
creds=$(docker compose exec -T panel \
    php artisan stress:provision --no-interaction \
    --username stress-runner 2>/dev/null) \
    || die "panel stress:provision failed" "see C revocation test for setup"
password=$(echo "$creds" | jq -r .password)

via="https://stress-runner:${password}@${DOMAIN}:443"
target="https://ifconfig.co/json"

step "Run probe via ct-server-core (containerised)"
probe_json=$(docker compose exec -T panel \
    ct-server-core --json probe anti-tracking \
    --target "$target" \
    --via    "$via" 2>/dev/null) \
    || die "ct-server-core probe failed" \
           "docker compose logs panel | grep probe"

# Extract booleans.
reachable=$(echo "$probe_json" | jq -r .reachable)
hide_ip=$(echo "$probe_json" | jq -r .hide_ip_effective)
hide_via=$(echo "$probe_json" | jq -r .hide_via_effective)
probe_res=$(echo "$probe_json" | jq -r .probe_resistance_effective)

# Read the panel's intent for probe_resistance from ServerConfig.
want_probe_res=$(docker compose exec -T db mariadb \
    -u"${DB_USERNAME}" -p"${DB_PASSWORD}" "${DB_DATABASE}" \
    -N -B -e 'SELECT anti_tracking_probe_resistance FROM server_configs WHERE id=1' \
    2>/dev/null | tr -d '[:space:]')

fail_reasons=()
[[ "$reachable" == "true" ]] || fail_reasons+=("not reachable")
[[ "$hide_ip"   == "true" ]] || fail_reasons+=("hide_ip not effective")
[[ "$hide_via"  == "true" ]] || fail_reasons+=("hide_via not effective")
if [[ "$want_probe_res" == "1" ]]; then
    [[ "$probe_res" == "true" ]] || fail_reasons+=("probe_resistance enabled but not effective")
fi

if [[ ${#fail_reasons[@]} -eq 0 ]]; then
    pass=true
    reason="all anti-tracking guarantees verified end-to-end"
else
    pass=false
    reason=$(IFS=, ; echo "${fail_reasons[*]}")
fi

cat > "$JSON_OUT" <<EOF
{
    "test": "g_anti_tracking_probe",
    "pass": $pass,
    "reachable": $reachable,
    "hide_ip_effective": $hide_ip,
    "hide_via_effective": $hide_via,
    "probe_resistance_effective": $probe_res,
    "probe_resistance_intended": $( [[ "$want_probe_res" == "1" ]] && echo true || echo false ),
    "reason": "$reason"
}
EOF

if [[ "$pass" == true ]]; then
    ok "$reason"
    exit 0
else
    warn "$reason"
    exit 1
fi
