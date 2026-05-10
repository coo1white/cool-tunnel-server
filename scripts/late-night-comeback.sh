#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# late-night-comeback.sh — pre-launch readiness gate.
#
# Eleven checks. Pass ≥ 82% (nine) to ship. Structural checks 1–4
# (DNS / ports / ACME / UFW) cap the final score at 7 if any of
# them is NG, regardless of the others — they are non-negotiable.
#
# Exit 0 on pass, 1 on fail. Suitable for cron / CI.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

# Source .env so $DOMAIN, $REDIS_PASSWORD, etc. are available.
if [[ -f .env ]]; then
    set -a
    # shellcheck source=/dev/null
    . .env
    set +a
fi

DOMAIN=${DOMAIN:-}
PASS_GLYPH=$'\033[32mOK\033[0m'
FAIL_GLYPH=$'\033[31mNG\033[0m'

structural_fails=0
# shellcheck disable=SC2034  # tracked for clarity even though unused
nonstructural_fails=0
total_pass=0

record() {
    # record <slot> <ok|ng> <label>
    local slot="$1" state="$2" label="$3"
    if [[ "$state" == ok ]]; then
        printf "  [%b] %d. %s\n" "$PASS_GLYPH" "$slot" "$label"
        ((total_pass++))
    else
        printf "  [%b] %d. %s\n" "$FAIL_GLYPH" "$slot" "$label"
        if (( slot >= 1 && slot <= 4 )); then
            ((structural_fails++))
        else
            ((nonstructural_fails++))
        fi
    fi
}

# ---- 1. DNS resolves to this host ---------------------------------
check_dns() {
    [[ -z "$DOMAIN" ]] && { record 1 ng "DNS — DOMAIN not set in .env"; return; }
    local resolved my_ip
    resolved=$(dig +short A "$DOMAIN" 2>/dev/null | head -1)
    my_ip=$(curl -s4 --max-time 4 https://ifconfig.co 2>/dev/null)
    if [[ -n "$resolved" && "$resolved" == "$my_ip" ]]; then
        record 1 ok "DNS A($DOMAIN)=$resolved matches host IP $my_ip"
    else
        record 1 ng "DNS A($DOMAIN)='$resolved' does not match host IP '$my_ip'"
    fi
}

# ---- 2. Inbound 80 / 443 / 443udp reachable ----------------------
check_ports() {
    if ss -ltnu 2>/dev/null | awk '{print $5}' | grep -qE ':80$|:80 '; then
        local p80=ok; else local p80=ng; fi
    if ss -ltnu 2>/dev/null | awk '{print $5}' | grep -qE ':443$|:443 '; then
        local p443=ok; else local p443=ng; fi
    if [[ "$p80" == ok && "$p443" == ok ]]; then
        record 2 ok "Ports 80/tcp + 443/tcp listening"
    else
        record 2 ng "Ports not listening (80=$p80, 443=$p443) — Caddy may not be running"
    fi
}

# ---- 3. ACME cert landed -----------------------------------------
check_acme() {
    [[ -z "$DOMAIN" ]] && { record 3 ng "ACME — DOMAIN not set"; return; }
    local issuer
    issuer=$(echo | timeout 6 openssl s_client -servername "$DOMAIN" \
                -connect "$DOMAIN:443" 2>/dev/null \
            | openssl x509 -noout -issuer 2>/dev/null)
    if echo "$issuer" | grep -qiE "Let's Encrypt|STAGING"; then
        record 3 ok "ACME cert issued by ${issuer#issuer=}"
    else
        record 3 ng "ACME cert not from Let's Encrypt: '$issuer'"
    fi
}

# ---- 4. UFW rules sane -------------------------------------------
check_ufw() {
    if ! command -v ufw >/dev/null; then
        record 4 ng "UFW not installed"
        return
    fi
    local s
    s=$(ufw status 2>/dev/null)
    if echo "$s" | grep -qE '^Status:\s+active' \
        && echo "$s" | grep -qE '443/tcp'; then
        record 4 ok "UFW active with 443/tcp allowed"
    else
        record 4 ng "UFW rules incomplete or inactive"
    fi
}

# ---- 5. BBR + TCP buffer sysctl ----------------------------------
check_kernel() {
    local cc rmem
    cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)
    rmem=$(sysctl -n net.core.rmem_max 2>/dev/null)
    if [[ "$cc" == bbr && "${rmem:-0}" -ge 7500000 ]]; then
        record 5 ok "BBR active, rmem_max=${rmem}"
    else
        record 5 ng "Kernel not tuned (cc=${cc:-?}, rmem_max=${rmem:-?})"
    fi
}

# ---- 6. NTP synchronised -----------------------------------------
check_ntp() {
    if timedatectl 2>/dev/null | grep -qiE 'System clock synchronized:\s+yes'; then
        record 6 ok "Clock synchronised"
    else
        record 6 ng "Clock not synchronised — TLS will misbehave"
    fi
}

# ---- 7. Component check OK/NG -----------------------------------
check_components() {
    if ! component_check_strict /srv/manifests >/tmp/lnc-components 2>&1; then
        record 7 ng "Some components NG (see docker compose exec panel ct-server-core component check)"
        return
    fi
    if grep -qE '^\s*NG' /tmp/lnc-components; then
        record 7 ng "Some components NG"
    else
        record 7 ok "All components OK"
    fi
}

# ---- 8. Redis revocation bridge live -----------------------------
check_redis_bridge() {
    docker compose exec -T panel sh -c '
        : "${REDIS_PASSWORD:?missing in env}"
        redis-cli -h redis -a "$REDIS_PASSWORD" --no-auth-warning \
            publish cool_tunnel:revocations "{\"kind\":\"resync\"}" >/dev/null
    ' 2>/dev/null || { record 8 ng "Could not publish to Redis"; return; }
    sleep 1
    if docker compose logs --tail=200 panel 2>/dev/null \
            | grep -qiE 'revocation received|sing-?box reload|caddy reloaded'; then
        record 8 ok "Redis bridge alive (Rust daemon ack'd a resync)"
    else
        record 8 ng "Published, but no daemon ack in panel logs"
    fi
}

# ---- 9. Synthetic CONNECT (skipped if no test account) ----------
check_proxy_connect() {
    if [[ -z "${LNC_TEST_PROXY_URL:-}" ]]; then
        record 9 ng "Skipped — set LNC_TEST_PROXY_URL=https://user:pass@\$DOMAIN:443 to enable"
        return
    fi
    local out
    out=$(curl -s --max-time 8 --proxy "$LNC_TEST_PROXY_URL" \
              https://ifconfig.co/json 2>/dev/null)
    if [[ -z "$out" ]]; then
        record 9 ng "CONNECT through proxy returned no body"
        return
    fi
    record 9 ok "CONNECT through proxy returned a body"
}

# ---- 10. Anti-tracking probe ------------------------------------
check_probe() {
    if [[ -z "${LNC_TEST_PROXY_URL:-}" ]]; then
        record 10 ng "Skipped — set LNC_TEST_PROXY_URL"
        return
    fi
    local out
    out=$(docker compose exec -T panel ct-server-core probe anti-tracking \
              --via "$LNC_TEST_PROXY_URL" 2>/dev/null)
    if echo "$out" | grep -q '"hide_ip_effective":true' \
        && echo "$out" | grep -q '"hide_via_effective":true'; then
        record 10 ok "hide_ip + hide_via effective"
    else
        record 10 ng "Anti-tracking probe failed: $out"
    fi
}

# ---- 11. Cover-site invariant (v0.0.14) -------------------------
# A censor probe sweeping for proxy endpoints should see byte-for-
# byte identical responses on a known-bogus subscription path and
# a random unknown path. We verify three properties from inside
# the panel container (the only place all the cover paths are
# reachable in the loopback-only architecture):
#   (a) HTTP status 200 on both
#   (b) Same ETag on both (i.e. same body bytes)
#   (c) No `Server:` header in the wire response from the public
#       Caddy redirect on :80.
# A NG here means a v0.0.13/v0.0.14 anti-fingerprint regression
# slipped past CI; do NOT ship.
check_cover_invariant() {
    if ! docker compose exec -T panel sh -c 'command -v curl' >/dev/null 2>&1; then
        record 11 ng "Cover-site check skipped — curl missing in panel container"
        return
    fi
    local etag_sub etag_rand status_sub status_rand
    etag_sub=$(docker compose exec -T panel sh -c \
        'curl -sI -m 5 http://127.0.0.1:9000/api/v1/subscription/lnc-bogus | grep -i "^etag:" | tr -d "\r\n" | sed -E "s/^.*etag:\s*//i"' \
        2>/dev/null)
    etag_rand=$(docker compose exec -T panel sh -c \
        'curl -sI -m 5 http://127.0.0.1:9000/lnc-cover-probe | grep -i "^etag:" | tr -d "\r\n" | sed -E "s/^.*etag:\s*//i"' \
        2>/dev/null)
    status_sub=$(docker compose exec -T panel sh -c \
        'curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:9000/api/v1/subscription/lnc-bogus' \
        2>/dev/null)
    status_rand=$(docker compose exec -T panel sh -c \
        'curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:9000/lnc-cover-probe' \
        2>/dev/null)

    local server_hdr=""
    if [[ -n "$DOMAIN" ]]; then
        server_hdr=$(curl -sI -m 5 "http://${DOMAIN}/" 2>/dev/null | grep -i "^server:" || true)
    fi

    if [[ "$status_sub" == "200" && "$status_rand" == "200" \
       && -n "$etag_sub" && "$etag_sub" == "$etag_rand" \
       && -z "$server_hdr" ]]; then
        record 11 ok "Cover-site invariant holds (200/200, ETags match, no Server header)"
    else
        record 11 ng "Cover-site distinguisher detected: sub=${status_sub} rand=${status_rand} etag_match=$([[ "$etag_sub" == "$etag_rand" ]] && echo y || echo n) server='${server_hdr:-<none>}'"
    fi
}

# ---- run ----------------------------------------------------------
echo "Late-Night Comeback — readiness check"
echo "(Domain: ${DOMAIN:-<unset>})"
echo
echo "Structural (must pass):"
check_dns
check_ports
check_acme
check_ufw
echo
echo "Operational:"
check_kernel
check_ntp
check_components
check_redis_bridge
echo
echo "Functional:"
check_proxy_connect
check_probe
check_cover_invariant
echo

# Score logic.
score=$total_pass
if (( structural_fails > 0 )); then
    if (( score > 7 )); then score=7; fi
fi
# Now out of 11 checks, not 10. PASS threshold scales accordingly:
# 9/11 ≈ 82 %, matching the prior 8/10 ≈ 80 % bar.
pct=$((score * 100 / 11))
echo "Score: ${score}/11 (${pct}%)"
if (( structural_fails > 0 )); then
    echo "Structural fail(s): $structural_fails — score capped at 7."
fi

if (( score >= 9 )); then
    echo "Result: PASS — ready to ship."
    exit 0
else
    echo "Result: FAIL — fix flagged checks before launch."
    exit 1
fi
