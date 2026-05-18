#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# c_revocation_latency.sh — measure ms from "operator clicks
# Disable" to "the user is removed from sing-box's loaded config"
# via the Redis revocation bus + ct-singbox file-watch reload.
#
# The CHANGELOG claims ≤100 ms for this path (leading-edge fire +
# trailing-flush coalescer; see core/ct-server-core/src/redis_bridge.rs
# and util/debounce.rs). This test validates that against the
# LIVE bus on real hardware — the unit tests cover the algorithm,
# this covers the integration.
#
# Method:
#   1. Provision proxy account "stress-runner" (or reuse). The
#      panel's stress:provision command marks it enabled and
#      writes a fresh password.
#   2. Re-render the sing-box config so the new account is in
#      the on-disk users list. Confirm by grepping for the
#      username — that's our baseline signal.
#   3. Capture monotonic ms timestamp T_disable.
#   4. PUBLISH `{"kind":"account_changed","username":"stress-runner",...}`
#      to the cool_tunnel:revocations channel. The schema MUST
#      match RevocationMessage::AccountChanged in
#      core/ct-server-core/src/redis_bridge.rs — the daemon's
#      serde enum is `#[serde(tag = "kind")]`.
#   5. Poll the rendered config file at 5 ms cadence. The daemon
#      pipeline on a fired event is:
#           render() — DB → users → atomic-write config.json
#      We measure to the moment `stress-runner` is no longer in
#      the rendered file: that's the "user is gone" instant from
#      sing-box's perspective. The file is what ct-singbox's
#      supervisor watches, so it is the authoritative signal.
#   6. Capture T_drop. Report (T_drop - T_disable) ms.
#
# Why we don't measure via a long-lived CONNECT through the
# proxy: sing-box's `naive` inbound rejects every standard HTTP
# CONNECT with "missing naive padding" — the padding is core to
# the NaiveProxy anti-fingerprint design, and curl/reqwest don't
# speak it. A previous version of this test "looked like" it was
# observing connection drops but was actually timing apk-add +
# curl-fails-immediately, which had nothing to do with revocation
# and gave a flat ~600–1200 ms regardless of stack health. The
# config-file polling approach below tests the property the
# user-visible budget actually claims.
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
USERNAME=stress-runner

# Path on the host to the sing-box config volume. The volume is
# mounted into ct-singbox at /etc/sing-box/config.json; reading
# from /var/lib/docker/volumes/.../_data/config.json gives us the
# same bytes without paying a `docker exec` round-trip per poll
# (which itself runs ~30 ms and would dominate the measurement).
CONFIG_FILE="/var/lib/docker/volumes/cool-tunnel-server_singbox_etc/_data/config.json"
[[ -r "$CONFIG_FILE" ]] || die \
    "cannot read $CONFIG_FILE" \
    "the singbox_etc volume isn't mounted on this host or perms changed"

# 1. Provision / refresh the stress-runner account. The panel's
#    `stress:provision` artisan command is idempotent (creates if
#    missing, regenerates password if exists). It returns the
#    cleartext on stdout.
step "Provision stress-runner proxy account"
creds=$(docker compose exec -T panel \
    php artisan stress:provision --no-interaction \
    --username "$USERNAME" 2>/dev/null \
    || die "panel stress:provision failed" \
           "ensure panel/app/Console/Commands/StressProvision.php exists")
account_id=$(echo "$creds" | jq -r .id)
[[ -n "$account_id" && "$account_id" != "null" ]] \
    || die "stress:provision didn't return an id" "check panel logs"
ok "account #$account_id provisioned"

# 2. Force a fresh render so the account lands in the on-disk
#    config — stress:provision triggers this through the model
#    save event, but we redo it here to make the baseline
#    deterministic against any config-cache state.
step "Render sing-box config and confirm stress-runner is in users list"
docker compose exec -T panel \
    php artisan singbox:render >/dev/null 2>&1 \
    || die "singbox:render failed" "check panel logs"

if ! grep -q "\"username\":\"$USERNAME\"" "$CONFIG_FILE"; then
    head -c 500 "$CONFIG_FILE" >&2
    die "baseline render did not include $USERNAME" \
        "stress:provision may not have flipped enabled=1; inspect proxy_accounts in mariadb"
fi
ok "baseline confirmed — $USERNAME is in /etc/sing-box/config.json"

# 3. Flip the DB row to enabled=0 BEFORE measuring. We do this
#    via a raw UPDATE rather than `ProxyAccount::save()` so that
#    Eloquent's `saved` event (which would auto-publish on its
#    own and pollute the timer) doesn't fire. The next PUBLISH
#    we send below is the only event the daemon sees, and the
#    next render() will see enabled=0 in the DB and emit a
#    config without the user.
step "Mark stress-runner disabled in DB (raw UPDATE — no Eloquent event)"
# Password via MYSQL_PWD env, not -p"…" on argv (matches backup.sh's
# v0.0.17 hardening — the secret never lands in `ps -ef` inside the
# db container or in host-visible docker exec argv).
docker compose exec -T -e MYSQL_PWD="${DB_PASSWORD}" db mariadb \
    -u "${DB_USERNAME}" "${DB_DATABASE}" \
    -e "UPDATE proxy_accounts SET enabled = 0 WHERE username = '$USERNAME'" \
    2>/dev/null

# 4. Publish to the bus, then snap T_disable on the host AFTER
#    the publish returns. The 100-200 ms `docker compose exec`
#    cold-start cost would otherwise be charged to the revocation
#    budget, even though in production the panel publishes via
#    its in-process Redis client (microseconds). Snapping after
#    publish-ack measures "Redis has the event → file updated",
#    which is the daemon-side latency the < 200 ms budget is
#    actually asserting.
#
#    We can't snap inside the redis container itself because
#    busybox's `date` (alpine) silently ignores `%3N` /
#    `%N` and returns whole-second precision only.
step "Publish disable to Redis revocation bus"
# Password via REDISCLI_AUTH env, not -a "…" on argv (matches the
# backup.sh v0.0.17 pattern — never reaches `ps -ef` or host argv).
docker compose exec -T -e REDISCLI_AUTH="${REDIS_PASSWORD}" redis redis-cli \
    --no-auth-warning \
    PUBLISH cool_tunnel:revocations \
    "{\"kind\":\"account_changed\",\"username\":\"$USERNAME\",\"reason\":\"stress\"}" \
    >/dev/null
T_disable=$(date +%s%3N)

# 5. Poll the rendered config file at 5 ms cadence. The fire
#    pipeline is render→atomic-write→clash PUT /configs; once
#    the username is no longer in the file, sing-box has the new
#    config (the atomic-write happens before the clash reload
#    fires). 2 s upper bound is generous — at 200 ms target plus
#    coalescer windows etc. we should be well under 1 s.
deadline=$((T_disable + 2000))
T_drop=0
while [[ $(date +%s%3N) -lt $deadline ]]; do
    # `grep -F -q` (fixed-string, no regex) is faster than full
    # JSON parsing; the username is unambiguous in this file.
    if ! grep -F -q "\"username\":\"$USERNAME\"" "$CONFIG_FILE"; then
        T_drop=$(date +%s%3N)
        break
    fi
    sleep 0.005
done

# Re-enable the account so a re-run doesn't immediately fail
# step 2's baseline. stress:provision toggles enabled=1, so we
# just call it again here.
docker compose exec -T panel \
    php artisan stress:provision --no-interaction \
    --username "$USERNAME" >/dev/null 2>&1 || true
docker compose exec -T panel \
    php artisan singbox:render >/dev/null 2>&1 || true

if [[ "$T_drop" == 0 ]]; then
    elapsed=2000
    pass=false
    reason="username still present in rendered config after 2s — revocation didn't propagate"
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
