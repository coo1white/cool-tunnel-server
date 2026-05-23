#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# scripts/bootstrap.sh — one-line bootstrap for cool-tunnel-server.
#
# Designed to be the release-pinned Homebrew-style curl target
# referenced in README.md. Walks a fresh Debian 12+ VPS from
# "just SSH'd in" → "ready to edit .env and run ct install" in a
# single network round-trip.
#
# Idempotent: re-running is a no-op if Docker is already installed,
# the repo is already cloned, or .env already exists.
#
# Usage on a fresh VPS as root (Homebrew-style, release-pinned):
#   LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
#   BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
#
# Unattended mode (CI / Terraform / Ansible):
#   LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
#   DOMAIN=proxy.example.com \
#   PANEL_DOMAIN=panel.proxy.example.com \
#   ACME_EMAIL=ops@example.com \
#   AUTO_INSTALL=1 \
#   BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
#
# Override knobs (any can be set in the env before running):
#   INSTALL_DIR (default /opt/cool-tunnel-server)
#   REPO_URL    (default https://github.com/coo1white/cool-tunnel-server.git)
#   BRANCH      (default main)
#   DOMAIN, PANEL_DOMAIN, ACME_EMAIL — pre-fill .env
#   AUTO_INSTALL=1  — chain ct install after bootstrap
#                     (only valid when DOMAIN is also set)

set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cool-tunnel-server}"
REPO_URL="${REPO_URL:-https://github.com/coo1white/cool-tunnel-server.git}"
BRANCH="${BRANCH:-main}"

c_blue=$'\033[1;34m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
warn() { printf '%s!! %s%s\n' "$c_yellow" "$*" "$c_off" >&2; }
die()  { printf '%s!!! %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

explain_and_pause() {
    cat <<EOF

cool-tunnel-server bootstrap will:
  - install/verify Debian packages needed for setup
  - install Docker CE + Compose v2 if Docker is missing
  - clone or fast-forward ${REPO_URL} into ${INSTALL_DIR}
  - fetch the signed ct-operator binary when available
  - create ${INSTALL_DIR}/.env with generated secrets if it is missing

It will not start the proxy stack unless AUTO_INSTALL=1 is set.
EOF

    if [ "${AUTO_INSTALL:-0}" = "1" ] \
        || [ "${CT_BOOTSTRAP_NO_CONFIRM:-0}" = "1" ] \
        || [ "${NONINTERACTIVE:-0}" = "1" ]; then
        warn "non-interactive bootstrap mode — continuing without confirmation"
        return
    fi

    if [ ! -t 0 ]; then
        warn "stdin is not a TTY; continuing without confirmation"
        return
    fi

    printf '\nPress RETURN/ENTER to continue or any other key to abort: '
    IFS= read -r reply
    [ -z "$reply" ] || die "aborted before making changes"
}

# ---------- 1. preflight ---------------------------------------------------

[ "${EUID:-$(id -u)}" -eq 0 ] || die "must run as root (re-run via: sudo bash)"
[ -f /etc/debian_version ] || warn "tested on Debian 12+; YMMV on $(uname -a)"

explain_and_pause

# ---------- 2. apt deps + Docker -------------------------------------------

log "installing system packages (apt)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    ca-certificates curl gnupg git jq dnsutils apache2-utils openssl \
    > /dev/null

if ! command -v docker > /dev/null 2>&1; then
    log "installing Docker CE from docker.com…"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    # shellcheck disable=SC1091  # /etc/os-release is sourced at runtime, not analysable
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    arch="$(dpkg --print-architecture)"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian %s stable\n' \
        "$arch" "$codename" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin \
        > /dev/null
else
    log "docker already installed — skipping"
fi

# IPv4-only project default. This prevents release downloads and Docker
# pulls from drifting into broken provider IPv6 routes.
if [ "${CT_SKIP_IPV6_AUTO_DISABLE:-}" != "1" ]; then
    log "enforcing IPv4-only host + Docker networking"
    cat >/etc/sysctl.d/99-disable-ipv6.conf <<'EOF'
# auto-written by scripts/bootstrap.sh. Set CT_SKIP_IPV6_AUTO_DISABLE=1
# before bootstrap/update if you intentionally manage dual-stack routing.
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
EOF
    sysctl --system > /dev/null 2>&1 || true
    mkdir -p /etc/docker
    if [ -f /etc/docker/daemon.json ] && command -v jq >/dev/null 2>&1; then
        cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date -u +%Y%m%dT%H%M%SZ)"
        jq '. + {"ipv6": false} | if (.dns | type) == "array" and (.dns | length) > 0 then . else . + {"dns": ["1.1.1.1", "8.8.8.8"]} end' \
            /etc/docker/daemon.json > /tmp/cool-tunnel-daemon.json
        mv /tmp/cool-tunnel-daemon.json /etc/docker/daemon.json
    elif [ ! -f /etc/docker/daemon.json ]; then
        cat >/etc/docker/daemon.json <<'EOF'
{
  "ipv6": false,
  "dns": ["1.1.1.1", "8.8.8.8"]
}
EOF
    else
        warn '/etc/docker/daemon.json exists but jq is unavailable; ct install/update will merge IPv4-only Docker config'
    fi
    systemctl restart docker > /dev/null 2>&1 || true
    docker buildx prune -af > /dev/null 2>&1 || true
fi

# ---------- 3. clone (or fast-forward) -------------------------------------

if [ ! -d "$INSTALL_DIR/.git" ]; then
    log "cloning $REPO_URL → $INSTALL_DIR"
    git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
else
    log "$INSTALL_DIR already a git repo — fetching latest"
    git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
fi

cd "$INSTALL_DIR"

# Fetch the ct-operator binary now (idempotent; no-op if already on
# disk and SHA-matched). The 580-line install workflow is in TS now
# (operator/install.ts) — install.sh is a thin shim that prefers
# this binary. Doing the fetch here means the user's first
# `./scripts/install.sh` doesn't need a network round-trip + the
# fetch step is visible alongside the rest of the bootstrap output.
# Failure is non-fatal: install.sh retries the binary fetch and then
# prints actionable advice if no production operator binary is present.
./scripts/fetch_operator_binary.sh || warn "fetch_operator_binary failed; install.sh will retry"

# Install the friendly top-level command after the repo is present. The
# project-local ./ct keeps working either way, but a PATH shim prevents the
# common fresh-VPS mistake of typing `ct install` from the wrong directory and
# getting "command not found".
if [ -x ./ct ]; then
    install -d -m 0755 /usr/local/bin
    if [ -e /usr/local/bin/ct ] && [ ! -L /usr/local/bin/ct ]; then
        warn "/usr/local/bin/ct exists and is not a symlink; leaving it unchanged"
        warn "use ${INSTALL_DIR}/ct or ./ct from ${INSTALL_DIR}"
    else
        ln -sfn "${INSTALL_DIR}/ct" /usr/local/bin/ct
        log "installed /usr/local/bin/ct -> ${INSTALL_DIR}/ct"
    fi
else
    warn "repo dispatcher ./ct is missing or not executable; use ./scripts/install.sh as fallback"
fi

# ---------- 4. .env scaffold (auto-generate strong secrets) ----------------

if [ ! -f .env ]; then
    cp .env.example .env
    # Tighten before secrets land in this file. `cp` inherits the
    # operator's umask (0022 on Debian → 0644), but install.sh's
    # R2-1 audit gate refuses to proceed on a world-readable .env
    # (APP_KEY + DB credentials would leak via the filesystem).
    # Without this chmod the very next step blocks the operator
    # with a confusing "world-readable / try: chmod 0600 .env"
    # message on a file THIS script just created.
    chmod 0600 .env
    log "scaffolded $INSTALL_DIR/.env (mode 0600)"

    # generate random passwords for any unset/changeme placeholder
    gen_pass() { openssl rand -base64 30 | tr -d '/=+' | cut -c1-32; }
    for key in DB_PASSWORD DB_ROOT_PASSWORD REDIS_PASSWORD; do
        if grep -qE "^${key}=(\"\"|''|changeme.*)?$" .env 2> /dev/null; then
            new_val=$(gen_pass)
            # shellcheck disable=SC2002  # readability over UUOC
            sed -i "s|^${key}=.*|${key}=${new_val}|" .env
            log "  generated ${key}"
        fi
    done

    if [ -n "${DOMAIN:-}" ]; then
        sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
        log "  set DOMAIN=${DOMAIN}"
    fi
    if [ -n "${PANEL_DOMAIN:-}" ]; then
        sed -i "s|^PANEL_DOMAIN=.*|PANEL_DOMAIN=${PANEL_DOMAIN}|" .env
        log "  set PANEL_DOMAIN=${PANEL_DOMAIN}"
    fi
    if [ -n "${ACME_EMAIL:-}" ]; then
        sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" .env
        log "  set ACME_EMAIL=${ACME_EMAIL}"
    fi
else
    log ".env already exists — leaving it alone"
fi

# ---------- 5. next steps --------------------------------------------------

cat << EOF

=================================================================
Bootstrap complete.
Repo: ${INSTALL_DIR}

NEXT
----
  1. Verify your domain points at this VPS:
       dig +short A \$DOMAIN

  2. Edit ${INSTALL_DIR}/.env — set at minimum:
       DOMAIN=          # your full domain, e.g. proxy.example.com
       PANEL_DOMAIN=    # your panel domain, e.g. panel.proxy.example.com
       ACME_EMAIL=      # for Let's Encrypt cert issuance

     Random secrets for DB/Redis were generated.

  3. Run the 8-step install (numbered output, "↳ try:" hints
     on every failure):
       cd ${INSTALL_DIR}
       ct install

  4. Open the panel after ct install finishes:
       https://\${PANEL_DOMAIN:-panel.\${DOMAIN}}/admin
       login: holder / CT_BOOTSTRAP_ADMIN_PASSWORD from ${INSTALL_DIR}/.env
       change the password after first login
=================================================================
EOF

# ---------- 6. optionally chain ct install ---------------------------------

if [ "${AUTO_INSTALL:-0}" = "1" ]; then
    if [ -z "${DOMAIN:-}" ]; then
        die "AUTO_INSTALL=1 requires DOMAIN to be set in the env"
    fi
    log "AUTO_INSTALL=1 → running ct install"
    exec ./ct install
fi
