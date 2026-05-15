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

# component_check_strict [<manifests-dir>]
#
# Run the Rust component checker and fail when any row reports NG.
# `ct-server-core component check` intentionally exits 0 after
# printing a mixed OK/NG table because the Filament Components page
# and JSON callers need the full diagnostic payload. Deployment
# scripts need stricter semantics: a visible NG row means the release
# is not healthy enough to declare success. Keep the policy here so
# install/update/restore/late-night checks agree on the same contract.
component_check_strict() {
    local manifests="${1:-/srv/manifests}"
    local out
    out=$(mktemp)

    if ! docker compose exec -T panel ct-server-core component check \
            --manifests "$manifests" | tee "$out"; then
        rm -f "$out"
        return 1
    fi

    if grep -qE '^[[:space:]]*NG[[:space:]]' "$out"; then
        rm -f "$out"
        return 1
    fi

    rm -f "$out"
    return 0
}

# ---------- Diagnostic-block error reporting -----------------------
#
# `die` (above) prints a one-line failure + one-line "↳ try:" hint.
# Good for the common case. Inadequate when the operator needs
# multi-line context to act — e.g. "git pull blocked by uncommitted
# changes" needs to show *what* is uncommitted, *why* it's blocking,
# and *which three options* the operator can choose.
#
# `die_with_diag` is for those cases. Caller passes a one-line
# summary + a multi-line body (printed verbatim, indented). The
# body is heredoc-friendly — see update.sh for canonical examples.

# die_with_diag <summary> <body>
#
# Print:  ✗ FAILED <summary>
#         Diagnostic:
#           <body, line-by-line, indented 2 spaces>
# Then exit 1.
die_with_diag() {
    local summary="$1"
    shift || true
    local body="${*:-}"
    printf "\n%s✗ FAILED%s %s\n" "${CT_RED}${CT_BOLD}" "${CT_RESET}" "$summary" >&2
    if [[ -n "$body" ]]; then
        printf "\n%sDiagnostic:%s\n" "${CT_BOLD}" "${CT_RESET}" >&2
        printf '%s\n' "$body" | sed 's/^/  /' >&2
        printf "\n" >&2
    fi
    exit 1
}

# ---------- Pre-flight bundle (v0.0.96 maintain-UX rewrite) -------
#
# The helpers in this section are designed to run at the TOP of any
# operator-facing maintain script (update.sh, install.sh, restore.sh).
# Each one either:
#   - passes silently / with one `ok` line, or
#   - dies with a `die_with_diag` block that tells the operator what
#     to do next.
#
# Operator-tested rule: an error block must contain (1) the failure,
# (2) a plain-English diagnosis, (3) ≥ 2 concrete commands to try.
# A one-line "↳ try: stash or commit your local edits first" is not
# enough — that's the gap v0.0.96 closes.

# preflight_clean_tree
#
# Refuse to proceed when the git working tree has uncommitted
# changes. Interactive: shows a stat summary + diff preview, then
# offers stash / discard / abort. Non-interactive: prints a
# diagnostic block and exits (never silently overwrites local state).
#
# Returns 0 (tree clean or stash succeeded) or dies. Tested on the
# v0.0.95 production incident where an operator hand-rolled-back
# v0.0.93 directly on the VPS, then `update.sh`'s `git pull` died
# with a generic "uncommitted changes?" message that left them
# stuck.
preflight_clean_tree() {
    if git diff --quiet HEAD 2>/dev/null \
       && git diff --quiet --cached 2>/dev/null; then
        ok "working tree clean"
        return 0
    fi

    printf "\n  %s!%s Working tree has uncommitted changes:\n\n" \
        "${CT_YELLOW}" "${CT_RESET}" >&2
    git diff --stat HEAD 2>/dev/null | sed 's/^/    /' >&2
    printf "\n  Preview (first 30 lines of diff):\n" >&2
    git diff HEAD 2>/dev/null | head -30 | sed 's/^/    /' >&2
    printf "\n" >&2

    if [[ ! -t 0 ]]; then
        # `read -r -d ''` pattern (not `$(cat <<EOF...)`) because
        # the latter triggers a bash parser bug: parentheses
        # inside the heredoc body confuse the substitution's
        # paren-counter and produce "unexpected EOF" errors.
        # `read -d ''` reads to NUL (which is never present in
        # the heredoc), hits EOF, returns non-zero — hence the
        # trailing `|| true`. Used consistently across lib.sh.
        local diag
        read -r -d '' diag <<'EOF' || true
Running non-interactively, so this script will not auto-decide.

To preserve the edits and proceed:
  git stash push -u -m "preflight-$(date -u +%Y%m%dT%H%M%SZ)"
  ./scripts/update.sh

To discard the edits and proceed:
  git checkout -- .
  ./scripts/update.sh

To inspect what is there before deciding:
  git diff HEAD
  git stash list   # if you have stashed before
EOF
        die_with_diag "uncommitted changes block git pull" "$diag"
    fi

    local choice
    while true; do
        printf "  How do you want to proceed?\n" >&2
        printf "    [s] stash with timestamp label (preserves edits, recoverable via 'git stash pop')\n" >&2
        printf "    [d] discard local edits (NOT recoverable)\n" >&2
        printf "    [a] abort — I'll handle it manually\n" >&2
        printf "  choice [s/d/a]: " >&2
        IFS= read -r choice
        case "${choice:-a}" in
            s|S)
                local label
                label="preflight-$(date -u +%Y%m%dT%H%M%SZ)"
                if git stash push -u -m "$label"; then
                    ok "stashed as '$label' (recover with: git stash pop)"
                    return 0
                else
                    local stash_diag
                    read -r -d '' stash_diag <<'EOF' || true
git refused to stash -- usually means the index is in a
broken state. Inspect with:
  git status
  git stash list
If you see an in-progress merge / rebase / cherry-pick:
  git merge --abort  (or rebase --abort, etc.)
EOF
                    die_with_diag "git stash failed" "$stash_diag"
                fi
                ;;
            d|D)
                if prompt_yn "Discard ALL uncommitted changes to TRACKED files? (untracked files preserved)" n; then
                    git checkout -- .
                    ok "tracked-file changes reverted (untracked files left alone)"
                    return 0
                fi
                continue
                ;;
            a|A)
                local abort_diag
                read -r -d '' abort_diag <<'EOF' || true
You chose to handle this manually. The diff is shown above.
When ready to retry, run:
  ./scripts/update.sh
EOF
                die_with_diag "aborted on uncommitted changes" "$abort_diag"
                ;;
            *)
                printf "    please answer s, d, or a\n" >&2
                continue
                ;;
        esac
    done
}

# preflight_disk_space [<min_repo_gb>] [<min_docker_gb>]
#
# Refuse to proceed when free disk under the repo path OR under
# docker's data-root is below the threshold. Defaults: 2 GB repo,
# 4 GB docker. Override per-invocation via CT_MIN_REPO_GB /
# CT_MIN_DOCKER_GB env vars. Running out of disk mid-build is the
# messiest failure class — half-built panel image, confused
# composer install, ENOSPC sentinel in the entrypoint log.
preflight_disk_space() {
    local min_repo_gb="${1:-${CT_MIN_REPO_GB:-2}}"
    local min_docker_gb="${2:-${CT_MIN_DOCKER_GB:-4}}"

    local repo_free_kb repo_free_gb
    repo_free_kb=$(df -k . 2>/dev/null | awk 'NR==2 {print $4}')
    repo_free_gb=$(( ${repo_free_kb:-0} / 1024 / 1024 ))
    if (( repo_free_gb < min_repo_gb )); then
        local repo_disk_diag
        read -r -d '' repo_disk_diag <<'EOF' || true
Compose build, git pull, and composer install all need scratch
space; running out mid-update corrupts the build cache.

What to free (priority order, most-impact first):
  docker system prune -af        # stopped containers + dangling images
  docker builder prune -af       # buildkit cache (1-3 GB typical)
  rm -rf core/target             # Rust build cache (2-5 GB)
  du -h --max-depth=1 / | sort -rh | head    # find the actual offender

Re-run ./scripts/update.sh after freeing space.
EOF
        die_with_diag "low disk under repo path: ${repo_free_gb}G free, need >= ${min_repo_gb}G" \
            "$repo_disk_diag"
    fi

    local docker_root docker_free_kb docker_free_gb
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
    docker_free_kb=$(df -k "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}')
    docker_free_gb=$(( ${docker_free_kb:-0} / 1024 / 1024 ))
    if (( docker_free_gb < min_docker_gb )); then
        local docker_disk_diag
        docker_disk_diag=$(printf '%s\n' \
            "Compose pull + build will store image layers under $docker_root." \
            "Out-of-space mid-build typically surfaces as 'no space left on" \
            "device' partway through, leaving a half-built panel image and a" \
            "confused stack." \
            "" \
            "What to free (priority order):" \
            "  docker system prune -af" \
            "  docker builder prune -af" \
            "  docker volume ls -qf dangling=true | xargs -r docker volume rm" \
            "  du -sh $docker_root/overlay2/*  | sort -rh | head")
        die_with_diag "low disk under docker root ($docker_root): ${docker_free_gb}G free, need >= ${min_docker_gb}G" \
            "$docker_disk_diag"
    fi

    ok "disk space OK (repo: ${repo_free_gb}G, docker: ${docker_free_gb}G)"
}

# preflight_stack_up <service...>
#
# Verify each named compose service has at least one container in
# `running` or `restarting` state. `restarting` counts as "up" so
# we don't refuse to operate during the very crisis we're trying
# to recover from (the v0.0.94 restart-loop on production was the
# motivating case).
#
# Dies with a "did you mean install.sh?" diagnostic when ALL
# services are down — that's almost always operator confusion
# about which script to run on a fresh box.
preflight_stack_up() {
    local services=("$@")
    if (( ${#services[@]} == 0 )); then
        ok "preflight_stack_up: no services specified, skipping"
        return 0
    fi

    local missing=() running_count=0
    for svc in "${services[@]}"; do
        if docker compose ps --status running --status restarting --services 2>/dev/null \
                | grep -qxF "$svc"; then
            running_count=$((running_count + 1))
        else
            missing+=("$svc")
        fi
    done

    if (( ${#missing[@]} == 0 )); then
        ok "stack is up (${running_count}/${#services[@]} services running)"
        return 0
    fi

    if (( running_count == 0 )); then
        local stack_diag
        stack_diag=$(printf '%s\n' \
            "None of the expected services are running:" \
            "  ${services[*]}" \
            "" \
            "You probably want install.sh, not update.sh. update.sh assumes a" \
            "live stack and reuses its volumes + cache." \
            "" \
            "What to do:" \
            "  First-time setup on a fresh box:" \
            "    ./scripts/install.sh" \
            "" \
            "  Stack was running and crashed:" \
            "    docker compose ps                # what is the state?" \
            "    docker compose logs --tail=80    # what blew up?" \
            "    docker compose up -d             # bring it back up" \
            "    ./scripts/update.sh              # then update")
        die_with_diag "stack is entirely down" "$stack_diag"
    fi

    warn "stack is partially up — these services are NOT running: ${missing[*]}"
    warn "update will try to bring them back up alongside the rebuild"
}

# preflight_network [<host>...]
#
# Verify outbound HTTPS reachability to github.com (for git pull)
# and registry-1.docker.io (for image pulls + buildkit). Caller
# can override the host list. Update fails mysteriously on offline
# VPSes; surfacing this up front saves the operator from a 5-
# minute wait for compose to time out twice.
#
# v0.0.97 — drop the `-f` flag from the curl call. Pre-v0.0.97
# used `curl -fsSI`, which `-f` makes return non-zero on any HTTP
# 4xx/5xx response. registry-1.docker.io/ returns 401 to an
# unauthenticated request — perfectly valid behaviour, the
# registry IS reachable — but `-f` rejected that as a connection
# failure. Operators on a freshly-rebuilt VPS hit "cannot reach
# registry-1.docker.io" even though the network was fine.
# The reachability check should pass on ANY HTTP response code
# (the network round-trip completed); it should only fail on
# real connection-level errors (DNS NXDOMAIN, connection refused,
# TLS handshake timeout). `curl -sS` without `-f` returns 0 for
# any successful HTTP transaction regardless of status code, so
# the single-call form below is both simpler and more correct
# than the two-call fallback ladder it replaces.
preflight_network() {
    local hosts=("$@")
    if (( ${#hosts[@]} == 0 )); then
        hosts=(github.com registry-1.docker.io)
    fi

    local unreachable=()
    for h in "${hosts[@]}"; do
        if ! curl -sS --connect-timeout 5 --max-time 10 \
                 -o /dev/null "https://$h/" 2>/dev/null; then
            unreachable+=("$h")
        fi
    done

    if (( ${#unreachable[@]} > 0 )); then
        local network_diag
        read -r -d '' network_diag <<'EOF' || true
Update needs to git pull (github.com) and pull image layers
(registry-1.docker.io). One or both is unreachable.

What to check (in priority order):
  ping -c 3 1.1.1.1                  # internet reachable at all?
  dig +short github.com              # DNS resolving?
  curl -v https://github.com/        # outbound 443 not blocked?
  printenv HTTPS_PROXY               # corporate proxy needed?
  docker info | grep -A3 Registry    # registry mirror configured?

When the network is back, re-run:
  ./scripts/update.sh
EOF
        die_with_diag "network: cannot reach ${unreachable[*]}" "$network_diag"
    fi

    ok "network reachable (${hosts[*]})"
}
