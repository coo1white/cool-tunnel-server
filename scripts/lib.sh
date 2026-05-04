#!/usr/bin/env bash
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
die() {
    local msg="$1"
    shift || true
    local hint="${*:-}"
    printf "\n%s✗ FAILED%s %s\n" "${CT_RED}${CT_BOLD}" "${CT_RESET}" "$msg" >&2
    if [[ -n "$hint" ]]; then
        printf "  %s↳ try:%s %s\n" "${CT_BOLD}" "${CT_RESET}" "$hint" >&2
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

# ---------- Asynchronous waits -------------------------------------

# wait_for <description> <max_attempts> <sleep_seconds> <command...>
#
# Poll a command until it exits zero. Prints a friendly progress
# indicator. die() on timeout.
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
    die "$desc never came up after $((max * delay))s"
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

# prompt_secret "Admin password"
#
# Read a secret without echoing. Echoes a newline after.
prompt_secret() {
    local q="$1"
    if [[ ! -t 0 ]]; then
        die "cannot read $q without a TTY"
    fi
    printf "    %s: " "$q" >&2
    local secret
    IFS= read -rs secret
    printf "\n" >&2
    printf "%s" "$secret"
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

# compose <args>
#
# Wrapper so all compose calls go through one place — easier to add
# logging or `--env-file` overrides later.
compose() {
    docker compose "$@"
}
