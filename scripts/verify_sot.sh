#!/usr/bin/env bash
# verify_sot.sh — Cycle 3 / v0.0.55 cross-language SoT validator.
#
# The "panel hostname" derivation lives in TWO implementations:
#   - PHP:  panel/config/cool-tunnel.php::panel_domain
#   - Rust: core/ct-server-core/src/util/domain.rs::panel_domain
#
# Both must agree byte-for-byte for any given (PANEL_DOMAIN, DOMAIN)
# env pair. This script runs both implementations against a set of
# fixture envs and asserts equivalence.
#
# Cross-language fail-mode reconciliation:
#   - PHP returns empty string when both envs unset (deferred fail —
#     Laravel's config-load runs in non-runtime contexts like phpunit
#     and larastan, where throwing would crash bootstrap).
#   - Rust returns non-zero exit when both envs unset (fail-fast —
#     Rust's CLI invocations are always runtime).
# This script treats `PHP empty + Rust non-zero exit` as equivalent
# fail signals; cross-language SoT parity is preserved.
#
# Wired into `make verify-sot` (and reachable from `make ci` via the
# new sot target). Runs without docker — exercises both languages
# via their respective standalone runtimes.

set -euo pipefail
cd "$(dirname "$0")/.."

PASSED=0
FAILED=0

run_php() {
    local domain="$1" panel_domain="$2"
    # shellcheck disable=SC2016
    # ^ the PHP -r block intentionally uses single quotes; we want
    # PHP variables ($_ENV, $cfg) to remain literal for the PHP
    # interpreter, not expanded by bash here.
    DOMAIN="$domain" PANEL_DOMAIN="$panel_domain" \
    php -r '
        require "panel/vendor/autoload.php";
        // Make Laravel-style env() readable without bootstrapping the
        // full framework. We only care about reading process env,
        // which is what env() falls through to when phpdotenv is
        // absent.
        $_ENV["DOMAIN"] = getenv("DOMAIN") ?: "";
        $_ENV["PANEL_DOMAIN"] = getenv("PANEL_DOMAIN") ?: "";
        if (!function_exists("env")) {
            function env($k, $d=null) {
                $v = $_ENV[$k] ?? null;
                return $v !== null && $v !== "" ? $v : $d;
            }
        }
        $cfg = require "panel/config/cool-tunnel.php";
        echo $cfg["panel_domain"];
    ' 2>/dev/null
}

run_rust() {
    local domain="$1" panel_domain="$2"
    DOMAIN="$domain" PANEL_DOMAIN="$panel_domain" \
    "${CARGO:-cargo}" run \
        --quiet \
        --manifest-path core/Cargo.toml \
        --bin ct-server-core \
        -- admin panel-domain 2>/dev/null
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
        # Equivalence rule for the all-empty fixture: PHP empty
        # string AND Rust non-zero exit. Both are "fail signals".
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

echo "=== Cycle 3 / v0.0.55 — Panel-hostname SoT cross-language verification ==="

# Fixture 1: PANEL_DOMAIN explicitly set takes priority.
assert_match \
    "explicit PANEL_DOMAIN takes priority" \
    "example.com" \
    "admin.example.com" \
    "admin.example.com"

# Fixture 2: empty PANEL_DOMAIN, DOMAIN set → fallback to panel.<DOMAIN>.
assert_match \
    "empty PANEL_DOMAIN falls back to panel.<DOMAIN>" \
    "example.com" \
    "" \
    "panel.example.com"

# Fixture 3: empty DOMAIN with explicit PANEL_DOMAIN works.
assert_match \
    "empty DOMAIN with explicit PANEL_DOMAIN" \
    "" \
    "admin.example.com" \
    "admin.example.com"

# Fixture 4: whitespace-only PANEL_DOMAIN treated as empty.
assert_match \
    "whitespace PANEL_DOMAIN trimmed → fallback" \
    "example.com" \
    "   " \
    "panel.example.com"

# Fixture 5: both empty → fail signal (PHP empty, Rust non-zero exit).
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
