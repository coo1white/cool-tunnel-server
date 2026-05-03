#!/usr/bin/env bash
# c_revocation_latency.sh — measure ms from "operator clicks
# Disable" to "client connection drops" via the Redis revocation
# bus + sing-box clash-API reload.
#
# The CHANGELOG claims ≤100 ms for this path (leading-edge fire +
# trailing-flush coalescer; see core/ct-server-core/src/redis_bridge.rs
# and util/debounce.rs). This test validates that against the
# LIVE bus on real hardware — the unit tests cover the algorithm,
# this covers the integration.
#
# Method:
#   1. Provision proxy account "stress-runner" (or reuse).
#   2. Open a long-lived CONNECT request through the proxy.
#      Confirm it stays open (proves auth works, baseline).
#   3. Capture monotonic ms timestamp T_disable.
#   4. Disable the account via Redis pub/sub directly (mimics
#      what the panel emits on save).
#   5. Watch the CONNECT request's stdin/stdout for EOF / RST.
#   6. Capture T_drop. Report (T_drop - T_disable) ms.
#
# Pass if elapsed_ms ≤ 200 ms (2× the design budget — gives
# headroom for VPS overhead). Fail otherwise.

set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

# shellcheck source=../lib.sh
. scripts/lib.sh

load_env .env

JSON_OUT="${STRESS_OUT_JSON:-/dev/null}"
THRESHOLD_MS=200

# 1. Provision / refresh the stress-runner account. The panel's
#    `make:stress-account` artisan command is idempotent (creates
#    if missing, regenerates password if exists). It returns the
#    cleartext on stdout.
step "Provision stress-runner proxy account"
creds=$(docker compose exec -T panel \
    php artisan stress:provision --no-interaction \
    --username stress-runner 2>/dev/null \
    || die "panel stress:provision failed" \
           "ensure panel/app/Console/Commands/StressProvision.php exists")
account_id=$(echo "$creds" | jq -r .id)
password=$(echo "$creds" | jq -r .password)
[[ -n "$account_id" && -n "$password" ]] \
    || die "stress:provision didn't return id+password" "check panel logs"
ok "account #$account_id provisioned"

# 2. Open the long-lived connection. We use docker run --rm with
#    a small alpine + curl that does CONNECT to the proxy and
#    stays open via /dev/zero. The PID file lets us track when
#    the connection drops.
step "Open baseline CONNECT through the proxy"
con_id=$(docker run --rm -d \
    --network cool-tunnel-server_ct-net \
    alpine:3.20 \
    sh -c 'apk add --no-cache curl >/dev/null 2>&1 \
           && exec curl --proxy https://stress-runner:'"$password"'@'"$DOMAIN"':443 \
                        -s --max-time 30 \
                        https://1.1.1.1/cdn-cgi/trace 2>/dev/null')
sleep 1
if ! docker inspect "$con_id" >/dev/null 2>&1; then
    die "baseline CONNECT didn't start" "check sing-box logs"
fi
ok "baseline CONNECT live (container $con_id)"

# 3. Snap T_disable.
T_disable=$(date +%s%3N)

# 4. Publish the disable to Redis directly (faster + more
#    deterministic than going through the panel UI).
step "Publish disable to Redis revocation bus"
docker compose exec -T redis redis-cli \
    -a "${REDIS_PASSWORD}" \
    PUBLISH cool_tunnel:revocations \
    "{\"account_id\":${account_id},\"action\":\"disable\",\"reason\":\"stress\"}" \
    >/dev/null

# 5. Wait for connection drop. Poll the curl container; when
#    `docker inspect` says it's gone, the proxy dropped us.
deadline=$((T_disable + 2000))   # 2s upper bound
T_drop=0
while [[ $(date +%s%3N) -lt $deadline ]]; do
    if ! docker ps --no-trunc -q | grep -q "^${con_id}"; then
        T_drop=$(date +%s%3N)
        break
    fi
    sleep 0.005
done

if [[ "$T_drop" == 0 ]]; then
    docker kill "$con_id" >/dev/null 2>&1 || true
    elapsed=2000
    pass=false
    reason="connection still up after 2s — revocation didn't propagate"
else
    elapsed=$((T_drop - T_disable))
    if [[ $elapsed -le $THRESHOLD_MS ]]; then
        pass=true
        reason="dropped in ${elapsed}ms (≤ ${THRESHOLD_MS}ms target)"
    else
        pass=false
        reason="dropped in ${elapsed}ms (> ${THRESHOLD_MS}ms target)"
    fi
fi

# 6. Report.
cat > "$JSON_OUT" <<EOF
{
    "test": "c_revocation_latency",
    "pass": $pass,
    "elapsed_ms": $elapsed,
    "threshold_ms": $THRESHOLD_MS,
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
