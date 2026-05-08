#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# verify_sot_vps.sh — VPS-side cross-language SoT validator. Same
# fixture matrix as scripts/verify_sot.sh, but invokes both
# implementations via `docker compose exec` against the running
# panel container, so it needs no host toolchains beyond docker
# itself. (v0.0.56.)
#
# Why this exists separately from verify_sot.sh:
#   - verify_sot.sh runs PHP and cargo directly on the host. That's
#     what the dev-side `make ci` gate wants — fast, isolated,
#     no docker required. Operators on docker-only VPS hosts
#     (no apt-installed php / cargo) can't run that surface.
#   - This script is the operator's verification surface. It
#     re-runs the v0.0.55 contract — that the panel container's
#     PHP config and the panel container's ct-server-core CLI
#     resolve panel_domain identically — using the same five
#     fixtures, against whatever code is actually deployed.
#
# Cross-language fail-mode reconciliation is identical to the
# dev-side script: PHP returns empty string when both envs unset,
# Rust returns non-zero exit. Both treated as equivalent fail
# signals on fixture 5.
#
# Wired into `make verify-sot-vps`. NOT in `make ci` because it
# requires a running stack; that's the operator's tool, not the
# CI's.

set -euo pipefail
cd "$(dirname "$0")/.."

# Pre-flight: panel container must be running and exec-able.
# `docker compose exec -T panel true` is the cheapest way to
# probe both at once — it errors out if the service is missing,
# stopped, or unreachable. We swallow stderr so the operator
# sees our message, not docker's lower-level chatter.
if ! docker compose exec -T panel true >/dev/null 2>&1; then
    cat <<'EOF' >&2
=== verify-sot-vps — Cycle 3 SoT cross-language verification (VPS) ===
  ✗ panel container is not running (or `docker compose exec` failed)

Bring the stack up first:

    docker compose up -d

then re-run:

    make verify-sot-vps
EOF
    exit 1
fi

PASSED=0
FAILED=0

# PHP-side fixture runner. Invokes the same minimal-bootstrap
# pattern as scripts/verify_sot.sh::run_php (autoloader + env
# shim + direct config require), but inside the panel container's
# /var/www/html. Keeps the test isolated from the panel's own
# .env on disk (which would otherwise leak DOMAIN/PANEL_DOMAIN
# values from the live install and skew fixture 5's all-empty
# probe).
run_php() {
    local domain="$1" panel_domain="$2"
    docker compose exec -T \
        -e "DOMAIN=$domain" \
        -e "PANEL_DOMAIN=$panel_domain" \
        panel \
        php -r '
            chdir("/var/www/html");
            require "vendor/autoload.php";
            $_ENV["DOMAIN"] = getenv("DOMAIN") ?: "";
            $_ENV["PANEL_DOMAIN"] = getenv("PANEL_DOMAIN") ?: "";
            if (!function_exists("env")) {
                function env($k, $d=null) {
                    $v = $_ENV[$k] ?? null;
                    return $v !== null && $v !== "" ? $v : $d;
                }
            }
            $cfg = require "config/cool-tunnel.php";
            echo $cfg["panel_domain"];
        ' 2>/dev/null
}

# Rust-side fixture runner. Invokes the same admin subcommand
# the operator uses to sanity-check the deployment. The -e
# overrides in `docker compose exec` take precedence over the
# panel service's env_file, so the exec session sees fixture
# values rather than the live install's .env.
run_rust() {
    local domain="$1" panel_domain="$2"
    docker compose exec -T \
        -e "DOMAIN=$domain" \
        -e "PANEL_DOMAIN=$panel_domain" \
        panel \
        ct-server-core admin panel-domain 2>/dev/null
}

assert_match() {
    local label="$1" domain="$2" panel_domain="$3" expected="$4"
    local php_out rust_out rust_exit
    php_out=$(run_php "$domain" "$panel_domain")
    if rust_out=$(run_rust "$domain" "$panel_domain"); then
        rust_exit=0
    else
        rust_exit=$?
        rust_out=""
    fi

    if [ "$expected" = "<fail>" ]; then
        if [ -z "$php_out" ] && [ "$rust_exit" -ne 0 ]; then
            printf '  ✓ %s\n' "$label"
            PASSED=$((PASSED + 1))
            return 0
        fi
        printf '  ✗ %s\n' "$label"
        printf '      expected: <fail> (PHP empty + Rust non-zero exit)\n'
        printf '      PHP:      %q (empty=%s)\n' "$php_out" "$([ -z "$php_out" ] && echo true || echo false)"
        printf '      Rust:     %q (exit=%d)\n' "$rust_out" "$rust_exit"
        FAILED=$((FAILED + 1))
        return 1
    fi

    if [ "$php_out" = "$rust_out" ] && [ "$php_out" = "$expected" ] && [ "$rust_exit" -eq 0 ]; then
        printf '  ✓ %s\n' "$label"
        PASSED=$((PASSED + 1))
        return 0
    fi
    printf '  ✗ %s\n' "$label"
    printf '      expected: %q\n' "$expected"
    printf '      PHP:      %q\n' "$php_out"
    printf '      Rust:     %q (exit=%d)\n' "$rust_out" "$rust_exit"
    FAILED=$((FAILED + 1))
    return 1
}

echo "=== verify-sot-vps — Cycle 3 SoT cross-language verification (VPS) ==="

# Same five fixtures as scripts/verify_sot.sh — keep them in
# lockstep so dev-side and VPS-side surfaces probe identical
# contracts.

assert_match \
    "explicit PANEL_DOMAIN takes priority" \
    "example.com" \
    "admin.example.com" \
    "admin.example.com"

assert_match \
    "empty PANEL_DOMAIN falls back to panel.<DOMAIN>" \
    "example.com" \
    "" \
    "panel.example.com"

assert_match \
    "empty DOMAIN with explicit PANEL_DOMAIN" \
    "" \
    "admin.example.com" \
    "admin.example.com"

assert_match \
    "whitespace PANEL_DOMAIN trimmed → fallback" \
    "example.com" \
    "   " \
    "panel.example.com"

assert_match \
    "both empty fails fast" \
    "" \
    "" \
    "<fail>"

echo ""
echo "=== summary: ${PASSED} passed, ${FAILED} failed ==="
if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
