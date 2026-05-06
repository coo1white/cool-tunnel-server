#!/usr/bin/env bash
# install.sh — first-time bootstrap for Cool Tunnel Server.
#
# Run from the repo root after editing .env. Idempotent: safe to
# re-run if anything fails halfway. Designed to be friendly to
# operators who just SSH'd into a fresh Debian VPS:
#
#  - Numbered, colour-coded steps so you know exactly where you are.
#  - Pre-flight checks with apt-install hints if a tool is missing.
#  - Helpful "↳ try:" hints on every failure.
#  - The whole script is shellcheck-clean.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

# ---------- Pre-flight ---------------------------------------------

step "Pre-flight: required tools"
require_cmd openssl   "apt install -y openssl"
require_cmd sed       "apt install -y sed"
require_cmd dig       "apt install -y dnsutils      # for DNS sanity in late-night-comeback.sh"
require_cmd curl      "apt install -y curl"
require_cmd jq        "apt install -y jq            # used by manifest checks + sbom.sh"
require_docker
ok "all required tools present"

step "Pre-flight: .env"
if [[ ! -f .env ]]; then
    if prompt_yn "No .env file found. Copy .env.example to .env now?" y; then
        cp .env.example .env
        # Tighten before the file ever holds real secrets — `cp`
        # inherits the operator's umask (often 0022 on Debian, which
        # creates world-readable files). APP_KEY + DB credentials
        # leaking via 0644 .env is R2-1 in the audit.
        chmod 0600 .env
        ok "created .env from template (mode 0600)"
        warn "you must edit .env (DOMAIN, ACME_EMAIL, *_PASSWORD) before continuing"
        die "open .env, fill in real values, then re-run ./scripts/install.sh" \
            "\$EDITOR .env"
    else
        die ".env is required" "cp .env.example .env  &&  \$EDITOR .env"
    fi
fi
# Refuse to proceed if .env is world-readable. APP_KEY encrypts every
# proxy_accounts.password_cleartext_encrypted row and signs every
# subscription manifest; leaking it recovers all tenant cleartext.
# (R2-1, docs/audits/2026-05-04T06-31-58Z.md.)
env_mode=$(stat -c '%a' .env)
# Last octal digit is the "other" rwx bits; >= 4 means any reader on
# the host filesystem can pull APP_KEY out of .env. Extract the
# trailing character of the mode string rather than arithmetic on
# the whole value (e.g. mode 666 decimal % 8 = 2, not the octal 6
# we want).
other_bits=${env_mode: -1}
if (( other_bits >= 4 )); then
    die ".env is world-readable (mode $env_mode); APP_KEY + DB credentials would leak" \
        "chmod 0600 .env"
fi
load_env .env
ok ".env loaded"

# Sanity-check the values that absolutely must not be placeholders.
if [[ "${DOMAIN:-proxy.example.com}" == "proxy.example.com" ]]; then
    warn "DOMAIN is still set to the placeholder 'proxy.example.com'"
    warn "ACME will fail unless you point a real domain at this server"
    if ! prompt_yn "Continue anyway (e.g. for local docker-only testing)?" n; then
        die "aborted on placeholder DOMAIN" "edit .env"
    fi
fi
if [[ "${ACME_EMAIL:-admin@example.com}" == "admin@example.com" ]]; then
    warn "ACME_EMAIL is still the placeholder; Let's Encrypt sends renewal warnings to it"
fi
require_env DB_PASSWORD            "openssl rand -base64 32 # paste into .env DB_PASSWORD="
require_env REDIS_PASSWORD  "openssl rand -base64 32 # paste into .env REDIS_PASSWORD="

# Cross-validate CT_CLASH_SUBNET vs CT_CLASH_SINGBOX_IP. Both have
# defaults that match each other (172.30.0.0/24 + 172.30.0.10), so
# operators who don't touch them are fine. Operators who override
# the subnet to escape a docker-network collision (per
# .env.example's "Network — clash management plane" block) MUST
# update both lines together; otherwise `docker compose up` fails
# with the unhelpful "Invalid Address: it does not belong to any
# of this network's subnets". Catch it here with a clear hint
# instead. (v0.0.17 — DX from loop-3 audit.)
if [[ -n "${CT_CLASH_SUBNET:-}" && -n "${CT_CLASH_SINGBOX_IP:-}" ]]; then
    # 10.99.99.0/24  →  10.99.99   (strip ".0/24" via shortest-suffix
    #                                match of the pattern ".*/*")
    # 10.99.99.10    →  10.99.99   (strip ".10" via shortest-suffix
    #                                match of ".*")
    subnet_first_three="${CT_CLASH_SUBNET%.*/*}"
    ip_first_three="${CT_CLASH_SINGBOX_IP%.*}"
    if [[ "$subnet_first_three" != "$ip_first_three" ]]; then
        die "CT_CLASH_SINGBOX_IP=${CT_CLASH_SINGBOX_IP} is not inside CT_CLASH_SUBNET=${CT_CLASH_SUBNET}" \
            "edit .env so both lines share the first three octets, e.g. CT_CLASH_SUBNET=10.99.99.0/24 + CT_CLASH_SINGBOX_IP=10.99.99.10"
    fi
fi

# Per-install random seed for the clash API bearer token. Generated
# from /dev/urandom on first boot if the .env line is empty. Sing-
# box and ct-server-core both derive the bearer as sha256("ct-clash-
# secret-v1:" + this); rotation invalidates any captured bearer.
# (R2-2 in the 2026-05-04 audit — the prior derivation seeded from
# acme_email, which is publicly recoverable from the CT log for the
# operator's domain.)
if [[ -z "${CT_CLASH_SECRET_SEED:-}" ]]; then
    seed=$(openssl rand -hex 32)
    # Replace the placeholder line if present, otherwise append.
    if grep -qE '^CT_CLASH_SECRET_SEED=' .env; then
        sed -i "s|^CT_CLASH_SECRET_SEED=.*|CT_CLASH_SECRET_SEED=${seed}|" .env
    else
        printf '\nCT_CLASH_SECRET_SEED=%s\n' "${seed}" >> .env
    fi
    export CT_CLASH_SECRET_SEED="${seed}"
    unset seed
    ok "generated CT_CLASH_SECRET_SEED (clash-API bearer seed; .env updated)"
else
    ok "CT_CLASH_SECRET_SEED already set"
fi

# ---------- Pre-flight: prior-state checks -------------------------

# Two poka-yokes that catch the most common "fresh install fails"
# tickets, both rooted in operator state from a prior attempt:
#
#   1. STALE CLONE.  Operators who pulled the repo days ago hit
#      hotfixes that have already shipped (e.g. v0.0.25 opcache.ini,
#      v0.0.27 entrypoint seed). The fetch + ahead/behind check
#      surfaces this *before* a 2-minute build pipeline runs against
#      stale Dockerfiles.
#
#   2. STALE DOCKER VOLUME.  MariaDB only seeds users on the FIRST
#      volume init. If a prior `compose up` left `db_data` behind
#      and the operator regenerated DB_PASSWORD in .env between
#      attempts, the new password is in .env but the volume still
#      holds the old one — panel hits "1045 Access denied for user
#      'cooltunnel'" at migration time, with no obvious cause.
#
# Both are interactive prompts, not hard fails — operators in known-
# good states (CI, dev iteration, intentional offline runs) can
# decline without aborting.
step "Pre-flight: repo + Docker state freshness"

# --- 1. Local clone vs origin/main ---
if [[ -d .git ]] && command -v git >/dev/null 2>&1 \
        && git remote get-url origin >/dev/null 2>&1; then
    if git fetch --quiet origin main 2>/dev/null; then
        local_head=$(git rev-parse HEAD 2>/dev/null || true)
        remote_head=$(git rev-parse origin/main 2>/dev/null || true)
        merge_base=$(git merge-base HEAD origin/main 2>/dev/null || true)
        if [[ -n "$local_head" && -n "$remote_head" \
                && "$local_head" != "$remote_head" ]]; then
            if [[ "$merge_base" == "$local_head" ]]; then
                # Strictly behind — fast-forward possible.
                behind=$(git rev-list --count "HEAD..origin/main" \
                    2>/dev/null || echo "?")
                warn "your clone is ${behind} commit(s) behind origin/main"
                warn "stale clones often hit hotfixes that already shipped" \
                    "(opcache.ini, DB seeding, entrypoint races)"
                if prompt_yn "Pull origin/main now?" y; then
                    git pull --ff-only origin main \
                        || die "git pull failed" \
                            "resolve manually then re-run ./scripts/install.sh"
                    ok "fast-forwarded to $(git rev-parse --short HEAD)"
                    warn "the script you're running is the OLD in-memory copy;" \
                        "exit and re-run to pick up the new one"
                    if ! prompt_yn "Continue with the OLD in-memory script anyway?" n; then
                        die "aborted so you can re-run with the fresh script" \
                            "./scripts/install.sh"
                    fi
                else
                    warn "continuing with stale clone (you've been warned)"
                fi
            elif [[ "$merge_base" == "$remote_head" ]]; then
                # Local has commits ahead — operator is developing.
                ahead=$(git rev-list --count "origin/main..HEAD" \
                    2>/dev/null || echo "?")
                ok "clone has ${ahead} unpushed commit(s) ahead of origin/main (assuming intentional)"
            else
                # Diverged.
                warn "clone has diverged from origin/main (commits on each side)"
                if ! prompt_yn "Continue with this state?" n; then
                    die "aborted on diverged clone" \
                        "git rebase origin/main  (or: git reset --hard origin/main)"
                fi
            fi
        else
            ok "clone is up to date with origin/main"
        fi
    else
        warn "could not fetch origin/main (offline?); skipping freshness check"
    fi
else
    ok "not a git checkout — skipping clone-freshness check (tarball install?)"
fi

# --- 2. Leftover Docker state from a prior install ---
project_name="$(basename "$(pwd)")"
existing_containers=$(compose ps -a -q 2>/dev/null | grep -c . || true)
existing_volumes=$(docker volume ls --format '{{.Name}}' 2>/dev/null \
    | grep -cE "^${project_name}_" || true)
# `grep -c` returns 1 (no matches) under set -e even via `|| true`,
# but the assignment captured "0" in that case; coerce to be safe.
existing_containers=${existing_containers:-0}
existing_volumes=${existing_volumes:-0}
if (( existing_containers > 0 || existing_volumes > 0 )); then
    warn "Docker state from a prior install detected:"
    warn "  containers: ${existing_containers}    volumes: ${existing_volumes}"
    warn "stale volumes are the #1 cause of 'Access denied for user' on first boot —"
    warn "the DB image only seeds users on FIRST volume init; if .env DB_PASSWORD"
    warn "rotated since the last attempt, panel can't authenticate against the old volume."
    if prompt_yn "Wipe prior state ('compose down -v') before installing? DESTROYS any DB data" n; then
        compose down -v 2>/dev/null || true
        ok "prior containers + volumes removed"
    else
        warn "continuing with existing state — if migrations fail with '1045', this is the cause"
    fi
else
    ok "no leftover Docker state from prior install"
fi

# ---------- Build images -------------------------------------------

step "Build ct-server-core (Rust, musl-static)"
# CT_CORE_BUILD_PROFILE chooses the cargo release profile:
#
#   release        full LTO + codegen-units=1 — smallest, fastest
#                  binary, but peaks at ~1.5-2 GB compile-time RAM.
#                  Use this on a box with ≥2 GB RAM (or with a
#                  configured swapfile — see installation-debian.md
#                  "low-memory VPS prep").
#   release-small  no LTO, codegen-units=16, opt-level="s". Same
#                  musl-static linking; ~5-15 % runtime cost,
#                  ~1-2 min build instead of ~6-8 min, peaks at
#                  ~0.6-0.9 GB. The recommended default for a
#                  1 vCPU / 1 GB VPS.
#
# If the operator hasn't set the var, default to `release`. The
# .env.example ships it set explicitly so an operator who copies
# the template gets the visible knob.
core_profile="${CT_CORE_BUILD_PROFILE:-release}"
ok "core build profile: ${core_profile}"
compose --profile build-only build core-builder \
    --build-arg "CARGO_PROFILE=${core_profile}"
ok "ct-server-core built (profile=${core_profile})"

step "Build caddy image (stock Caddy 2 — ACME provider only, no plugins)"
compose build caddy
ok "caddy image built"

step "Build sing-box image (downloads upstream pre-built binary)"
compose build sing-box
ok "sing-box image built"

step "Build panel image (PHP-FPM + Composer + nginx + ct-server-core baked in)"
compose build panel
ok "panel image built"

# ---------- Bring up data layer ------------------------------------

step "Start db + redis"
compose up -d db redis
ok "db + redis containers started"

# shellcheck disable=SC2016  # vars must expand inside the bash -c, not now
wait_for "MariaDB healthcheck" 30 2 \
    bash -c '[[ "$(docker inspect -f "{{.State.Health.Status}}" ct-db 2>/dev/null)" == "healthy" ]]'

# ---------- Bring up panel + run migrations ------------------------

step "Start panel and run database migrations"
compose up -d panel

# The panel entrypoint.sh does the slow first-boot work:
#   1. composer install   (30-90s on a 1-vCPU VPS, fresh box)
#   2. php artisan key:generate
#   3. wait for db
#   4. php artisan migrate (--force, swallows errors with `|| true`)
#   5. {filament,config,route,view}:cache + caddyfile/singbox render
#   6. touch /tmp/cool-tunnel/entrypoint-complete (sentinel)
#   7. exec supervisord (PHP-FPM, nginx, ct-server-core daemon)
#
# Wait for the sentinel rather than `vendor/autoload.php`. The
# autoload file lands ~5s into composer install, but the entrypoint
# keeps doing concurrency-unsafe work (migrate, render) for another
# ~30-60s after that. If install.sh runs its own `migrate` against
# `vendor/autoload.php` it races the entrypoint's migrate and
# crashes with "Table 'cache' already exists" mid-transaction
# (v0.0.26 race-fix — first real-world Debian 13 deploy hit this).
warn "panel entrypoint is running 'composer install' on first boot;"
warn "this takes ~30-90s on a small VPS. Watch progress with:"
warn "    docker compose logs -f --tail=80 panel"
# shellcheck disable=SC2016  # vars must expand inside the bash -c, not now
wait_for "panel entrypoint setup complete (sentinel)" 90 5 \
    bash -c 'docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete'

# Verify the entrypoint's migrate actually applied cleanly. The
# entrypoint runs `migrate --force --no-interaction || true` to
# avoid wedging container start on a transient DB hiccup; we
# inspect `migrate:status` here so the install path observes a
# concrete success/failure signal. Pending entries mean either the
# entrypoint hit an error (swallowed by `|| true`) or someone
# added a migration after the sentinel touched.
status_out="$(compose exec -T panel php artisan migrate:status --no-interaction 2>&1 || true)"
if printf '%s\n' "$status_out" | grep -qiE '\<Pending\>'; then
    printf '%s\n' "$status_out" | tail -40
    die "panel has pending migrations — entrypoint migrate failed (|| true swallowed it)" \
        "docker compose logs --tail=80 panel"
fi
compose exec -T panel php artisan db:seed --force --no-interaction || true
ok "migrations applied + default seed in place"

# ---------- Render the initial Caddyfile + sing-box config --------

step "Render initial Caddyfile + sing-box config from DB"
# Render each config; track failures so the post-step `ok`
# doesn't lie when a render actually failed (papercut spotted in
# the v0.0.11 audit — operator saw "✗ FAILED" + "✓ rendered" on
# the same step, misleading the eye to believe the step
# succeeded).
caddy_render_ok=true
singbox_render_ok=true
compose exec -T panel ct-server-core --json caddyfile render \
    || { warn "Caddyfile render failed — Caddy will start with no domain configured"; caddy_render_ok=false; }
compose exec -T panel ct-server-core --json singbox render \
    || { warn "sing-box render failed — first proxy account creation will retry"; singbox_render_ok=false; }
[[ "$caddy_render_ok"   == true ]] && ok "Caddyfile rendered to /etc/caddy/Caddyfile (caddy_etc volume)"
[[ "$singbox_render_ok" == true ]] && ok "config.json rendered to /etc/sing-box/config.json (singbox_etc volume)"

# ---------- Start Caddy first; wait for the cert to land ----------

step "Start Caddy (ACME-only mode — port 80 only, manages cert for ${DOMAIN:-?})"
compose up -d caddy
ok "caddy running on :80"
warn "Caddy will fetch the TLS cert from Let's Encrypt now; this"
warn "usually takes 10-60 s. Tail logs with:"
warn "    docker compose logs -f --tail=80 caddy"

# Wait for cert files to appear in the shared caddy_data volume.
# Path is /data/caddy/certificates/<ca>/<domain>/<domain>.crt — see
# core/ct-server-core/src/singbox/mod.rs::cert_paths() for derivation.
ca_folder="acme-v02.api.letsencrypt.org-directory"
case "${ACME_DIRECTORY:-}" in
    *staging*) ca_folder="acme-staging-v02.api.letsencrypt.org-directory" ;;
esac
cert_path="/data/caddy/certificates/${ca_folder}/${DOMAIN:-proxy.example.com}/${DOMAIN:-proxy.example.com}.crt"

step "Wait for Caddy to obtain the TLS certificate (up to 90 s)"
# shellcheck disable=SC2016  # vars must expand inside the bash -c, not now
wait_for "Caddy cert at ${cert_path}" 45 2 \
    bash -c "docker compose exec -T caddy test -f \"$cert_path\""

# ---------- Start sing-box (now that the cert exists) -------------

step "Start sing-box (reads cert from caddy_data volume)"
compose up -d sing-box
ok "sing-box running on :443 (TCP only — NaiveProxy is HTTP/2-only)"

# ---------- Create first Filament admin ----------------------------

step "Create the first Filament admin user (interactive prompt follows)"
if [[ -t 0 ]]; then
    compose exec panel php artisan make:filament-user \
        || warn "could not create admin — re-run later with: docker compose exec panel php artisan make:filament-user"
else
    warn "non-interactive run - skipping admin creation"
    warn "create one later with: docker compose exec panel php artisan make:filament-user"
fi

# ---------- Final OK/NG check --------------------------------------

step "Component check (OK/NG status of every dependency)"
compose exec -T panel ct-server-core component check --manifests /srv/manifests \
    || warn "some components reported NG - investigate before serving real users"

# ---------- Done ---------------------------------------------------

cat <<EOF

${CT_BOLD}${CT_GREEN}Cool Tunnel Server is up.${CT_RESET}

  Panel         https://${DOMAIN}/admin
  Subscription  https://${DOMAIN}/api/v1/subscription/<token>
                  (issued from the panel)

What to do next:

  1. Watch ACME finish:
       ${CT_BOLD}docker compose logs -f --tail=80 sing-box${CT_RESET}

  2. Create your first proxy account:
       open https://${DOMAIN}/admin -> ProxyAccounts -> New
       (cleartext password is shown ONCE - copy it then)

  3. Point the macOS client at:
       ${CT_BOLD}naive+https://<username>:<password>@${DOMAIN}:443${CT_RESET}

  4. Run the readiness gate when you have a test account:
       ${CT_BOLD}LNC_TEST_PROXY_URL=... ./scripts/late-night-comeback.sh${CT_RESET}

Read docs/components.md for how to swap a part.
Read Disclaimer.md before letting anyone else use it.
EOF
