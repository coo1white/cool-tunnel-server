#!/usr/bin/env bash
# scripts/bootstrap.sh — one-line bootstrap for Cool Tunnel Server.
#
# Designed to be the curl|bash target referenced in README.md. Walks
# a fresh Debian 11/12/13 VPS from "just SSH'd in" → "ready to edit
# .env and run install.sh" in a single network round-trip.
#
# Idempotent: re-running is a no-op if Docker is already installed,
# the repo is already cloned, or .env already exists.
#
# Usage on a fresh VPS as root:
#   curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash
#
# Unattended mode (CI / Terraform / Ansible):
#   DOMAIN=proxy.example.com \
#   ACME_EMAIL=ops@example.com \
#   AUTO_INSTALL=1 \
#   curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash
#
# Override knobs (any can be set in the env before running):
#   INSTALL_DIR (default /opt/cool-tunnel-server)
#   REPO_URL    (default https://github.com/coo1white/cool-tunnel-server.git)
#   BRANCH      (default main)
#   DOMAIN, ACME_EMAIL — pre-fill .env
#   AUTO_INSTALL=1  — chain ./scripts/install.sh after bootstrap
#                     (only valid when DOMAIN is also set)

set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cool-tunnel-server}"
REPO_URL="${REPO_URL:-https://github.com/coo1white/cool-tunnel-server.git}"
BRANCH="${BRANCH:-main}"

c_blue=$'\033[1;34m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
warn() { printf '%s!! %s%s\n' "$c_yellow" "$*" "$c_off" >&2; }
die()  { printf '%s!!! %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# ---------- 1. preflight ---------------------------------------------------

[ "${EUID:-$(id -u)}" -eq 0 ] || die "must run as root (re-run via: sudo bash)"
[ -f /etc/debian_version ] || warn "tested on Debian 11/12/13; YMMV on $(uname -a)"

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

# ---------- 4. .env scaffold (auto-generate strong secrets) ----------------

if [ ! -f .env ]; then
    cp .env.example .env
    log "scaffolded $INSTALL_DIR/.env"

    # generate random passwords for any unset/changeme placeholder
    gen_pass() { openssl rand -base64 30 | tr -d '/=+' | cut -c1-32; }
    for key in DB_PASSWORD DB_ROOT_PASSWORD REDIS_PASSWORD PANEL_ADMIN_PASSWORD; do
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
       ACME_EMAIL=      # for Let's Encrypt cert issuance

     Random secrets for DB/Redis/admin were generated; review and
     keep a copy of PANEL_ADMIN_PASSWORD before you log in.

  3. Run the 8-step bootstrap (numbered output, "↳ try:" hints
     on every failure):
       cd ${INSTALL_DIR}
       ./scripts/install.sh

  4. Open the panel: https://panel.\${DOMAIN}/admin
=================================================================
EOF

# ---------- 6. optionally chain install.sh ---------------------------------

if [ "${AUTO_INSTALL:-0}" = "1" ]; then
    if [ -z "${DOMAIN:-}" ]; then
        die "AUTO_INSTALL=1 requires DOMAIN to be set in the env"
    fi
    log "AUTO_INSTALL=1 → running ./scripts/install.sh"
    exec bash ./scripts/install.sh
fi
