#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# scripts/lib.sh — shared helpers, sourced by every install / update /
# backup / late-night-comeback script.
#
# Exists for two reasons:
#
#  1. Shellcheck cleanliness. Each helper here has been reviewed
#     against shellcheck.net's standard set; using them through this
#     library means the per-script copies stay tiny and readable.
#
#  2. Friendly first-time-user output. The `step`, `ok`, `warn`, and
#     `die` helpers print colour-coded, numbered progress so a
#     first-time operator on a fresh Debian box has a fighting chance
#     of figuring out which step failed and why.
#
# Sourcing convention:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   cd "$(dirname "$0")/.." || exit 1
#   . scripts/lib.sh
#
# Then use `step`, `ok`, `warn`, `die`, `require_cmd`, `require_file`,
# `wait_for`, `prompt_yn`. Examples in install.sh / update.sh.

# shellcheck disable=SC2034  # vars below are exported for child scripts
CT_LIB_VERSION="0.0.3"

# ---------- Colour-aware output ------------------------------------

# Detect whether stdout is a TTY; only emit ANSI colour codes if so.
# CI / piped output stays plain.
if [[ -t 1 ]]; then
    CT_BOLD=$'\033[1m'
    CT_GREEN=$'\033[32m'
    CT_YELLOW=$'\033[33m'
    CT_RED=$'\033[31m'
    CT_RESET=$'\033[0m'
else
    CT_BOLD=""
    CT_GREEN=""
    CT_YELLOW=""
    CT_RED=""
    CT_RESET=""
fi

CT_STEP_NUM=0

# step "Doing the thing"
#
# Print a numbered "==>" header. Shows progress and gives operators a
# concrete reference when reporting an issue ("step 4 failed with X").
step() {
    CT_STEP_NUM=$((CT_STEP_NUM + 1))
    printf "\n%s==>%s %s%d.%s %s\n" \
        "${CT_BOLD}${CT_GREEN}" "${CT_RESET}" \
        "${CT_BOLD}" "${CT_STEP_NUM}" "${CT_RESET}" \
        "$*"
}

# ok "Things look good"
ok() {
    printf "    %s✓%s %s\n" "${CT_GREEN}" "${CT_RESET}" "$*"
}

# warn "Heads up"
warn() {
    printf "    %s!%s %s\n" "${CT_YELLOW}" "${CT_RESET}" "$*" >&2
}

# die "Something broke" [hint "Try running X to recover"]
#
# Prints a clear failure block with the optional remediation hint and
# exits 1. Hint is what new operators most often need.
#
# Additionally, every die() now appends a universal "stuck? Run: ct fix"
# pointer so a new operator who hits a failure they don't understand
# always has a one-command escape hatch. The pointer is suppressed by
# CT_NO_FIX_HINT=1 (set by fix.sh itself so its own diagnostics don't
# recursively recommend their own agent).
die() {
    local msg="$1"
    shift || true
    local hint="${*:-}"
    printf "\n%s✗ FAILED%s %s\n" "${CT_RED}${CT_BOLD}" "${CT_RESET}" "$msg" >&2
    if [[ -n "$hint" ]]; then
        printf "  %s↳ try:%s %s\n" "${CT_BOLD}" "${CT_RESET}" "$hint" >&2
    fi
    if [[ -z "${CT_NO_FIX_HINT:-}" ]]; then
        printf "  %s↳ stuck?%s Run:  %sct fix%s   (interactive diagnose-and-repair)\n" \
            "${CT_BOLD}" "${CT_RESET}" "${CT_BOLD}${CT_GREEN}" "${CT_RESET}" >&2
    fi
    exit 1
}

# ---------- Pre-flight checks --------------------------------------

# require_cmd <command> [<install hint for Debian>]
#
# Verify a binary is on PATH; die with an actionable apt suggestion
# when missing. Defaults assume Debian / Ubuntu.
require_cmd() {
    local cmd="$1"
    local hint="${2:-apt install -y $cmd}"
    command -v "$cmd" >/dev/null 2>&1 \
        || die "required command '$cmd' is not on PATH" "$hint"
}

# require_file <path> [<remediation hint>]
require_file() {
    local path="$1"
    local hint="${2:-create it before continuing}"
    [[ -e "$path" ]] || die "required file '$path' is missing" "$hint"
}

# require_env <VAR> [<hint>]
#
# Confirms an env var is set and non-empty. Useful right after sourcing
# .env to fail fast on placeholder values.
require_env() {
    local var="$1"
    local hint="${2:-edit .env and set $var}"
    if [[ -z "${!var:-}" ]]; then
        die "env var $var is empty" "$hint"
    fi
}

# load_env [<path>]
#
# Source a .env file with shellcheck-friendly handling. Default path
# is `.env` in the current working directory.
#
# Common operator papercut: bcrypt hashes and random passwords often
# contain literal $ characters. Without single quotes, bash sees
# `$2y$10$...` as the positional arg $2 followed by literal text —
# `set -u` then aborts with "$2: unbound variable". We pre-scan for
# the most common shape and print a friendlier pointer before
# letting the actual source error fire.
load_env() {
    local path="${1:-.env}"
    require_file "$path" "cp .env.example .env  &&  \$EDITOR .env"
    # Scan for unquoted bcrypt hashes — pattern is KEY=$2y$10$..., or
    # =$2a$, =$2b$. Anything starting with =$ that isn't already
    # opened with a quote is suspect.
    if grep -nE '^[A-Z_][A-Z0-9_]*=\$2[ayb]\$' "$path" >/dev/null; then
        echo "" >&2
        echo "  ✗ .env has an unquoted bcrypt hash. Bash reads \$2 / \$1 etc. as" >&2
        echo "    positional args during 'set -a; . .env' and aborts." >&2
        echo "    Wrap the value in SINGLE quotes:" >&2
        echo "" >&2
        grep -nE '^[A-Z_][A-Z0-9_]*=\$2[ayb]\$' "$path" \
            | sed 's/^/      /' >&2
        echo "" >&2
        echo "    Change   SOME_HASH=\$2y\$10\$abc..." >&2
        echo "    To       SOME_HASH='\$2y\$10\$abc...'" >&2
        echo "" >&2
        return 1
    fi
    set -a
    # shellcheck source=/dev/null
    . "$path"
    set +a
}

# ---------- Portable filesystem helpers ----------------------------

# file_mode_octal <path>
#
# Print the file's mode as an octal string (e.g. `0600`, `644`).
# Portable across GNU coreutils (`stat -c '%a'`) and BSD/macOS
# (`stat -f '%OLp'`). Round-21 cross-platform audit: install.sh
# previously used `stat -c '%a'` directly, which fails on macOS
# (and any BSD) with `stat: illegal option -- c` — confusing for
# a developer trying to run install.sh outside Linux for testing.
# Same invariant on output (octal digits) regardless of host
# coreutils flavour.
file_mode_octal() {
    local path="$1"
    if stat -c '%a' "$path" 2>/dev/null; then
        return 0
    fi
    if stat -f '%OLp' "$path" 2>/dev/null; then
        return 0
    fi
    return 1
}

# ---------- Asynchronous waits -------------------------------------

# wait_for <description> <max_attempts> <sleep_seconds> <command...>
#
# Poll a command until it exits zero. Prints a friendly progress
# indicator. die() on timeout.
#
# Optional environment variable: WAIT_FOR_HINT. When set, the
# value is passed as the second `die` argument on timeout —
# surfaces as `↳ try: <hint>` in the operator-facing output.
# Use this to give the next-step diagnostic for waits where
# "never came up after Ns" leaves the operator stuck (most
# commonly: ACME cert acquisition, where 90s of silence could
# mean any of four distinct failures). Round-16 error-message-
# UX audit.
wait_for() {
    local desc="$1" max="$2" delay="$3"
    shift 3
    local i
    for ((i = 1; i <= max; i++)); do
        if "$@" >/dev/null 2>&1; then
            ok "$desc (after ${i} attempt$([[ $i -ne 1 ]] && echo s))"
            return 0
        fi
        printf "    waiting for %s … %d/%d\r" "$desc" "$i" "$max" >&2
        sleep "$delay"
    done
    printf "\n" >&2
    if [[ -n "${WAIT_FOR_HINT:-}" ]]; then
        die "$desc never came up after $((max * delay))s" "$WAIT_FOR_HINT"
    else
        die "$desc never came up after $((max * delay))s"
    fi
}

# ---------- Interactive prompts ------------------------------------

# prompt_yn "Continue?" [default: y|n]
#
# Returns 0 on yes, 1 on no. Defaults to no when stdin isn't a TTY
# (so non-interactive runs don't hang forever).
prompt_yn() {
    local q="$1" default="${2:-n}" reply
    if [[ ! -t 0 ]]; then
        printf "    (non-interactive: defaulting to '%s')\n" "$default" >&2
        [[ "$default" == "y" ]] && return 0 || return 1
    fi
    while true; do
        local hint
        case "$default" in
            y|Y) hint="[Y/n]" ;;
            *)   hint="[y/N]" ;;
        esac
        printf "    %s %s " "$q" "$hint" >&2
        IFS= read -r reply
        reply="${reply:-$default}"
        case "$reply" in
            y|Y|yes|YES) return 0 ;;
            n|N|no|NO)   return 1 ;;
            *) printf "    please answer y or n\n" >&2 ;;
        esac
    done
}

# ---------- Docker helpers -----------------------------------------

# require_docker
#
# Verify Docker + Compose v2 are usable.
require_docker() {
    require_cmd docker "Install per docs/installation-debian.md (uses Docker's official apt repo)."
    docker compose version >/dev/null 2>&1 \
        || die "docker compose v2 not available" \
               "Install with: apt install -y docker-compose-plugin"
}

# disable_ipv6_if_broken
#
# v0.1.9: many cheap VPSes (Vultr, RackNerd, …) advertise IPv6 in the
# kernel but have no working global routing. Docker buildkit prefers
# IPv6 for outbound DNS / HTTPS, then dies on `static.rust-lang.org`
# during the Rust build step with `Network unreachable`. We detect
# this by checking for any global-scope IPv6 address; absence means
# the host has no usable IPv6. In that case we permanently disable
# it at sysctl + docker daemon layers.
#
# Idempotent — safe to call from bootstrap.sh and install.sh; second
# invocation is a no-op because the config files already exist.
# Honours CT_SKIP_IPV6_AUTO_DISABLE=1 for operators who explicitly
# want to keep IPv6 enabled despite a missing global address.
disable_ipv6_if_broken() {
    [[ "${CT_SKIP_IPV6_AUTO_DISABLE:-}" == "1" ]] && return 0
    # Already disabled? Nothing to do.
    if [[ -f /etc/sysctl.d/99-disable-ipv6.conf ]]; then
        return 0
    fi
    # Has at least one globally-routable IPv6 address? Keep IPv6 enabled.
    if ip -6 addr show scope global 2>/dev/null | grep -q 'inet6'; then
        return 0
    fi
    # No working IPv6 — disable to prevent buildkit / rustup failures.
    warn "no global IPv6 address detected → disabling IPv6 to keep docker buildkit"
    warn "from preferring it (Vultr/RackNerd-class cheap-VPS protection)"
    sudo_if_needed tee /etc/sysctl.d/99-disable-ipv6.conf >/dev/null <<'EOF'
# v0.1.9 — auto-written by scripts/lib.sh::disable_ipv6_if_broken
# because the host has no global IPv6 address. Remove to re-enable
# (and also delete the "ipv6" key in /etc/docker/daemon.json).
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
EOF
    sudo_if_needed sysctl --system >/dev/null 2>&1 || true
    sudo_if_needed mkdir -p /etc/docker
    if [[ ! -f /etc/docker/daemon.json ]]; then
        sudo_if_needed tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "ipv6": false,
  "dns": ["1.1.1.1", "8.8.8.8"]
}
EOF
        sudo_if_needed systemctl restart docker >/dev/null 2>&1 || true
    else
        warn "/etc/docker/daemon.json exists; not modifying. Manually add:"
        warn '    "ipv6": false, "dns": ["1.1.1.1","8.8.8.8"]'
    fi
}

# Helper: invoke `sudo` only if we're not already root, to keep both
# bootstrap.sh (often run as root via curl|bash) and install.sh (run
# from /opt/cool-tunnel-server) able to share this code path.
sudo_if_needed() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

# compose <args>
#
# Wrapper so all compose calls go through one place — easier to add
# logging or `--env-file` overrides later.
compose() {
    docker compose "$@"
}

# compose_project_name
#
# Print the docker-compose project name docker-compose itself will
# use for THIS working directory. Honours `COMPOSE_PROJECT_NAME`
# env override + any `name:` field in compose files; falls back to
# directory basename otherwise (which is docker-compose's default).
#
# Round-24 operator-workflow audit: backup.sh + restore.sh
# previously hardcoded `cool-tunnel-server_caddy_data` as the
# volume name, assuming the project name is exactly
# `cool-tunnel-server`. An operator running parallel deployments
# (e.g. `/opt/ct-prod/` and `/opt/ct-staging/`) would get
# different project names per deployment, but both backup/restore
# scripts would still target `cool-tunnel-server_caddy_data` —
# silently overwriting one deployment's ACME certs with the
# other's on restore. This helper sources the truth from
# docker-compose itself.
#
# Requires `compose ps` to work (i.e. valid compose files in the
# CWD). Caller should `require_docker` first.
compose_project_name() {
    local name
    name=$(docker compose config --format json 2>/dev/null \
        | jq -r '.name // empty' 2>/dev/null) || true
    if [[ -z "$name" ]]; then
        # Fallback: docker-compose's default project-name rule is
        # the basename of the project directory, lowercased and
        # stripped of any non-alphanumeric chars (cf. compose v2
        # docs). Most repo dirs match the rule already; the
        # transform here is a defensive cleanup.
        name="$(basename "$(pwd)" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')"
    fi
    printf '%s\n' "$name"
}

# acquire_op_lock
#
# Take an exclusive, non-blocking flock for the lifetime of the
# calling script. Per-project (round-24 multi-deploy: prod and
# staging on the same host don't serialise against each other);
# shared across install/update/backup/restore so any of them
# blocks the others. fd 9 is well outside typical script use; the
# kernel releases the lock on process exit, so no manual cleanup
# is needed (even on `kill -9` the fd closes and flock drops).
# See CHANGELOG [0.0.80].
acquire_op_lock() {
    require_cmd flock "apt install -y util-linux"
    local project lock_path
    project=$(compose_project_name)
    lock_path="/tmp/cool-tunnel-ops-${project}.lock"

    # shellcheck disable=SC2188  # the redirect IS the side effect (fd 9 open)
    exec 9>"$lock_path" \
        || die "could not open lock file $lock_path" \
               "check /tmp permissions and disk space"
    if ! flock -n 9; then
        die "another cool-tunnel operator script is already running for project '${project}'" \
            "lockfile: $lock_path  (try: lsof '$lock_path' to see who holds it)"
    fi
}

# component_check_strict [<ignored>]
#
# Compatibility wrapper for older shell entrypoints. The Rust
# component-check CLI was retired with the v0.4 control-plane split;
# the supported deploy gate is now the operator readiness check.
component_check_strict() {
    ./ct readiness
}
