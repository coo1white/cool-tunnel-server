#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# doctor.sh — operator-friendly self-diagnostic dashboard.
#
# Runs a battery of health checks against a live deployment and
# prints a colour-coded PASS / WARN / FAIL table grouped by area
# (Structural, Compose stack, Application, Resources, Info).
#
# A single FAIL exits non-zero; WARN-only runs exit zero. The
# whole script is informational — no state is mutated. Safe to
# run on a healthy production VPS or during a deploy.
#
# Differs from late-night-comeback.sh:
#   - doctor.sh: "show me everything the operator should look at,
#     PASS / WARN / FAIL, with remediation hints". Permissive
#     scoring; treats partial outages as actionable WARN rather
#     than hard FAIL where it makes sense.
#   - late-night-comeback.sh: "is the system ready to publicly
#     launch?" Strict scoring (>= 8 / 9 checks pass, structural
#     fails cap the score at 7). Different question, different
#     answer shape.
#
# Both share the same lib.sh primitives; future PR can extract
# the common check functions into a shared library and have both
# scripts call them.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

# Source .env so $DOMAIN, $REDIS_PASSWORD are available. Optional
# — many checks degrade gracefully when .env is missing.
if [[ -f .env ]]; then
    set -a
    # shellcheck source=/dev/null
    . .env
    set +a
fi

# ---------- Output helpers ----------------------------------------

# Format glyphs. ANSI codes already TTY-gated via lib.sh's
# CT_GREEN / CT_YELLOW / CT_RED / CT_RESET.
DR_PASS="${CT_GREEN}[PASS]${CT_RESET}"
DR_WARN="${CT_YELLOW}[WARN]${CT_RESET}"
DR_FAIL="${CT_RED}[FAIL]${CT_RESET}"
DR_INFO="${CT_BOLD}[INFO]${CT_RESET}"

# Counts + remediation buffer.
dr_pass_n=0
dr_warn_n=0
dr_fail_n=0
dr_info_n=0
# Flat array of "<label>|<message>|<hint>" lines for the remediation
# block printed at the end.
dr_remediation=()

dr_section() {
    printf '\n%s%s%s\n' "${CT_BOLD}" "$1" "${CT_RESET}"
}

# dr_pass <label> <value>
dr_pass() {
    printf '  %s %-12s %s\n' "$DR_PASS" "$1" "$2"
    dr_pass_n=$((dr_pass_n + 1))
}

# dr_warn <label> <value> [<hint>]
dr_warn() {
    printf '  %s %-12s %s\n' "$DR_WARN" "$1" "$2"
    dr_warn_n=$((dr_warn_n + 1))
    if [[ -n "${3:-}" ]]; then
        dr_remediation+=("WARN|$1|$2|$3")
    fi
}

# dr_fail <label> <value> [<hint>]
dr_fail() {
    printf '  %s %-12s %s\n' "$DR_FAIL" "$1" "$2"
    dr_fail_n=$((dr_fail_n + 1))
    if [[ -n "${3:-}" ]]; then
        dr_remediation+=("FAIL|$1|$2|$3")
    fi
}

# dr_info <label> <value>
#
# Informational only — does not contribute to PASS/WARN/FAIL count
# or affect exit code. Use for context (e.g. "queue depth = 0",
# "active users = 12") that helps the operator interpret the rest
# of the dashboard.
dr_info() {
    printf '  %s %-12s %s\n' "$DR_INFO" "$1" "$2"
    dr_info_n=$((dr_info_n + 1))
}

# ---------- Individual checks -------------------------------------
#
# Each check_X function emits exactly one dr_pass / dr_warn /
# dr_fail line. Checks that depend on docker compose / .env should
# fail gracefully (dr_fail with a "fix .env first" hint) rather
# than blowing up the script with set -u.

check_compose_available() {
    if docker compose version >/dev/null 2>&1; then
        local v
        v=$(docker compose version --short 2>/dev/null || echo "unknown")
        dr_pass "compose" "v$v"
    else
        dr_fail "compose" "docker compose v2 not on PATH" \
                "Install: apt install -y docker-compose-plugin"
    fi
}

check_env_file() {
    if [[ -f .env ]]; then
        local mode
        mode=$(file_mode_octal .env)
        if [[ "${mode: -1}" -ge 4 ]]; then
            dr_warn ".env" "present, mode $mode is world-readable" \
                    "chmod 0600 .env"
        else
            dr_pass ".env" "present, mode $mode"
        fi
    else
        dr_fail ".env" "missing" "cp .env.example .env && \$EDITOR .env"
    fi
}

check_dns() {
    if [[ -z "${DOMAIN:-}" ]]; then
        dr_fail "DNS" "DOMAIN unset in .env" \
                "Set DOMAIN= in .env and re-run"
        return
    fi
    local resolved my_ip
    resolved=$(dig +short A "$DOMAIN" 2>/dev/null | head -1)
    my_ip=$(curl -s4 --max-time 4 https://ifconfig.co 2>/dev/null)
    if [[ -n "$resolved" && "$resolved" == "$my_ip" ]]; then
        dr_pass "DNS" "$DOMAIN -> $resolved (matches host IP)"
    elif [[ -n "$resolved" && -n "$my_ip" ]]; then
        dr_fail "DNS" "$DOMAIN resolves to $resolved, host IP is $my_ip" \
                "Update DNS A record to $my_ip, then wait for propagation"
    else
        dr_warn "DNS" "could not resolve DOMAIN or determine host IP" \
                "dig +short A $DOMAIN; curl -s4 https://ifconfig.co"
    fi
}

check_ports() {
    local p80=ng p443=ng
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':80$'; then
        p80=ok
    fi
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':443$'; then
        p443=ok
    fi
    if [[ "$p80" == ok && "$p443" == ok ]]; then
        dr_pass "Ports" "80/tcp and 443/tcp listening"
    elif [[ "$p80" == ok || "$p443" == ok ]]; then
        dr_warn "Ports" "partial: 80=$p80 443=$p443" \
                "docker compose ps caddy; docker compose logs --tail=40 caddy"
    else
        dr_fail "Ports" "neither 80 nor 443 listening" \
                "docker compose up -d caddy; check Caddyfile + ACME state"
    fi
}

check_acme_cert() {
    if [[ -z "${DOMAIN:-}" ]]; then
        dr_warn "ACME cert" "skipped (DOMAIN unset)"
        return
    fi
    local cert_output expiry_date now_s expiry_s days_left
    cert_output=$(echo | timeout 6 openssl s_client -servername "$DOMAIN" \
                    -connect "$DOMAIN:443" 2>/dev/null \
                | openssl x509 -noout -enddate 2>/dev/null)
    if [[ -z "$cert_output" ]]; then
        dr_fail "ACME cert" "could not retrieve cert from $DOMAIN:443" \
                "docker compose logs --tail=40 caddy | grep -iE 'acme|cert'"
        return
    fi
    expiry_date="${cert_output#notAfter=}"
    expiry_s=$(date -d "$expiry_date" +%s 2>/dev/null || \
               date -j -f '%b %d %H:%M:%S %Y %Z' "$expiry_date" +%s 2>/dev/null || \
               echo 0)
    now_s=$(date +%s)
    if (( expiry_s == 0 )); then
        dr_warn "ACME cert" "expiry parse failed: $expiry_date"
        return
    fi
    days_left=$(( (expiry_s - now_s) / 86400 ))
    if (( days_left < 7 )); then
        dr_fail "ACME cert" "expires in $days_left days" \
                "Force renewal: docker compose restart caddy; check ACME challenge reachable"
    elif (( days_left < 14 )); then
        dr_warn "ACME cert" "expires in $days_left days (renews automatically at <30)" \
                "Monitor: docker compose logs --tail=80 caddy | grep -iE 'acme|cert'"
    else
        dr_pass "ACME cert" "valid, expires in $days_left days"
    fi
}

check_up_endpoint() {
    # Single call, no fallback URL — curl writes `%{http_code}` to
    # stdout regardless of connection success, so chaining `||` with
    # multiple curl calls concatenates their outputs (each appending
    # "000" on connect failure). Use the panel's loopback port
    # directly; if the operator is somehow on a host where this
    # doesn't reach FrankenPHP, the FAIL line below tells them what
    # to check.
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
           "http://127.0.0.1:9000/up" 2>/dev/null) || true
    code="${code:-000}"
    case "$code" in
        200)
            dr_pass "/up endpoint" "HTTP 200 from FrankenPHP"
            ;;
        000)
            dr_fail "/up endpoint" "connection failed (port 9000 not reachable)" \
                    "docker compose ps panel; docker compose logs --tail=60 panel"
            ;;
        *)
            dr_fail "/up endpoint" "HTTP $code (expected 200)" \
                    "docker compose logs --tail=60 panel"
            ;;
    esac
}

# Expected services + uptime. compose ps --format json is the
# stable contract.
check_container_health() {
    local services=(panel sing-box haproxy caddy db redis)
    local ps_json
    ps_json=$(docker compose ps --format json 2>/dev/null) || ps_json=""
    if [[ -z "$ps_json" ]]; then
        dr_fail "Containers" "docker compose ps returned nothing" \
                "From the repo root: docker compose ps"
        return
    fi
    local missing=() unhealthy=() healthy_count=0
    for svc in "${services[@]}"; do
        # `docker compose ps --format json` emits one JSON object per
        # line in modern compose. Pipe through jq to find this service.
        local row
        row=$(echo "$ps_json" \
              | jq -c --arg s "$svc" 'select(.Service==$s)' 2>/dev/null \
              | head -1)
        if [[ -z "$row" ]]; then
            missing+=("$svc")
            continue
        fi
        local state health
        state=$(echo "$row" | jq -r '.State // "unknown"' 2>/dev/null)
        health=$(echo "$row" | jq -r '.Health // ""' 2>/dev/null)
        if [[ "$state" == "running" ]] && \
           { [[ -z "$health" ]] || [[ "$health" == "healthy" ]]; }; then
            healthy_count=$((healthy_count + 1))
        else
            unhealthy+=("$svc=$state${health:+/$health}")
        fi
    done

    local total=${#services[@]}
    if (( ${#missing[@]} == 0 && ${#unhealthy[@]} == 0 )); then
        dr_pass "Containers" "$healthy_count/$total running"
    elif (( healthy_count == 0 )); then
        dr_fail "Containers" "0/$total running" \
                "docker compose up -d; docker compose logs --tail=80"
    else
        local msg="$healthy_count/$total running"
        [[ ${#missing[@]} -gt 0 ]] && msg="$msg, missing: ${missing[*]}"
        [[ ${#unhealthy[@]} -gt 0 ]] && msg="$msg, degraded: ${unhealthy[*]}"
        dr_warn "Containers" "$msg" \
                "docker compose ps; docker compose logs --tail=40 ${missing[*]:-} ${unhealthy[*]%%=*}"
    fi
}

# Supervisord in the panel container should have 5 programs.
check_supervisord() {
    local out
    out=$(docker compose exec -T panel supervisorctl status 2>/dev/null) || {
        dr_warn "Supervisord" "could not query supervisorctl in panel" \
                "docker compose ps panel; docker compose exec panel supervisorctl status"
        return
    }
    local total running
    total=$(echo "$out" | wc -l | tr -d ' ')
    running=$(echo "$out" | awk '$2 == "RUNNING"' | wc -l | tr -d ' ')
    if [[ "$running" == "5" && "$total" == "5" ]]; then
        dr_pass "Supervisord" "5/5 programs running"
    elif (( running > 0 )); then
        dr_warn "Supervisord" "$running/$total programs running" \
                "docker compose exec panel supervisorctl status"
    else
        dr_fail "Supervisord" "0/$total programs running" \
                "docker compose logs --tail=80 panel"
    fi
}

check_components() {
    local out
    # `|| true` keeps the script alive when ct-server-core returns
    # non-zero (e.g. NG rows present). We inspect $out below to
    # determine PASS vs FAIL — the exit code itself is unreliable
    # (component check intentionally exits 0 with mixed OK/NG
    # output to keep the JSON callers happy).
    out=$(docker compose exec -T panel ct-server-core component check \
              --manifests /srv/manifests 2>/dev/null || true)
    if [[ -z "${out:-}" ]]; then
        dr_warn "Components" "could not run component check" \
                "docker compose exec panel ct-server-core component check"
        return
    fi
    if echo "$out" | grep -qE '^\s*NG\s'; then
        local ng
        ng=$(echo "$out" | grep -E '^\s*NG\s' | awk '{print $2}' \
             | sort -u | paste -sd, -)
        dr_fail "Components" "NG: $ng" \
                "docker compose exec panel ct-server-core component check"
    else
        local ok_n
        ok_n=$(echo "$out" | grep -cE '^\s*OK\s' || echo 0)
        dr_pass "Components" "$ok_n/$ok_n OK"
    fi
}

# Disk headroom under repo + docker root.
check_disk() {
    local repo_kb repo_gb docker_root docker_kb docker_gb
    repo_kb=$(df -k . 2>/dev/null | awk 'NR==2 {print $4}')
    repo_gb=$(( ${repo_kb:-0} / 1024 / 1024 ))
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null \
                  || echo /var/lib/docker)
    docker_kb=$(df -k "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}')
    docker_gb=$(( ${docker_kb:-0} / 1024 / 1024 ))

    local repo_min="${CT_MIN_REPO_GB:-2}"
    local docker_min="${CT_MIN_DOCKER_GB:-4}"
    if (( repo_gb < repo_min || docker_gb < docker_min )); then
        dr_fail "Disk" "repo ${repo_gb}G, docker ${docker_gb}G (need >= ${repo_min}/${docker_min})" \
                "docker system prune -af; docker builder prune -af; rm -rf core/target"
    elif (( repo_gb < repo_min * 2 || docker_gb < docker_min * 2 )); then
        dr_warn "Disk" "repo ${repo_gb}G, docker ${docker_gb}G (tight)" \
                "docker system prune -af  # reclaim 1-5 GB typical"
    else
        dr_pass "Disk" "repo ${repo_gb}G, docker ${docker_gb}G"
    fi
}

check_ram() {
    if ! [[ -r /proc/meminfo ]]; then
        dr_warn "RAM" "/proc/meminfo unreadable (non-Linux host?)"
        return
    fi
    local total_kb avail_kb total_mb avail_mb pct
    total_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
    avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
    total_mb=$(( total_kb / 1024 ))
    avail_mb=$(( avail_kb / 1024 ))
    pct=$(( avail_kb * 100 / total_kb ))
    if (( pct < 10 )); then
        dr_fail "RAM" "${avail_mb}M / ${total_mb}M free (${pct}%)" \
                "docker stats --no-stream; consider docker system prune -af"
    elif (( pct < 25 )); then
        dr_warn "RAM" "${avail_mb}M / ${total_mb}M free (${pct}%)" \
                "docker stats --no-stream  # which container is hot?"
    else
        dr_pass "RAM" "${avail_mb}M / ${total_mb}M free (${pct}%)"
    fi
}

# Informational: Messenger transport queue depth. Healthy steady-
# state is 0 or close to it (consumer keeps up with producers). A
# growing number means the messenger:consume worker is stuck or
# overloaded.
info_messenger_depth() {
    if [[ -z "${REDIS_PASSWORD:-}" ]]; then
        dr_info "Msgr depth" "skipped (REDIS_PASSWORD unset in .env)"
        return
    fi
    local depth
    depth=$(docker compose exec -T -e REDISCLI_AUTH="$REDIS_PASSWORD" \
                redis redis-cli XLEN cool_tunnel:messenger 2>/dev/null \
            || echo "?")
    dr_info "Msgr depth" "$depth (cool_tunnel:messenger stream)"
}

# Informational: active proxy account count.
info_active_users() {
    local n
    n=$(docker compose exec -T panel php artisan tinker --execute \
        'echo \App\Models\ProxyAccount::where("enabled", true)->count();' \
        2>/dev/null \
        | tr -d '[:space:]' || echo "?")
    [[ -z "$n" ]] && n="?"
    dr_info "Active users" "$n proxy accounts enabled"
}

# Informational: which release is running.
info_release_version() {
    local v
    v=$(docker compose exec -T panel ct-server-core --json server version 2>/dev/null \
        | jq -r '.version // "?"' 2>/dev/null || echo "?")
    dr_info "Release" "v$v"
}

# ---------- Run ---------------------------------------------------

printf '%sCool Tunnel Server — Doctor%s\n' "${CT_BOLD}${CT_GREEN}" "${CT_RESET}"
printf '%s (date %s, host %s)%s\n' \
    "${CT_BOLD}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "${CT_RESET}"

dr_section "Prerequisites"
check_compose_available
check_env_file

dr_section "Structural (network reachability)"
check_dns
check_ports
check_acme_cert

dr_section "Application"
check_up_endpoint
check_components

dr_section "Compose stack"
check_container_health
check_supervisord

dr_section "Resources"
check_disk
check_ram

dr_section "Info (no PASS/FAIL contribution)"
info_release_version
info_active_users
info_messenger_depth

# ---------- Summary ----------------------------------------------

dr_section "Summary"
printf '  %s%d PASS%s, %s%d WARN%s, %s%d FAIL%s, %d INFO\n' \
    "${CT_GREEN}" "$dr_pass_n" "${CT_RESET}" \
    "${CT_YELLOW}" "$dr_warn_n" "${CT_RESET}" \
    "${CT_RED}" "$dr_fail_n" "${CT_RESET}" \
    "$dr_info_n"

if (( ${#dr_remediation[@]} > 0 )); then
    printf '\n%sRemediation:%s\n' "${CT_BOLD}" "${CT_RESET}"
    for entry in "${dr_remediation[@]}"; do
        IFS='|' read -r sev label msg hint <<<"$entry"
        local_color="$CT_YELLOW"
        [[ "$sev" == FAIL ]] && local_color="$CT_RED"
        printf '\n  %s[%s] %s%s\n' "$local_color" "$sev" "$label" "${CT_RESET}"
        printf '    %s\n' "$msg"
        printf '    %s↳%s %s\n' "${CT_BOLD}" "${CT_RESET}" "$hint"
    done
    printf '\n'
fi

# Exit code: non-zero only on FAIL. WARNs are advisory; cron / CI
# can decide whether to act on them via the dashboard or by
# parsing the summary line.
if (( dr_fail_n > 0 )); then
    exit 1
fi
exit 0
