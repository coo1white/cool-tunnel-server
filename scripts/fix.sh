#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# fix.sh — interactive multi-recipe auto-diagnose-and-repair agent.
#
# Walks through a registry of known new-operator failure modes,
# detects which ones currently apply, and offers to fix each one
# interactively. Each recipe is self-contained:
#
#   detect_<slug>()   returns 0 if issue present, 1 if not
#   describe_<slug>() prints what the issue is + what the fix does
#   fix_<slug>()      applies corrective action
#   verify_<slug>()   re-checks; returns 0 if resolved
#
# Per-recipe operator prompt: [a]pply / [s]kip / [e]xplain / [q]uit.
# Default (Enter) is [s]kip — never auto-apply destructive actions
# without explicit consent.
#
# Companions:
#   make doctor      read-only audit (look only)
#   make auto-sync   credential-lock specific self-heal (one fix only)
#   make fix         this script — broad multi-recipe interactive fix
#
# Recipes ship in the order they're typically encountered during
# fresh-VPS installs (validated against the v0.1.1 install incident
# on the Vultr instance 2026-05-14):
#
#   1. docker_daemon_down          host's docker daemon isn't running
#   2. zombie_docker_proxy         ports bound by orphan docker-proxy
#   3. foreign_container_ports     non-compose container holding :80/:443
#   4. broken_container_dns        container can't resolve hostnames
#   5. ipv6_dns_unreachable        Caddy logs IPv6 DNS errors (Vultr)
#   6. haproxy_backend_dns         haproxy can't resolve compose services
#   7. missing_tls_cert            sing-box can't read cert file
#   8. singbox_domain_resolver     sing-box 1.13+ DoH config regression
#   9. singbox_outbound_ipv4_only  v6-broken host + outbound dial fails (Vultr)
#  10. panel_restart_loop          panel container restart-looping
#  11. pending_migrations          DB schema older than current code
#  12. messenger_queue_stuck       Symfony Messenger Redis worker dead
#  13. credential_drift            DB / sing-box / manifest out of sync
#  14. no_proxy_account            DB count of enabled accounts = 0
#  15. legacy_env_shape            pre-v0.0.68 .env layout

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Inhibit lib.sh's universal "stuck? Run: ct fix" footer — the fix
# agent IS that escape hatch, so recommending itself recursively
# would be confusing. Other scripts (install / update / etc.) keep
# the pointer and benefit from it.
export CT_NO_FIX_HINT=1

# shellcheck source=lib.sh
. scripts/lib.sh

# ---------- Recipe registry --------------------------------------

RECIPES=(
    docker_daemon_down
    zombie_docker_proxy
    foreign_container_ports
    broken_container_dns
    ipv6_dns_unreachable
    haproxy_backend_dns
    missing_tls_cert
    singbox_domain_resolver
    singbox_outbound_ipv4_only
    panel_restart_loop
    pending_migrations
    messenger_queue_stuck
    credential_drift
    no_proxy_account
    legacy_env_shape
)

# ---------- Counters ---------------------------------------------

TOTAL_DETECTED=0
TOTAL_FIXED=0
TOTAL_SKIPPED=0
TOTAL_FAILED=0
TOTAL_OK=0

# ---------- Interactive UI helper --------------------------------

# prompt_action <slug>
#   returns 0 = apply, 1 = skip, 2 = explain, 3 = quit
prompt_action() {
    local slug="$1" reply
    while true; do
        printf "  %s%s%s -- [%sa%spply / %ss%skip / %se%sxplain / %sq%suit] " \
            "${CT_BOLD}" "$slug" "${CT_RESET}" \
            "${CT_BOLD}" "${CT_RESET}" \
            "${CT_BOLD}" "${CT_RESET}" \
            "${CT_BOLD}" "${CT_RESET}" \
            "${CT_BOLD}" "${CT_RESET}" >&2
        if [[ ! -t 0 ]]; then
            # Non-interactive shell -> default to skip, never auto-apply.
            printf "(non-tty, defaulting to skip)\n" >&2
            return 1
        fi
        IFS= read -r reply
        case "${reply:-s}" in
            a|A|apply)   return 0 ;;
            s|S|skip|"") return 1 ;;
            e|E|explain) return 2 ;;
            q|Q|quit)    return 3 ;;
            *) printf "    please answer a / s / e / q\n" >&2 ;;
        esac
    done
}

run_recipe() {
    local slug="$1"
    local detect_fn="detect_${slug}"
    local describe_fn="describe_${slug}"
    local fix_fn="fix_${slug}"
    local verify_fn="verify_${slug}"

    if ! "$detect_fn" >/dev/null 2>&1; then
        TOTAL_OK=$((TOTAL_OK + 1))
        printf "  %s✓%s %s: ok\n" "${CT_GREEN}" "${CT_RESET}" "$slug"
        return 0
    fi

    TOTAL_DETECTED=$((TOTAL_DETECTED + 1))
    printf "\n  %s!%s %s%s%s -- ISSUE DETECTED\n" \
        "${CT_YELLOW}${CT_BOLD}" "${CT_RESET}" \
        "${CT_BOLD}" "$slug" "${CT_RESET}"

    while true; do
        prompt_action "$slug"
        case $? in
            0)  # apply
                "$describe_fn" | sed 's/^/      /'
                printf "  %s→%s applying fix...\n" "${CT_BOLD}" "${CT_RESET}"
                if "$fix_fn"; then
                    if "$verify_fn" >/dev/null 2>&1; then
                        printf "  %s✓ resolved%s\n" "${CT_GREEN}" "${CT_RESET}"
                        TOTAL_FIXED=$((TOTAL_FIXED + 1))
                    else
                        printf "  %s✗ fix ran but issue persists -- manual investigation needed%s\n" \
                            "${CT_RED}" "${CT_RESET}"
                        TOTAL_FAILED=$((TOTAL_FAILED + 1))
                    fi
                else
                    printf "  %s✗ fix command failed -- check operator privileges + retry%s\n" \
                        "${CT_RED}" "${CT_RESET}"
                    TOTAL_FAILED=$((TOTAL_FAILED + 1))
                fi
                return 0
                ;;
            1)  # skip
                printf "  %s↷ skipped (no action taken)%s\n" "${CT_YELLOW}" "${CT_RESET}"
                TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
                return 0
                ;;
            2)  # explain
                printf "\n"
                "$describe_fn" | sed 's/^/      /'
                printf "\n"
                # loop back to prompt
                ;;
            3)  # quit
                printf "  %squitting (no more recipes will run)%s\n" \
                    "${CT_YELLOW}" "${CT_RESET}"
                return 99
                ;;
        esac
    done
}

# ============================================================
# RECIPE 1 - docker_daemon_down
# ============================================================
#
# A new operator's first "everything is broken" — usually on a fresh
# Debian/Ubuntu where docker.io was installed but the daemon was
# never started, or where the OS rebooted and docker wasn't enabled
# at boot. Shows up as `docker compose ps` returning "Cannot connect
# to the Docker daemon at unix:///var/run/docker.sock."
#
# Detect comes BEFORE every other recipe (which all assume docker
# works); the recipe registry lists this as #1 deliberately.

detect_docker_daemon_down() {
    # `docker info` is the canonical "is the daemon alive" probe.
    # Stderr suppressed because the "Cannot connect" message is the
    # signal we're looking for, but it's noisy on a healthy host.
    docker info >/dev/null 2>&1 && return 1
    return 0
}

describe_docker_daemon_down() {
    cat <<'EOF'
The Docker daemon on this host is not running.

Without a running Docker daemon, NOTHING in the Cool Tunnel stack
can start (every service runs in a container). On Debian / Ubuntu
this usually happens because:
  - You installed docker.io but never enabled the service.
  - The host rebooted and docker was not enabled at boot.
  - Someone ran `systemctl stop docker` and forgot to restart it.

Fix: start the docker service + enable it for next boot. Then
re-run the compose stack so the cool-tunnel containers come up.

Safe to run regardless of state — `systemctl start` is a no-op on
an already-running daemon, `systemctl enable` is a no-op on
already-enabled. No data loss.
EOF
}

fix_docker_daemon_down() {
    sudo systemctl start  docker || return 1
    sudo systemctl enable docker >/dev/null 2>&1 || true
    sleep 4
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose up -d >/dev/null 2>&1
    sleep 8
}

verify_docker_daemon_down() {
    ! detect_docker_daemon_down
}

# ============================================================
# RECIPE 2 - zombie_docker_proxy
# ============================================================

detect_zombie_docker_proxy() {
    # docker-proxy holding :80 or :443 with no compose container actually publishing
    sudo ss -ltnp 2>/dev/null | grep -qE 'docker-proxy.*:80\b|docker-proxy.*:443\b' || return 1
    # If a compose container is currently publishing :80 or :443, the proxy is legitimate
    if docker compose ps --format json 2>/dev/null \
        | grep -qE '"Publishers".*"PublishedPort":\s*(80|443)\b'; then
        # Check at least one of them is actually running
        if docker ps --format '{{.Status}} {{.Ports}}' 2>/dev/null \
                | grep -qE 'Up.*0\.0\.0\.0:(80|443)->'; then
            return 1
        fi
    fi
    return 0
}

describe_zombie_docker_proxy() {
    cat <<'EOF'
docker-proxy is bound to :80 or :443 on the host but no
matching running container is publishing those ports.

Typical cause: a previous "docker compose up" attempt failed
mid-flight (the container died but the host-side port
publisher orphaned). Subsequent "compose up" then fails with
"Bind for 0.0.0.0:80 failed: port is already allocated".

Fix: restart the docker daemon. This regenerates iptables NAT
rules and cleans orphan proxies. Currently-running containers
re-spawn under their restart policies and do NOT lose data.
EOF
}

fix_zombie_docker_proxy() {
    sudo systemctl restart docker
    sleep 8
}

verify_zombie_docker_proxy() {
    ! detect_zombie_docker_proxy
}

# ============================================================
# RECIPE 3 - foreign_container_ports
# ============================================================

detect_foreign_container_ports() {
    # Any running docker container that publishes :80 or :443 to host AND
    # is NOT part of the cool-tunnel-server compose project?
    local foreign
    foreign=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
        | awk '/0\.0\.0\.0:80->|0\.0\.0\.0:443->/ && $1 !~ /^ct-/ { print $1 }')
    [[ -n "$foreign" ]]
}

describe_foreign_container_ports() {
    local foreign
    foreign=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
        | awk '/0\.0\.0\.0:80->|0\.0\.0\.0:443->/ && $1 !~ /^ct-/ { print $1 }' \
        | paste -sd, -)
    cat <<EOF
A docker container that is NOT part of cool-tunnel-server is
binding host port :80 or :443 to the public interface.

Foreign container(s) detected: ${foreign}

This blocks cool-tunnel's Caddy / HAProxy from starting because
:80 / :443 are already taken.

Fix: stop + remove the foreign container. If you actually want
to keep it running, the cool-tunnel stack will NEVER work on
this host (port conflict) and you should deploy cool-tunnel on
a different VPS instead.

The fix runs:
  docker stop <foreign>
  docker rm <foreign>
EOF
}

fix_foreign_container_ports() {
    local containers
    containers=$(docker ps --format '{{.Names}}' 2>/dev/null \
        | awk '/^[^c]|^c[^t]|^ct[^-]/' \
        | xargs -r -I {} sh -c 'docker port {} 2>/dev/null | grep -qE "(80|443)/tcp" && echo {}')
    if [[ -z "$containers" ]]; then
        # Re-detect via the same logic in detect_
        containers=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
            | awk '/0\.0\.0\.0:80->|0\.0\.0\.0:443->/ && $1 !~ /^ct-/ { print $1 }')
    fi
    [[ -z "$containers" ]] && return 1
    for c in $containers; do
        printf "      stopping + removing: %s\n" "$c"
        docker stop "$c" >/dev/null 2>&1
        docker rm "$c" >/dev/null 2>&1
    done
}

verify_foreign_container_ports() {
    ! detect_foreign_container_ports
}

# ============================================================
# RECIPE 4 - broken_container_dns
# ============================================================

detect_broken_container_dns() {
    # Is the panel container running? If not, skip (will be caught by other recipes)
    docker compose ps --status running panel 2>/dev/null | grep -q ct-panel || return 1
    # Can the panel container resolve a public hostname?
    docker compose exec -T panel sh -c \
        'wget -qO- --timeout=3 --tries=1 https://1.1.1.1/ >/dev/null 2>&1' && return 1
    # Confirm the issue is DNS by trying a direct-IP request
    docker compose exec -T panel sh -c \
        'wget -qO- --timeout=3 --tries=1 https://1.0.0.1/ >/dev/null 2>&1' || return 1
    return 0
}

describe_broken_container_dns() {
    cat <<'EOF'
The panel container cannot resolve hostnames but CAN reach
public IPs directly. Docker bridge NAT or container DNS is
broken.

Typical causes: stale iptables rules after IPv6 disable,
broken /etc/resolv.conf inside the container, docker daemon
bridge interface in a bad state after a host network change.

Fix: restart the docker daemon. This regenerates the bridge
NAT + iptables rules cleanly. Containers auto-restart.
EOF
}

fix_broken_container_dns() {
    sudo systemctl restart docker
    sleep 8
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose up -d >/dev/null 2>&1
    sleep 5
}

verify_broken_container_dns() {
    ! detect_broken_container_dns
}

# ============================================================
# RECIPE 5 - ipv6_dns_unreachable
# ============================================================

detect_ipv6_dns_unreachable() {
    docker compose ps --status running caddy 2>/dev/null | grep -q ct-caddy || return 1
    docker compose logs --tail=60 caddy 2>&1 \
        | grep -qE 'network is unreachable.*\[[0-9a-fA-F:]+\]:53|dial udp \[[0-9a-fA-F:]+\]:53'
}

describe_ipv6_dns_unreachable() {
    cat <<'EOF'
Caddy's ACME process is failing because the host's IPv6 path is
unreachable but /etc/resolv.conf points at an IPv6 DNS server.
Common on Vultr instances: provider advertises IPv6 but doesn't
actually route it.

Fix (3-layer IPv6 disable):
  1. sysctl   - disable IPv6 in the kernel (persistent)
  2. resolv.conf - pin IPv4-only nameservers
  3. docker daemon.json - "ipv6": false + explicit IPv4 DNS

Restarts the docker daemon afterwards so containers pick up
the new config.
EOF
}

fix_ipv6_dns_unreachable() {
    sudo tee /etc/sysctl.d/99-disable-ipv6.conf >/dev/null <<'SYSCTL'
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
SYSCTL
    sudo sysctl --system >/dev/null
    sudo cp -n /etc/resolv.conf /etc/resolv.conf.bak 2>/dev/null || true
    sudo tee /etc/resolv.conf >/dev/null <<'RESOLV'
nameserver 1.1.1.1
nameserver 8.8.8.8
options single-request-reopen
RESOLV
    sudo mkdir -p /etc/docker
    sudo tee /etc/docker/daemon.json >/dev/null <<'DAEMON'
{
  "ipv6": false,
  "dns": ["1.1.1.1", "8.8.8.8"]
}
DAEMON
    sudo systemctl restart docker
    sleep 10
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose up -d >/dev/null 2>&1
    sleep 30
}

verify_ipv6_dns_unreachable() {
    docker compose logs --tail=20 caddy 2>&1 \
        | grep -qE 'network is unreachable.*\[[0-9a-fA-F:]+\]:53' && return 1
    return 0
}

# ============================================================
# RECIPE 6 - haproxy_backend_dns
# ============================================================

detect_haproxy_backend_dns() {
    docker compose ps haproxy 2>/dev/null | grep -qE 'Restarting|Created' || return 1
    docker compose logs --tail=30 haproxy 2>&1 \
        | grep -qE "could not resolve address '(caddy|sing-box)'"
}

describe_haproxy_backend_dns() {
    cat <<'EOF'
HAProxy is restart-looping because it cannot resolve its
upstream service hostnames ('caddy', 'sing-box') from compose's
internal DNS. Usually means those services aren't running yet
(chicken-and-egg startup ordering, exposed when caddy or
sing-box dies mid-init).

Fix: bring caddy + sing-box up first, then restart haproxy.
EOF
}

fix_haproxy_backend_dns() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose up -d caddy sing-box >/dev/null 2>&1
    sleep 10
    docker compose restart haproxy >/dev/null 2>&1
    sleep 5
}

verify_haproxy_backend_dns() {
    docker compose ps haproxy 2>/dev/null | grep -qE 'Up.*healthy' && return 0
    return 1
}

# ============================================================
# RECIPE 7 - missing_tls_cert
# ============================================================

detect_missing_tls_cert() {
    docker compose logs --tail=30 sing-box 2>&1 \
        | grep -qE 'no such file or directory.*\.crt'
}

describe_missing_tls_cert() {
    cat <<'EOF'
sing-box is restart-looping because Caddy hasn't yet obtained
the TLS cert for the proxy domain. sing-box reads the cert from
the shared /data/caddy/... volume; until Caddy issues it, the
file doesn't exist and sing-box can't start its naive inbound.

Fix: poke Caddy to retry ACME (it usually retries on a 60-120s
backoff). The fix restarts Caddy + waits up to 90 seconds for
the cert to land. If the underlying issue is DNS or port-80
unreachability, recipe 4 (ipv6_dns_unreachable) is the more
appropriate fix and should run first.
EOF
}

fix_missing_tls_cert() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose restart caddy >/dev/null 2>&1
    sleep 90
}

verify_missing_tls_cert() {
    ! detect_missing_tls_cert
}

# ============================================================
# RECIPE 8 - singbox_domain_resolver
# ============================================================

detect_singbox_domain_resolver() {
    docker compose logs --tail=30 sing-box 2>&1 \
        | grep -q 'missing domain resolver for domain server address'
}

describe_singbox_domain_resolver() {
    cat <<'EOF'
sing-box 1.13+ rejects DoH resolvers that use a hostname
without an explicit "domain_resolver" bootstrap. The panel's
anti_tracking_doh_resolver setting in the DB is currently a
domain-form URL (e.g. https://dns.alidns.com/dns-query).

Fix: flip the DoH resolver to an IP-based DoH endpoint
(https://1.1.1.1/dns-query). sing-box accepts that without a
domain_resolver field. The renderer rebuilds config.json + the
container restarts.

After the fix you can later switch back to a domain-form
resolver once the panel renderer is updated to emit
domain_resolver bootstrap entries (tracked separately).
EOF
}

fix_singbox_domain_resolver() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose exec -T panel php artisan tinker --execute='
        $c = \App\Models\ServerConfig::current();
        $c->anti_tracking_doh_resolver = "https://1.1.1.1/dns-query";
        $c->save();
    ' >/dev/null 2>&1
    docker compose exec -T panel ct-server-core --json singbox render >/dev/null 2>&1
    docker compose restart sing-box >/dev/null 2>&1
    sleep 8
}

verify_singbox_domain_resolver() {
    ! detect_singbox_domain_resolver
}

# ============================================================
# RECIPE 9 - singbox_outbound_ipv4_only
# ============================================================
#
# Symptom shape (from a noob operator's perspective):
#   - The proxy "connects" but no actual websites load.
#   - The Mac client shows a green "Connected" indicator briefly,
#     then a "Connection reset" or "tunnel dropped" message.
#   - Browsers behind the proxy report "could not connect" on every site.
#
# Root cause (operator does not need to know this — only here for
# maintainers): the cloud provider advertises IPv6 connectivity but
# does not actually route it (Vultr is the canonical example). The
# server-side sing-box outbound dialer asks DNS for an address,
# receives an AAAA (IPv6) record first, tries to connect, and the
# kernel returns ENETUNREACH. sing-box then tears down the inbound
# tunnel, the Mac client sees a post-CONNECT reset, and the user
# concludes "the proxy doesn't work".
#
# Sing-box 1.13+ supports a "domain_resolver" directive that pins
# outbound resolution to IPv4 only. The repo's sing-box template
# emits that directive as of v0.1.2; this recipe re-renders the live
# config so an existing deployment picks up the directive, then
# restarts sing-box.

detect_singbox_outbound_ipv4_only() {
    # Only meaningful if sing-box is up (a restart-loop is somebody
    # else's recipe -- 6 / 7).
    docker compose ps --status running sing-box 2>/dev/null \
        | grep -q ct-singbox || return 1

    # If the host CAN reach the public internet over IPv6, this
    # recipe doesn't apply -- IPv6 is healthy, no forced-v4 needed.
    if curl -sS -6 --max-time 3 https://1.1.1.1/ >/dev/null 2>&1; then
        return 1
    fi

    # If the rendered config already includes the new-schema
    # domain_resolver directive, the renderer is up to date.
    local cfg=/var/lib/docker/volumes/cool-tunnel-server_singbox_etc/_data/config.json
    [[ -f "$cfg" ]] || return 1
    grep -q 'domain_resolver' "$cfg" && return 1

    # IPv6 unreachable on host AND config lacks the v4-only directive
    # -> broken state for proxy traffic.
    return 0
}

describe_singbox_outbound_ipv4_only() {
    cat <<'EOF'
Your server can't reach the public internet over IPv6.

That's common on cloud providers (Vultr is the usual one) that
advertise IPv6 in the welcome email but don't actually route IPv6
traffic to the open internet. As a result, every time the proxy
tries to fetch a website that DNS resolves to an IPv6 address first,
the connection fails -- and the Mac client sees the tunnel drop.

Symptom from the client side:
  - "Connected" indicator turns green for a moment
  - Then "connection reset" / "tunnel dropped"
  - Browsers can't load anything via the proxy

Fix: tell sing-box to prefer IPv4 when reaching the internet. We
ship a sing-box template (v0.1.2+) that emits the right directive.
This recipe re-runs the renderer so the running config picks up
the directive, then restarts sing-box once. Browsers / apps behind
the proxy work exactly the same after the fix -- every website
reachable over IPv6 is also reachable over IPv4.

If you upgraded from v0.1.1 and have a docker-compose.override.yml
that sets ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS=true as a
hotfix, this recipe also removes that file (no longer needed).
EOF
}

fix_singbox_outbound_ipv4_only() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1

    # Re-render config from the current template. ct-server-core
    # writes atomically via fsync -- safe to run while sing-box is up.
    docker compose exec -T panel ct-server-core --json singbox render \
        >/dev/null 2>&1 || return 1

    # If a previous hotfix dropped a docker-compose.override.yml with
    # ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS, retire it --
    # the new template doesn't need the legacy env var.
    if [[ -f docker-compose.override.yml ]] \
            && grep -q 'ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS' \
                docker-compose.override.yml; then
        rm -f docker-compose.override.yml
        # Recreate (not restart) so the now-removed env var goes away.
        docker compose up -d sing-box >/dev/null 2>&1
    else
        docker compose restart sing-box >/dev/null 2>&1
    fi
    sleep 6
}

verify_singbox_outbound_ipv4_only() {
    local cfg=/var/lib/docker/volumes/cool-tunnel-server_singbox_etc/_data/config.json
    [[ -f "$cfg" ]] || return 1
    grep -q 'domain_resolver' "$cfg" || return 1
    # sing-box must actually be running (not restart-looping)
    docker compose ps --status running sing-box 2>/dev/null \
        | grep -q ct-singbox
}

# ============================================================
# RECIPE 10 - panel_restart_loop
# ============================================================
#
# The panel container restart-loops with "Restarting" or "Created"
# status. Historical root causes (v0.0.84 onward):
#   - composer install transient failure (network blip mid-build)
#   - ext-redis / symfony/redis-messenger version mismatch
#     (v0.0.94-class, fixed by v0.0.95+ image)
#   - Octane worker crash on first request (rare; usually a missing
#     APP_KEY or unmigrated schema)
#   - Migration error in entrypoint (covered by pending_migrations
#     recipe; this one is the broader catch-all)
#
# The fix is a safe two-step: pull the latest panel image (in case
# the operator is running an outdated, post-fix-not-applied build)
# then recreate the container. Idempotent.

detect_panel_restart_loop() {
    docker compose ps panel 2>/dev/null \
        | grep -qE 'Restarting|Created'
}

describe_panel_restart_loop() {
    cat <<'EOF'
The panel container is restart-looping (Docker shows "Restarting"
or "Created" instead of "Up"). The panel is the Laravel admin UI;
when it loops, the web UI is down, account changes don't save, and
new proxy users can't be created.

Common causes:
  - The panel image is older than the bug-fix in the source tree
    (you ran `git pull` but not `docker compose build`).
  - A transient composer install error mid-build.
  - A missing APP_KEY or unmigrated database schema (we have
    a separate recipe for the latter; pending_migrations).

Fix: pull/rebuild the panel image and recreate the container. Safe
to run — Docker keeps the old container until the new one comes up,
so there is no downtime window where the OLD panel is also gone.

After the recreate, the recipe waits up to 30 seconds for the
container to reach "Up healthy" before declaring success.
EOF
}

fix_panel_restart_loop() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    # Try a build (fast no-op if nothing changed) then recreate.
    docker compose build panel >/dev/null 2>&1 || true
    docker compose up -d --force-recreate panel >/dev/null 2>&1
    # Wait up to 30s for the new container to become healthy.
    local _attempt
    for _attempt in $(seq 1 15); do
        sleep 2
        if docker compose ps panel 2>/dev/null \
                | grep -qE 'Up.*healthy|Up [0-9]+.*$'; then
            return 0
        fi
    done
    return 1
}

verify_panel_restart_loop() {
    ! detect_panel_restart_loop
}

# ============================================================
# RECIPE 11 - pending_migrations
# ============================================================
#
# After restoring a backup taken on an older release, the DB schema
# is behind the code that's currently running. The panel entrypoint
# runs `migrate --force` on boot, but a failure mid-migration (or a
# manual restore that skipped the entrypoint) can leave the DB in
# the pending state. `artisan migrate:status` reveals it.

detect_pending_migrations() {
    # Skip if the panel isn't running — we can't artisan against it.
    docker compose ps --status running panel 2>/dev/null \
        | grep -q ct-panel || return 1
    # `migrate:status` returns 0 even with pending migrations; we
    # have to grep the table for the "Pending" column header value
    # to know if any rows are unmigrated.
    docker compose exec -T panel php artisan migrate:status 2>/dev/null \
        | grep -qE '^\s*\|\s*No\s*\|' \
        || return 1
    return 0
}

describe_pending_migrations() {
    cat <<'EOF'
The database schema is older than the code currently running.

This usually happens when you restore a backup that was taken on a
prior release and the DB now lacks tables / columns the new code
expects. Symptoms range from blank dashboard widgets to PHP errors
on every form submit ("Unknown column 'X' in field list").

Fix: run pending migrations forward. Laravel's `migrate --force`
is idempotent — already-applied migrations are skipped and the new
ones layer on cleanly. Data in existing tables is preserved.

This recipe does NOT touch table data; it only applies schema
changes from panel/database/migrations/*.php that haven't run yet.
EOF
}

fix_pending_migrations() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose exec -T panel php artisan migrate --force >/dev/null 2>&1
    sleep 2
}

verify_pending_migrations() {
    ! detect_pending_migrations
}

# ============================================================
# RECIPE 12 - messenger_queue_stuck
# ============================================================
#
# Symfony Messenger's Redis transport (cool_tunnel:messenger stream)
# is consumed by a supervisord-managed `messenger:consume` worker
# inside the panel container. If the worker dies and supervisord
# doesn't catch the SIGCHLD (rare but observed), the stream grows
# unbounded and revocations / async jobs back up.

detect_messenger_queue_stuck() {
    docker compose ps --status running panel 2>/dev/null \
        | grep -q ct-panel || return 1
    docker compose ps --status running redis 2>/dev/null \
        | grep -q ct-redis || return 1
    local depth
    depth=$(docker compose exec -T redis \
                redis-cli --no-auth-warning xlen cool_tunnel:messenger 2>/dev/null \
            | tr -d '[:space:]')
    [[ -z "$depth" ]] && return 1
    # >100 unprocessed messages = stuck worker (steady-state is ~0)
    (( depth > 100 ))
}

describe_messenger_queue_stuck() {
    cat <<'EOF'
The Symfony Messenger queue (Redis stream cool_tunnel:messenger)
has more than 100 unprocessed messages.

That means the background worker inside the panel container has
stopped consuming jobs — usually because it hit an exception and
supervisord did not respawn it (rare). Symptoms: revocations don't
take effect, scheduled jobs don't run, "the panel feels frozen"
on actions that fire async work.

Fix: restart the panel container. supervisord re-spawns the
messenger:consume worker on every panel boot, which clears the
stuck state. The queue drains over the next ~30 seconds as the
worker catches up.

No data loss — Redis Stream messages persist; the worker resumes
from the consumer-group offset and processes them in order.
EOF
}

fix_messenger_queue_stuck() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    docker compose restart panel >/dev/null 2>&1
    sleep 10
}

verify_messenger_queue_stuck() {
    ! detect_messenger_queue_stuck
}

# ============================================================
# RECIPE 13 - credential_drift (wraps auto_sync)
# ============================================================

detect_credential_drift() {
    docker compose exec -T panel ct-server-core guard credential-lock \
        >/dev/null 2>&1 && return 1
    return 0
}

describe_credential_drift() {
    cat <<'EOF'
The credential-lock guard reports NG: at least one of the four
surfaces (db / rendered / manifest / mac-config) has drifted
away from the others.

Fix: delegates to auto_sync.sh -- re-render sing-box config
from current DB state, restart sing-box, re-verify the guard.
EOF
}

fix_credential_drift() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    ./scripts/auto_sync.sh >/dev/null 2>&1
}

verify_credential_drift() {
    ! detect_credential_drift
}

# ============================================================
# RECIPE 14 - no_proxy_account
# ============================================================

detect_no_proxy_account() {
    docker compose ps --status running panel 2>/dev/null | grep -q ct-panel || return 1
    local count
    count=$(docker compose exec -T panel php artisan tinker --execute='
        echo \App\Models\ProxyAccount::where("enabled", true)->count();
    ' 2>/dev/null | tr -d '[:space:]' | tail -c 10)
    [[ "$count" == "0" ]]
}

describe_no_proxy_account() {
    cat <<'EOF'
No active proxy account exists in the database. Without one:
  - The anti-tracking probe (readiness check 10) has no
    credentials to test with and fails NG.
  - End-users have no subscription URL to import into their
    Mac client.

Fix: this recipe does NOT auto-create an account (because the
operator needs to choose a username + may want a memorable
password). Instead it prints the canonical recipe for creating
one. Run it manually:

  Option A (recommended -- via Filament UI, no password echoed):
    1. Log into https://panel.<DOMAIN>/admin
    2. Proxy Accounts -> New Proxy Account
    3. Enter username, click "Generate" for password, Create

  Option B (CLI, password echoes once -- scrub bash history after):
    docker compose exec -T panel php artisan tinker --execute='
        $pw = bin2hex(random_bytes(16));
        $a = new \App\Models\ProxyAccount();
        $a->username = "user1";
        $a->setCleartextPassword($pw);
        $a->enabled = true;
        $a->save();
        echo "user=user1 pw=" . $pw . PHP_EOL;
    '
EOF
}

fix_no_proxy_account() {
    printf "%snote: skip-fix recipe -- prints instructions; nothing to apply%s\n" \
        "${CT_YELLOW}" "${CT_RESET}"
    return 0
}

verify_no_proxy_account() {
    # Always returns 1 because the operator must take action manually
    ! detect_no_proxy_account
}

# ============================================================
# RECIPE 15 - legacy_env_shape
# ============================================================

detect_legacy_env_shape() {
    [[ -f .env ]] || return 1
    # Pre-v0.0.68: APP_URL=https://${DOMAIN}/admin (apex hostname) instead
    # of APP_URL=https://${PANEL_DOMAIN}/admin
    grep -qE '^APP_URL=https?://\$\{DOMAIN\}' .env
}

describe_legacy_env_shape() {
    cat <<'EOF'
Your .env file uses the pre-v0.0.68 APP_URL shape:

  APP_URL=https://${DOMAIN}/admin

This points the panel at the proxy apex hostname instead of
the dedicated panel subdomain, which causes Livewire to return
'419 PAGE EXPIRED' on every form submit (browser Origin header
mismatch vs the configured app URL host).

Fix: rewrite APP_URL to use ${PANEL_DOMAIN} instead. This is
exactly the auto-migration update.sh does on every run, so
the safest path is to run update.sh which is idempotent.
EOF
}

fix_legacy_env_shape() {
    cd /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.." || return 1
    ./scripts/update.sh
}

verify_legacy_env_shape() {
    ! detect_legacy_env_shape
}

# ============================================================
# MAIN
# ============================================================

printf '%sCool Tunnel Server -- fix agent%s\n' "${CT_BOLD}${CT_GREEN}" "${CT_RESET}"
printf '%s (host=%s, date=%s)%s\n' "${CT_BOLD}" \
    "$(hostname 2>/dev/null || echo '?')" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CT_RESET}"
printf '\nWalking %d recipes. For each detected issue you can:\n' "${#RECIPES[@]}"
printf '  [a]pply -- run the fix (shows what it does first)\n'
printf '  [s]kip  -- no action (default if you just press Enter)\n'
printf '  [e]xplain -- show the recipe details\n'
printf '  [q]uit  -- stop the agent immediately\n\n'

for slug in "${RECIPES[@]}"; do
    run_recipe "$slug"
    rc=$?
    if (( rc == 99 )); then
        break
    fi
done

# ---------- Summary -----------------------------------------------

printf '\n%sSummary:%s\n' "${CT_BOLD}" "${CT_RESET}"
printf '  %s✓%s %d recipes OK on first check\n' "${CT_GREEN}" "${CT_RESET}" "$TOTAL_OK"
printf '  %s!%s %d issues detected\n' "${CT_YELLOW}" "${CT_RESET}" "$TOTAL_DETECTED"
printf '    %s•%s %d fixed\n' "${CT_GREEN}" "${CT_RESET}" "$TOTAL_FIXED"
printf '    %s•%s %d skipped\n' "${CT_YELLOW}" "${CT_RESET}" "$TOTAL_SKIPPED"
printf '    %s•%s %d fix attempts failed\n' "${CT_RED}" "${CT_RESET}" "$TOTAL_FAILED"

if (( TOTAL_FAILED > 0 )); then
    exit 1
fi
exit 0
