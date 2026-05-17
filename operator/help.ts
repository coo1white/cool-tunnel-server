// SPDX-License-Identifier: AGPL-3.0-only
// operator/help.ts — operator-facing mini-manual (pure-TS port of
// scripts/help.sh).
//
// Topic registry: `Record<slug, { title, body }>`. The CLI here
// drives both the standalone `bun run help.ts` path and the
// `ct-operator help` task (via operator/src/tasks/help.ts).
//
// Topics are intentionally short (one screen each). For deeper
// context the operator reads the script + CHANGELOG.

const isTty = process.stdout.isTTY === true;
const ANSI = {
    bold: isTty ? "\x1b[1m" : "",
    green: isTty ? "\x1b[32m" : "",
    red: isTty ? "\x1b[31m" : "",
    reset: isTty ? "\x1b[0m" : "",
} as const;

interface Topic {
    readonly title: string;
    readonly body: string;
}

export const TOPICS: Record<string, Topic> = {
    "getting-started": {
        title: "Getting started",
        body: `You just SSH'd into a fresh Debian / Ubuntu VPS and want a
working Cool Tunnel deployment. The whole path is:

  1. Clone the repo                  (you are presumably here)
  2. Edit .env with your domain + secrets
  3. Run ./scripts/install.sh        (idempotent; ~5-10 min)
  4. Visit https://panel.<DOMAIN>/admin and log in

For the long-form tutorial (with prerequisites and detailed
verification at each step), see README.md sections "First
Deploy" and "Maintaining a Running Deployment".

Next topic:  ./scripts/help.sh install
`,
    },
    "install": {
        title: "install.sh — first-time bootstrap",
        body: `What it does:
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
`,
    },
    "update": {
        title: "update.sh — pull a new release, rebuild, hot-swap",
        body: `What it does:
  Pre-flight:
    - Network reachable (github.com + registry-1.docker.io)
    - Disk headroom (>= 2 GB repo, >= 4 GB docker root)
    - Stack is up (panel + caddy running OR restarting; singbox
      allowed transiently down, depends on panel-rendered config)
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
`,
    },
    "doctor": {
        title: "doctor.sh — health dashboard",
        body: `What it does:
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
                Strict: needs >=8/9 checks PASS, structural
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
`,
    },
    "auto-sync": {
        title: "auto_sync.sh — credential-lock audit + auto-correct agent",
        body: `What it does:
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

Next topic:  ./scripts/help.sh fix
`,
    },
    "fix": {
        title: "fix.sh — the 'I'm stuck' command",
        body: `What it does:
  Walks through every install / runtime issue we've seen on real
  deployments, in order, and offers to fix each one interactively.
  Each issue is explained in plain English -- you do NOT need to
  understand Docker, sing-box, HAProxy, or IPv6 to use it.

  For each detected issue you can:
    [a]pply    -- run the fix (shows what it will do first)
    [s]kip     -- no action; default if you just press Enter
    [e]xplain  -- show the recipe details
    [q]uit     -- stop the agent

When to run:
  - 'install.sh' got partway through and failed
  - 'update.sh' got partway through and failed
  - Cool Tunnel (Mac client) connects briefly then drops
  - Browsers behind the proxy can't load websites
  - 'make doctor' shows FAIL rows you don't understand
  - You just SSH'd into a deployment you didn't set up and
    something feels off

What it does NOT do:
  - Auto-apply anything destructive. Every fix asks first.
  - Touch the database directly (credential issues go through
    the existing render path).
  - Surface secrets to the terminal.

Recipes ship in install-order priority (issues that block earlier
boot stages come first):

   1. docker_daemon_down         the Docker daemon itself is down
                                 (must run BEFORE any compose-based
                                  recipe -- none of them work without
                                  a live daemon)
   2. compose_service_down       NEW v0.1.3: a service in compose.yml
                                 is supposed to be running but isn't
                                 (e.g. haproxy exited after SIGHUP
                                  re-exec, host :443 unbound, browsers
                                  see ERR_CONNECTION_REFUSED). Fix:
                                  compose up -d.
   3. zombie_docker_proxy        port :80/:443 held by an orphan
                                 docker-proxy from a failed earlier
                                 \`compose up\` attempt
   4. foreign_container_ports    non-cool-tunnel container on :80/:443
   5. broken_container_dns       containers can't resolve hostnames
   6. ipv6_dns_unreachable       Caddy ACME hits IPv6 dead-end
                                 (common on Vultr -- they advertise
                                  IPv6 but don't actually route it)
   7. haproxy_backend_dns        HAProxy can't see caddy / sing-box
   8. missing_tls_cert           sing-box waiting on Let's Encrypt
   9. singbox_domain_resolver    sing-box 1.13+ DoH config regression
  10. singbox_outbound_ipv4_only host can't reach the open internet
                                 over IPv6 -> proxy traffic drops
                                 (this and #6 are the two halves of
                                  the v6-on-Vultr trap)
  11. panel_restart_loop         panel container "Restarting" instead
                                 of "Up" -- the v0.0.94-class
                                 composer / Octane / image-stale set
  12. pending_migrations         DB schema older than running code
                                 (restored an old backup; panel boot
                                  migration failed mid-way)
  13. messenger_queue_stuck      Symfony Messenger Redis stream depth
                                 >100 (worker died, supervisord didn't
                                  catch SIGCHLD)
  14. credential_drift           panel / sing-box / Mac out of sync
                                 (delegates to auto_sync.sh)
  15. no_proxy_account           no enabled accounts in the DB
                                 (skip-fix: prints how-to, doesn't
                                  echo a password)
  16. legacy_env_shape           .env file from pre-v0.0.68
  17. stale_deployment           NEW v0.1.3: deployed version is
                                 older than the latest release tag
                                 on origin/main. Fix: pulls + runs
                                 ct update. Interactive companion
                                 to \`ct auto-update\` (the unattended
                                  cron-fired version).

When asking for help, paste the SUMMARY at the end of fix.sh's
output (number detected / fixed / skipped / failed). That + the
recipe slug of any FAILED entry is enough to triage almost
anything.

Exit codes:
  0   no issues, OR all detected issues were fixed/skipped cleanly
  1   one or more fix attempts failed -- recipe slug surfaced
      in the summary block

Next topic:  ./scripts/help.sh auto-update
`,
    },
    "auto-update": {
        title: "auto_update.sh — unattended release-pulling agent",
        body: `What it does:
  Checks origin/main for a newer release tag. If the deployed
  version is older AND the running stack is currently healthy,
  pulls main and runs the standard \`./scripts/update.sh\` flow.

  The agent is DEFAULT-OFF. A fresh install never auto-upgrades.
  You opt in via:

    sudo ct auto-update enable

  That drops a /etc/cron.daily/ct-auto-update symlink which runs
  the agent in --quiet mode once a day (anacron-windowed at the
  Debian default time, usually 06:25-07:00 UTC).

  Disable any time:

    sudo ct auto-update disable

  Manual one-shot run (interactive, prints everything):

    ct auto-update now
    # or: ct auto-update      (defaults to \`now\`)
    # or: make auto-update

  Status:

    ct auto-update status

When to enable:
  - You operate a small fleet and don't want to SSH into each box
    every time we cut a patch release.
  - Your deployment doesn't have a custom dev workflow that needs
    manual coordination on every upgrade.
  - You're comfortable with the agent waking up overnight and
    re-rendering configs as part of its catch-up cycle.

When NOT to enable:
  - You pin to a specific release on purpose (don't want surprises).
  - You have heavy customizations in /opt/cool-tunnel-server (the
    agent uses --ff-only and refuses to upgrade if your working
    tree has uncommitted changes -- but even so, opting in is
    riskier on a customized box).
  - You're in the middle of a multi-step deploy and don't want a
    cron tick interrupting it.

Safety properties:
  - flock'd: two concurrent runs can't race.
  - Network-aware: aborts cleanly if origin is unreachable; will
    retry on the next cron tick.
  - Health-gated: refuses to upgrade an already-broken stack
    (\`credential-lock\` guard pre-flight + \`panel\` running check).
    Logic: an unattended agent should NEVER compound an existing
    incident; rolling a new release on top of a broken
    deployment usually makes diagnosis harder.
  - Idempotent: re-running mid-upgrade picks up where it left off.
  - Read-only when nothing to do: \`up to date\` early-exits with
    no docker calls, no git changes.

What it does NOT do:
  - Roll back on failure. If the new release breaks the stack,
    the agent exits non-zero with a clear "left at partial state"
    message. Recovery is via \`ct fix\` (which detects most
    upgrade-induced gotchas as recipes).
  - Skip prereleases. Currently any tag on origin/main triggers
    an upgrade. (We don't ship rcs; if we ever do, we'll add an
    \`--stable-only\` flag and make it the default.)
  - Notify externally. Logs to stdout/stderr; cron mails the root
    user the daily output if your local cron is configured to.

Exit codes:
  0    up to date, OR upgraded successfully
  1    upgrade attempted and failed (operator should investigate)
  2    refused (stack unhealthy / no network / not a git checkout)

Companion recipe in \`ct fix\`: \`stale_deployment\` — interactive
catch-up that runs the same logic with an [a]pply/[s]kip prompt.

Next topic:  ./scripts/help.sh readiness
`,
    },
    "readiness": {
        title: "late-night-comeback.sh — readiness gate",
        body: `What it does:
  Runs exactly 9 checks against the live stack and applies a
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

  Score >= 8 / 9 -> PASS, ready to publicly launch.
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
  0   - PASS (score >= 8)
  1   - FAIL (score < 8 OR any structural fail)

Next topic:  ./scripts/help.sh backup
`,
    },
    "backup": {
        title: "backup.sh — full deployment snapshot",
        body: `What it does:
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
`,
    },
    "restore": {
        title: "restore.sh — recover from a backup tarball",
        body: `What it does:
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
`,
    },
    "troubleshooting": {
        title: "Troubleshooting — common issues + diagnostic recipes",
        body: `Top issues, ranked by how often they bite operators:

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
`,
    },
    "drift": {
        title: "drift — three-way cleartext drift check",
        body: `What it does:
  Audits whether the cleartext password an account has is byte-
  equal across three layers:

      DB              ProxyAccount::password_cleartext_encrypted,
                      decrypted via Laravel Crypt.
      sing-box        users[].uuid in /data/config/singbox.json,
                      what sing-box VLESS-in actually authenticates
                      incoming connections against.
      subscription    The credential field clients import from
                      https://<panel>/api/v1/subscription/<token>.

  Drift between any pair means clients fail authentication when
  they try to connect — the exact symptom that looks like 'tunnel
  doesn't work' with no actionable error in the macOS client.

When to run:
  - After any credential rotation (operator-driven or auto-sync)
  - After a restore (the DB cleartext might not match the rendered
    sing-box config)
  - When a client reports auth-fail despite a fresh subscription
    import (today's incident class)
  - On a schedule (cron-friendly; exit 0 = clean, 1 = drift)

What it does NOT do:
  - Decrypt or print cleartext to the terminal. The table column
    is 'same' / 'DIFF' / 'absent' only.

Output:
  - Human: table with one row per (account_id, username) tuple.
  - JSON:  pass --json (or ct --json drift) for a machine-readable
           DriftReport. Cleartext is OMITTED from the JSON view
           — only equality/inequality.

Repair recipes (per finding):
  db↔singbox drift          ./ct render singbox
  db↔subscription drift     re-fetch from panel (clients) OR
                            check APP_KEY rotation
  sing-box absent           ./ct render singbox
  phantom singbox user      Filament UI -> delete or
                            ./ct render singbox
`,
    },
};

export const TOPIC_SLUGS: readonly string[] = Object.keys(TOPICS);

function h1(title: string): string {
    const underline = "=".repeat(title.length);
    return `\n${ANSI.bold}${ANSI.green}${title}${ANSI.reset}\n${ANSI.green}${underline}${ANSI.reset}\n`;
}

export function renderTopic(slug: string): { ok: true; output: string } | { ok: false; error: string } {
    const t = TOPICS[slug];
    if (!t) {
        return { ok: false, error: `unknown topic: ${slug}` };
    }
    return { ok: true, output: h1(t.title) + "\n" + t.body };
}

export function renderTopicList(): string {
    const lines: string[] = [];
    lines.push(`${ANSI.bold}${ANSI.green}Cool Tunnel Server — operator help${ANSI.reset}`);
    lines.push("");
    lines.push("Usage:");
    lines.push("  ct help <topic>");
    lines.push("  make help-<topic>");
    lines.push("");
    lines.push("Topics:");
    for (const slug of TOPIC_SLUGS) {
        lines.push(`  ${slug}`);
    }
    lines.push("");
    lines.push("Start with:");
    lines.push("  ct help getting-started");
    lines.push("");
    return lines.join("\n");
}

async function main(): Promise<number> {
    const argv = process.argv;
    // Skip Bun's argv[0] (interpreter) + argv[1] (script). Filter
    // operator-global flags so `ct-operator help <topic> --json`
    // doesn't trip the unknown-topic branch.
    const cmdIdx = argv.indexOf("help");
    const rest = (cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2)).filter(
        (a) => a !== "--json" && a !== "--no-bridge",
    );

    if (rest.length === 0 || rest[0] === "list" || rest[0] === "topics" || rest[0] === "-h" || rest[0] === "--help") {
        process.stdout.write(renderTopicList());
        return 0;
    }
    const slug = rest[0]!;
    const r = renderTopic(slug);
    if (!r.ok) {
        process.stderr.write(`${ANSI.red}✗${ANSI.reset} ${r.error}\n\n`);
        process.stderr.write(renderTopicList());
        return 1;
    }
    process.stdout.write(r.output);
    return 0;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
