// SPDX-License-Identifier: AGPL-3.0-only
// operator/help.ts — operator-facing mini-manual.
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

  1. Run the Homebrew-style bootstrap command from README.md
  2. Edit .env with your domain + secrets
  3. Run ct install                 (idempotent; ~5-10 min)
  4. Visit https://panel.<DOMAIN>/admin and log in

For the long-form tutorial (with prerequisites and detailed
verification at each step), see README.md sections "First
Deploy" and "Maintaining a Running Deployment".

Next topic:  ./ct help install
`,
    },
    "install": {
        title: "ct install — first-time bootstrap",
        body: `What it does:
  - Verifies required tools are on PATH (docker, dig, curl, jq)
  - Asks you to copy .env.example -> .env if missing, then
    checks the file is mode 0600 (refuses to proceed otherwise)
  - Cross-validates .env values: DOMAIN, ACME_EMAIL,
    DB_PASSWORD, DB_ROOT_PASSWORD, REDIS_PASSWORD, PANEL_DOMAIN,
    port 80/443 are free, DNS A record matches host IP
  - Loads the verified release Docker image bundle
  - Brings the stack up; panel's entrypoint runs the first
    migration + initial Caddyfile/sing-box render
  - Waits for ACME (Let's Encrypt) to acquire the cert
  - Runs health gates and reports PASS / WARN / FAIL
  - Prints the next command for first-owner setup:
    ct admin bootstrap

When to run:
  - Fresh box, never deployed before
  - After a backup -> restore cycle (idempotent)
  - When something is so broken that 'ct update' refuses to
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
  - Image bundle missing -> release asset is incomplete for this
                            CPU architecture; run
                            ./scripts/fetch_image_bundle.sh

Idempotent: safe to re-run if anything fails halfway.

Diagnostics on failure:
  - Every step prints a numbered '==>' header
  - Errors come with a 'Diagnostic:' block listing next steps
  - 'ct doctor' run anytime gives the dashboard view

Next topic:  ./ct help update
`,
    },
    "update": {
        title: "update — pull a new release and hot-swap",
        body: `What it does:
  Pre-flight:
    - Network reachable (GitHub release downloads)
    - Disk headroom (>= 2 GB repo, >= 4 GB docker root);
      safe temp cleanup runs automatically only when space is low
    - Stack is up (panel + caddy running OR restarting; singbox
      allowed transiently down, depends on panel-rendered config)
    - Working tree clean (interactive stash/discard/abort if
      uncommitted)

  Main flow:
    - git pull --ff-only
    - Auto-migrate legacy .env (PANEL_DOMAIN, APP_URL)
    - Load the verified Docker image bundle for this release
    - Bring the new panel image up, then caddy + singbox
    - Wait for panel entrypoint sentinel
    - Re-render Caddyfile and reload Caddy
    - Let ct-singbox pick up the panel-rendered singbox.json
    - Health gates (post-swap)

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
  - Uncommitted changes  -> 'ct update' preflight offers
                            stash / discard / abort
  - Network unreachable  -> diagnostic block lists ping /
                            dig / curl / proxy commands to try
  - Disk full            -> auto-clean already removed safe temp
                            and build cache; diagnostic lists
                            the next manual commands
  - Image bundle missing -> release asset is incomplete for this
                            CPU architecture; run
                            ./scripts/fetch_image_bundle.sh
  - Health gate failed   -> diagnostic block gives the
                            remediation command to run next

If something goes sideways and the panel container restart-
loops: 'docker compose logs panel' is the first place to look.
Most restart loops are missing BETTER_AUTH_SECRET, invalid .env
values, or a failed initial render before the Bun admin starts.

Roll back if needed:
  git checkout v0.0.96  # (or the prior known-good tag)
      ./ct update

Next topic:  ./ct help doctor
`,
    },
    "doctor": {
        title: "doctor — health dashboard",
        body: `What it does:
  Runs ~13 health checks against the live stack and prints a
  PASS / WARN / FAIL table grouped by area:

    Prerequisites          docker compose, .env mode,
                           Reality clock window
    Structural             DNS, ports 80/443, ACME cert expiry
    Application            /up endpoint, direct-dial config
    Compose stack          5 services up, supervisord programs
    Resources              disk + RAM headroom
    Info                   release version, admin users,
                           retained Redis queue depth

When to run:
  - First thing when SSHing in to check a deployment
  - Any time you suspect something is off
  - Periodically (cron is fine; exit code is 0 on PASS/WARN,
    1 on any FAIL)

What it does NOT do:
  - Modify state of any kind. Read-only. Safe to run mid-
    deploy, during an outage, or on a healthy box.
  - Repair issues automatically. It prints the likely next command
    for each WARN / FAIL row instead.

Output anatomy:
  - Table at top: rows like '  [PASS] Disk   repo 47G, ...'
  - Summary line: 'N PASS, M WARN, K FAIL, J INFO'
  - Remediation block: each WARN / FAIL gets a one-line hint
    with the most-likely next-step commands

Exit codes:
  0   - all-PASS or WARN-only (FAIL count is 0)
  1   - one or more FAIL rows

Next topic:  ./ct help auto-update
`,
    },
    "recover": {
        title: "recover — diagnose failed install/update gates",
        body: `What it does:
  Repairs the common post-install/update failures after containers are
  mostly running.

  Default mode:
    ct recover
    ct recover diagnose

  This gathers:
    - docker compose ps
    - singbox render result
    - credential-lock result
    - admin/user count
    - rendered VLESS user names
    - recent panel/singbox error lines

  Safe repair mode:
    ct recover fix-stale-singbox
    ct recover --fix-stale-singbox

  This stops singbox, deletes the rendered /data/config/singbox.json,
  asks the panel to render a fresh config from admin state, reruns
  credential-lock, and brings singbox back up. It does not touch the
  database, .env, Caddy, or ACME certs.

When to run:
  - Update fails with 'credential-lock drift'
  - Install/update says singbox is running/starting for too long
  - panel render actions fail
  - Panel returns a 500 while managing admin users
  - You need a compact evidence bundle before asking for help

Common result:
  DB active VLESS accounts: 0
  Rendered VLESS users: 1

  That means the rendered singbox.json is stale. Run:
    ct recover fix-stale-singbox

After recovery:
  ./ct update
  ./ct doctor

Next topic:  ./ct help backup
`,
    },
    "auto-update": {
        title: "auto-update — unattended release-pulling agent",
        body: `What it does:
  Checks origin/main for a newer release tag. If the deployed
  version is older AND the running stack is currently healthy,
  pulls main and runs the standard \`./ct update\` flow.

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
    message. Recovery starts with \`ct doctor\`, then the remediation
    hints printed for any FAIL rows.
  - Skip prereleases. Currently any tag on origin/main triggers
    an upgrade. (We don't ship rcs; if we ever do, we'll add an
    \`--stable-only\` flag and make it the default.)
  - Notify externally. Logs to stdout/stderr; cron mails the root
    user the daily output if your local cron is configured to.

Exit codes:
  0    up to date, OR upgraded successfully
  1    upgrade attempted and failed (operator should investigate)
  2    refused (stack unhealthy / no network / not a git checkout)

Next topic:  ./ct help recover
`,
    },
    "backup": {
        title: "backup — full deployment snapshot",
        body: `What it does:
  Creates a single tarball containing:
    - mariadb mysqldump (full schema + data)
    - caddy_data volume (ACME certs + private keys)
    - admin_data volume (Better Auth/admin SQLite state)
    - The current .env file
    - The manifest set
    - The current Caddyfile template

  Output filename:  backups/cool-tunnel-<UTC-timestamp>.tar.gz

When to run:
  - Before any major upgrade
  - Periodically (cron daily is reasonable)
  - Before destructive operations (drop_database, force-
    rewrite history, swap hosting providers)

What it does NOT include:
  - Container images (reload the matching release image bundle first)
  - The repo itself (re-clone from git on restore)
  - Operating system / docker daemon state

Use the canonical mode-0600 .env / db credentials, not -a /
--password on argv (the script uses MYSQL_PWD env). See the
secrets-argv make target for the policy check.

Idempotent: safe to run while the stack is live (uses
mysqldump --single-transaction and briefly stops the Caddy/panel
writers while their volumes are archived).

To list existing backups:
  ls -lh backups/

Next topic:  ./ct help restore
`,
    },
    "restore": {
        title: "restore — recover from a backup tarball",
        body: `What it does:
  Reverses 'ct backup'. Given backups/cool-tunnel-<ts>.tar.gz:
    - Refuses to run over an already-running stack
    - Imports the mysqldump into mariadb (replacing current
      schema; existing data is lost)
    - Restores the caddy_data volume (ACME certs)
    - Restores the admin_data volume (Better Auth/admin SQLite)
    - Restores .env, manifests, and Caddyfile template
    - Restarts the stack
    - Health check

When to run:
  - Migrating to a new VPS (clone the repo, copy the backup
    tarball, run 'ct restore <tarball>')
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
    and the matching release image bundle.

DESTRUCTIVE: the import step drops + recreates the cool_tunnel
database. There is no 'are you sure?' prompt -- run with care.

Common failure modes:
  - 'database already exists' on re-run -> known issue;
    'ct restore' drops the DB first now, but very old tarballs
    may carry a CREATE DATABASE statement that conflicts.
  - panel does not start post-restore -> usually means the
    .env in the tarball mismatches the current docker-
    compose setup (e.g. old REDIS_PASSWORD).
    Fix: edit .env to match current setup, then
    'docker compose up -d --force-recreate panel'.

Next topic:  ./ct help troubleshooting
`,
    },
    "troubleshooting": {
        title: "Troubleshooting — common issues + diagnostic recipes",
        body: `Top issues, ranked by how often they bite operators:

1. Panel container restart-loops
   - 'docker compose logs --tail=120 panel | head -60'
   - Look for: BETTER_AUTH_SECRET, invalid DOMAIN/PANEL_DOMAIN,
     SQLite path/permission errors, or render failures.

2. Caddy fails to acquire ACME cert
   - 'docker compose logs --tail=80 caddy | grep -iE "acme|cert"'
   - Most common: port 80 not reachable from outside (firewall,
     cloud provider security group blocks).
   - Test: from a DIFFERENT machine, curl http://<DOMAIN>/.well-
     known/acme-challenge/test.

3. DNS A record does not match host IP
   - Visible in 'ct doctor' as a FAIL on the DNS check.
   - 'dig +short A <DOMAIN>' to see what the world resolves
     vs 'curl -s4 https://ifconfig.co' for the host's public IP.
   - Update DNS, wait ~5-10 min for propagation, re-run doctor.

4. 'ct update' refuses to start ("stack is entirely down")
   - You probably want 'ct install', not 'ct update'.
   - But: 'docker compose ps' first to confirm.

5. /up endpoint returns non-200 or connection-refused
   - 'docker compose ps panel' -- is it running?
   - 'docker compose logs --tail=80 panel' -- did the Bun admin server crash?

6. Doctor shows FAIL
   - Rerun and read the Remediation block.
   - Check the service-specific log command printed there.

7. 'git pull' blocked by uncommitted changes
   - 'ct update' preflight offers s / d / a
     (stash with label / discard / abort).
   - Stash with label is recoverable: 'git stash pop'.

8. Retained Redis queue depth growing
   - 'doctor' shows this in the Info section.
   - Means a retained background worker is stuck or overloaded.
     Restart with:
       docker compose restart panel
     supervisord will re-spawn managed programs on container restart.

When asking for help, paste:
  - The last 40 lines of the script's output
  - 'docker compose ps' output
  - The relevant container's last 40 log lines

That's enough for almost any diagnosis.

Topics:  ./ct help   (list all)
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
    lines.push(`${ANSI.bold}${ANSI.green}cool-tunnel-server — operator help${ANSI.reset}`);
    lines.push("");
    lines.push("Usage:");
    lines.push("  ct help <topic>");
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
    const rest = (cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2)).filter((a) => a !== "--json");

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
