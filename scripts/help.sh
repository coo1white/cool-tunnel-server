#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# help.sh — operator-facing mini-manual.
#
# Companion to the maintain-UX rewrite (v0.0.96-v0.0.99). Each
# topic is a focused, plain-English explanation of what a script
# does, when to run it, what common failure modes look like, and
# what to do next. Designed for the operator who just SSH'd into
# a fresh VPS and wants the bigger picture without reading source.
#
# Usage:
#
#   ./scripts/help.sh               # list available topics
#   ./scripts/help.sh <topic>       # show topic
#
# Or via Makefile:
#
#   make help-update                # same as ./scripts/help.sh update
#
# Topics are intentionally short (one screen each). Operators who
# want deeper context should read the actual script + CHANGELOG.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

# Heredoc-into-`$(cat <<EOF...)` triggers a bash parser bug on
# parens inside the body; lib.sh and update.sh use the
# `read -r -d '' var <<'EOF' ... EOF || true` idiom instead.
# Same idiom here.

# ---------- Topic registry ----------------------------------------

TOPICS=(
    getting-started
    install
    update
    doctor
    auto-sync
    readiness
    backup
    restore
    troubleshooting
)

# ---------- Render helpers ----------------------------------------

h1() {
    printf '\n%s%s%s\n' "${CT_BOLD}${CT_GREEN}" "$1" "${CT_RESET}"
    printf '%s%s%s\n\n' "${CT_GREEN}" "$(printf '%*s' "${#1}" '' | tr ' ' '=')" "${CT_RESET}"
}

h2() {
    printf '\n%s%s%s\n' "${CT_BOLD}" "$1" "${CT_RESET}"
}

# ---------- Topics ------------------------------------------------

help_getting_started() {
    h1 "Getting started"
    local body
    read -r -d '' body <<'EOF' || true
You just SSH'd into a fresh Debian / Ubuntu VPS and want a
working Cool Tunnel deployment. The whole path is:

  1. Clone the repo                  (you are presumably here)
  2. Edit .env with your domain + secrets
  3. Run ./scripts/install.sh        (idempotent; ~5-10 min)
  4. Visit https://panel.<DOMAIN>/admin and log in

For the long-form tutorial (with prerequisites and detailed
verification at each step), see README.md sections "First
Deploy" and "Maintaining a Running Deployment".

Next topic:  ./scripts/help.sh install
EOF
    printf '%s\n' "$body"
}

help_install() {
    h1 "install.sh — first-time bootstrap"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  - Verifies required tools are on PATH (docker, dig, curl, jq)
  - Asks you to copy .env.example -> .env if missing, then
    checks the file is mode 0600 (refuses to proceed otherwise)
  - Cross-validates .env values: DOMAIN, ACME_EMAIL,
    DB_PASSWORD, REDIS_PASSWORD, PANEL_DOMAIN, CT_CLASH_SUBNET,
    CT_CLASH_SINGBOX_IP, port 80/443 are free, DNS A record
    matches host IP
  - Builds all images (ct-server-core + sing-box + panel +
    haproxy + caddy)
  - Brings the stack up; panel's entrypoint runs the first
    migration + initial Caddyfile/sing-box render
  - Waits for ACME (Let's Encrypt) to acquire the cert
  - Runs component check; reports OK or NG per service
  - Drops a one-time admin password to stdout; save it

When to run:
  - Fresh box, never deployed before
  - After a backup -> restore cycle (idempotent)
  - When something is so broken that 'update.sh' refuses to
    proceed and 'doctor' shows the stack as down

Common failure modes:
  - Port 80/443 in use   -> kill the offender or change the
                            Caddyfile bind addresses
  - DNS does not match   -> update A record to host IP, wait
                            for propagation
  - ACME timeout         -> usually means the outside world
                            cannot reach port 80 (firewall,
                            cloud provider). Check
                            'docker compose logs caddy'.
  - PECL/composer error  -> see CHANGELOG v0.0.95; the
                            ext-redis pin is now in place.

Idempotent: safe to re-run if anything fails halfway.

Diagnostics on failure:
  - Every step prints a numbered '==>' header
  - Errors come with a 'Diagnostic:' block listing next steps
  - 'make doctor' run anytime gives the dashboard view

Next topic:  ./scripts/help.sh update
EOF
    printf '%s\n' "$body"
}

help_update() {
    h1 "update.sh — pull a new release, rebuild, hot-swap"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  Pre-flight:
    - Network reachable (github.com + registry-1.docker.io)
    - Disk headroom (>= 2 GB repo, >= 4 GB docker root)
    - Stack is up (panel/sing-box/haproxy running OR restarting)
    - Working tree clean (interactive stash/discard/abort if
      uncommitted)

  Main flow:
    - git pull --ff-only
    - Auto-migrate legacy .env (PANEL_DOMAIN, APP_URL)
    - Rebuild ct-server-core (Rust)
    - Rebuild sing-box + panel + haproxy
    - 'compose up -d' to recreate containers with new images
    - Wait for panel entrypoint sentinel
    - Re-render sing-box config, reload daemon
    - Re-render haproxy config, SIGHUP
    - Component check (post-swap)

When to run:
  - After 'git pull' shows new commits on origin/main
  - After a release tag (v0.0.X) is published
  - Any time you want to deploy the latest main

What it does NOT do:
  - Touch the database (migrations are idempotent; existing
    data preserved)
  - Modify .env (auto-migration only adds missing keys)
  - Roll back on failure (failed updates leave the new images
    cached; old containers stay running until you re-run)

Common failure modes:
  - Uncommitted changes  -> the new preflight_clean_tree
                            offers stash / discard / abort
                            (v0.0.96 fix)
  - Network unreachable  -> diagnostic block lists ping /
                            dig / curl / proxy commands to try
  - Disk full            -> 'docker system prune -af' usually
                            reclaims 1-5 GB
  - Build failure        -> diagnostic block names the most
                            common causes per image (sing-box
                            vs panel vs haproxy)
  - Component check NG   -> diagnostic block names the NG
                            component + per-component
                            log-tail recipe

If something goes sideways and the panel container restart-
loops: 'docker compose logs panel' is the first place to look.
Most restart loops are composer install / migration failures
in the entrypoint.

Roll back if needed:
  git checkout v0.0.96  # (or the prior known-good tag)
  ./scripts/update.sh

Next topic:  ./scripts/help.sh doctor
EOF
    printf '%s\n' "$body"
}

help_doctor() {
    h1 "doctor.sh — health dashboard"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  Runs ~13 health checks against the live stack and prints a
  PASS / WARN / FAIL table grouped by area:

    Prerequisites          docker compose, .env mode
    Structural             DNS, ports 80/443, ACME cert expiry
    Application            /up endpoint, component check
    Compose stack          6 services up, 5 supervisord progs
    Resources              disk + RAM headroom
    Info                   release version, active users,
                           Messenger queue depth

When to run:
  - First thing when SSHing in to check a deployment
  - Any time you suspect something is off
  - Periodically (cron is fine; exit code is 0 on PASS/WARN,
    1 on any FAIL)

What it does NOT do:
  - Modify state of any kind. Read-only. Safe to run mid-
    deploy, during an outage, or on a healthy box.
  - Assert ship-readiness. Use 'make readiness' for that.

Difference from 'make readiness':
  doctor    -> 'show me everything I should look at'
                Permissive: WARN is informational, exit 0
  readiness -> 'is the system ready to publicly launch?'
                Strict: needs >=9/10 checks PASS, structural
                fails cap the score at 7, exit 1 if not ready

Output anatomy:
  - Table at top: rows like '  [PASS] Disk   repo 47G, ...'
  - Summary line: 'N PASS, M WARN, K FAIL, J INFO'
  - Remediation block: each WARN / FAIL gets a one-line hint
    with the most-likely next-step commands

Exit codes:
  0   - all-PASS or WARN-only (FAIL count is 0)
  1   - one or more FAIL rows

Next topic:  ./scripts/help.sh readiness
EOF
    printf '%s\n' "$body"
}

help_auto_sync() {
    h1 "auto_sync.sh — credential-lock audit + auto-correct agent"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  Runs the credential-lock guard (ct-server-core guard
  credential-lock). The guard asserts the four-way invariant:

    db == rendered == manifest == mac-config

  If any of them drift (DB row updated but sing-box config still
  has the old credentials; sing-box volume mounted to a stale
  path; etc.), the guard fails NG.

  On NG, auto-sync attempts corrective action:
    1. Re-render sing-box config from current DB state
       (ct-server-core --json singbox render).
    2. Restart the sing-box container so the new config takes
       effect.
    3. Re-run the guard to confirm drift is resolved.

  Logs every action loudly so an operator tailing the output
  sees exactly what happened.

When to run:
  - Manually (make auto-sync) any time something feels off
    -- e.g. you just rotated a proxy account's password in the
    Filament UI and want to confirm the change propagated all
    the way through sing-box, the manifest, and the Mac config
    surfaces before the next user hits the proxy.
  - Periodically via cron if you want a self-healing alarm
    surface beyond what the existing scheduler already does.

Companion to make doctor:
  doctor    -> 'show me everything I should look at' (read-only)
  auto-sync -> 'check the credential-lock invariant and fix any
                drift' (does write -- re-renders + restarts
                sing-box on drift)

What it does NOT do:
  - Touch the database. Strictly server-config-side correction.
  - Replace operator judgement on harder failure modes
    (decryption failures, mount path issues). On a re-verify
    that still reports drift, the script exits 1 with the
    most-likely causes listed.

Already covered without explicit auto-sync runs:
  - Laravel's scheduler runs 'singbox:render --if-changed
    --reload' every 5 minutes (see panel/routes/console.php).
    That handles the routine case of 'DB updated, sing-box
    not yet re-rendered' within 5 min, silently. auto-sync is
    the explicit-and-loud version of that, plus the
    credential-lock guard adds the manifest + mac-config
    surfaces to the check.

Exit codes:
  0   no drift detected, OR drift was detected + corrected
  1   drift detected, correction failed -- manual investigation

Next topic:  ./scripts/help.sh readiness
EOF
    printf '%s\n' "$body"
}

help_readiness() {
    h1 "late-night-comeback.sh — readiness gate"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  Runs exactly 10 checks against the live stack and applies a
  strict scoring rule:

    Structural (caps score at 7 if any FAIL):
      1. DNS resolves to host IP
      2. Ports 80/443 listening
      3. ACME cert from Let's Encrypt
      4. UFW active with 443/tcp allowed

    Operational:
      5. Kernel tuned (BBR, rmem_max >= 7.5 MB)
      6. Clock synchronised (NTP)
      7. Component check all OK
      8. Redis revocation bridge alive (publishes a test
         resync + waits for daemon ack)

    Functional:
      9. Cover-site invariant holds (anti-fingerprint)
     10. Bundled NaiveProxy anti-tracking probe
         (requires LNC_TEST_PROXY_URL env)

  Score >= 9 / 10 -> PASS, ready to publicly launch.
  Any structural fail caps the score at 7 regardless.

When to run:
  - Pre-launch gate (one-time)
  - Post-major-incident verification (have we recovered?)
  - In a cron once a day if you want continuous attestation
    of ship-readiness

What it does NOT do:
  - Day-to-day health monitoring. Use 'make doctor' for that.
  - Auto-recover anything. Read-only.

The Redis bridge check (step 8) DOES publish a test message
to cool_tunnel:revocations. This is intentional and harmless
(the Rust daemon logs an ack and moves on), but it is the one
non-read-only operation in the script.

Exit codes:
  0   - PASS (score >= 9)
  1   - FAIL (score < 9 OR any structural fail)

Next topic:  ./scripts/help.sh backup
EOF
    printf '%s\n' "$body"
}

help_backup() {
    h1 "backup.sh — full deployment snapshot"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  Creates a single tarball containing:
    - mariadb mysqldump (full schema + data)
    - caddy_data volume (ACME certs + private keys)
    - haproxy_admin volume
    - The current .env file
    - The current sing-box config template
    - The current Caddyfile template

  Output filename:  backups/cool-tunnel-<UTC-timestamp>.tar.gz

When to run:
  - Before any major upgrade
  - Periodically (cron daily is reasonable)
  - Before destructive operations (drop_database, force-
    rewrite history, swap hosting providers)

What it does NOT include:
  - Container images (those rebuild from source on restore)
  - The repo itself (re-clone from git on restore)
  - Operating system / docker daemon state

Use the canonical mode-0600 .env / db credentials, not -a /
--password on argv (the script uses MYSQL_PWD env). See the
secrets-argv make target for the policy check.

Idempotent: safe to run while the stack is live (uses
mysqldump --single-transaction; brief I/O spike but no
service interruption).

To list existing backups:
  ls -lh backups/

Next topic:  ./scripts/help.sh restore
EOF
    printf '%s\n' "$body"
}

help_restore() {
    h1 "restore.sh — recover from a backup tarball"
    local body
    read -r -d '' body <<'EOF' || true
What it does:
  Reverses backup.sh. Given backups/cool-tunnel-<ts>.tar.gz:
    - Stops the panel + sing-box + haproxy containers
    - Imports the mysqldump into mariadb (replacing current
      schema; existing data is lost)
    - Restores the caddy_data volume (ACME certs)
    - Restores haproxy_admin volume
    - Restores .env, sing-box config template, Caddyfile
      template
    - Restarts the stack
    - Component check

When to run:
  - Migrating to a new VPS (clone the repo, copy the backup
    tarball, run restore.sh)
  - Recovering from a catastrophic incident (DB corruption,
    accidental rm -rf, etc.)
  - Testing backup integrity in a staging environment

What it does NOT do:
  - Selective restore (single table, single config file).
    Use mysqldump + cp manually for partial restores.
  - Rollback the running release. If the backup was taken
    on v0.0.X and you currently run v0.0.Y, the restore
    brings DB schema + config to v0.0.X; the panel image
    stays at v0.0.Y unless you also 'git checkout v0.0.X'
    and 'docker compose build'.

DESTRUCTIVE: the import step drops + recreates the cool_tunnel
database. There is no 'are you sure?' prompt -- run with care.

Common failure modes:
  - 'database already exists' on re-run -> known issue;
    restore.sh drops the DB first now, but very old tarballs
    may carry a CREATE DATABASE statement that conflicts.
  - panel does not start post-restore -> usually means the
    .env in the tarball mismatches the current docker-
    compose setup (e.g. old REDIS_PASSWORD).
    Fix: edit .env to match current setup, then
    'docker compose up -d --force-recreate panel'.

Next topic:  ./scripts/help.sh troubleshooting
EOF
    printf '%s\n' "$body"
}

help_troubleshooting() {
    h1 "Troubleshooting — common issues + diagnostic recipes"
    local body
    read -r -d '' body <<'EOF' || true
Top issues, ranked by how often they bite operators:

1. Panel container restart-loops
   - 'docker compose logs --tail=120 panel | head -60'
   - Look for: "composer install" errors, migration errors,
     APP_KEY missing, Octane worker crash.
   - Recent class of bug (v0.0.94 era): ext-redis version
     mismatch with symfony/redis-messenger. Fixed in v0.0.95+.

2. Caddy fails to acquire ACME cert
   - 'docker compose logs --tail=80 caddy | grep -iE "acme|cert"'
   - Most common: port 80 not reachable from outside (firewall,
     cloud provider security group blocks).
   - Test: from a DIFFERENT machine, curl http://<DOMAIN>/.well-
     known/acme-challenge/test.

3. DNS A record does not match host IP
   - Visible in 'make doctor' as a FAIL on the DNS check.
   - 'dig +short A <DOMAIN>' to see what the world resolves
     vs 'curl -s4 https://ifconfig.co' for the host's public IP.
   - Update DNS, wait ~5-10 min for propagation, re-run doctor.

4. Update.sh refuses to start ("stack is entirely down")
   - You probably want install.sh, not update.sh.
   - But: 'docker compose ps' first to confirm.

5. /up endpoint returns non-200 or connection-refused
   - 'docker compose ps panel' -- is it running?
   - 'docker compose logs --tail=80 panel' -- did Octane crash?

6. Component check shows NG
   - The update.sh diagnostic block names the NG component
     and lists per-component log-tail recipes.
   - For doctor: rerun and read the Remediation block.

7. 'git pull' blocked by uncommitted changes
   - The preflight_clean_tree helper offers s / d / a
     (stash with label / discard / abort).
   - Stash with label is recoverable: 'git stash pop'.

8. Messenger queue depth growing (cool_tunnel:messenger)
   - 'doctor' shows this in the Info section.
   - Means the messenger:consume worker is stuck or
     overloaded. Restart with:
       docker compose restart panel
     The supervisord messenger program will re-spawn the
     worker on container restart.

When asking for help, paste:
  - The last 40 lines of the script's output
  - 'docker compose ps' output
  - The relevant container's last 40 log lines

That's enough for almost any diagnosis.

Topics:  ./scripts/help.sh   (list all)
EOF
    printf '%s\n' "$body"
}

# ---------- Dispatcher --------------------------------------------

list_topics() {
    printf '%sCool Tunnel Server — operator help%s\n\n' \
        "${CT_BOLD}${CT_GREEN}" "${CT_RESET}"
    printf 'Usage:\n'
    printf '  ./scripts/help.sh <topic>\n'
    printf '  make help-<topic>\n\n'
    printf 'Topics:\n'
    for t in "${TOPICS[@]}"; do
        printf '  %s\n' "$t"
    done
    printf '\nStart with:\n'
    printf '  ./scripts/help.sh getting-started\n\n'
}

main() {
    if [[ $# -eq 0 ]]; then
        list_topics
        return 0
    fi
    local topic="$1"
    case "$topic" in
        getting-started)  help_getting_started ;;
        install)          help_install ;;
        update)           help_update ;;
        doctor)           help_doctor ;;
        auto-sync)        help_auto_sync ;;
        readiness)        help_readiness ;;
        backup)           help_backup ;;
        restore)          help_restore ;;
        troubleshooting)  help_troubleshooting ;;
        list|topics|-h|--help|help)
            list_topics
            ;;
        *)
            printf '%s✗%s unknown topic: %s\n\n' \
                "${CT_RED}" "${CT_RESET}" "$topic" >&2
            list_topics >&2
            return 1
            ;;
    esac
}

main "$@"
