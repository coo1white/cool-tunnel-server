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
  2. Edit .env with your domain, Better Auth secret, and Reality keys
  3. Run ct install                 (idempotent; bundle-only)
  4. Run ct admin bootstrap         (writes root-only setup material)
  5. Visit https://panel.<DOMAIN>/setup once, then /login

For the long-form tutorial, see README.md and docs/installation-debian.md.

Next topic:  ./ct help install
`,
  },
  install: {
    title: "ct install — first-time bootstrap",
    body: `What it does:
  - Verifies required tools are on PATH (docker, curl, jq)
  - Refuses to run without a mode-0600 .env
  - Loads the verified release Docker image bundle
  - Applies idempotent SQLite migrations for the admin API
  - Renders Caddyfile and sing-box config via admin-api
  - Starts admin-api, admin-web, singbox, and caddy
  - Reminds you to run ct admin bootstrap for first-owner setup

Important security facts:
  - No default credentials are created.
  - Bootstrap setup material is written to a root-only local file by
    ct admin bootstrap, never printed raw to normal output.
  - Login and setup submit credentials by server-side POST.

Common failure modes:
  - Port 80/443 in use   -> stop the conflicting service or change
                            Caddy bind addresses intentionally
  - DNS does not match   -> update A record to host IP, wait, retry
  - Image bundle missing -> release asset is incomplete for this CPU;
                            run ./scripts/fetch_image_bundle.sh
  - Secret validation    -> set BETTER_AUTH_SECRET and Reality keys
                            in .env, then rerun

Idempotent: safe to re-run if anything fails halfway.

Next topic:  ./ct help update
`,
  },
  update: {
    title: "update — pull a new release and reconcile",
    body: `What it does:
  Pre-flight:
    - Network reachable for GitHub release downloads
    - Disk headroom for release image slices and docker load
    - Existing stack state is reported but a down stack is reconciled

  Main flow:
    - git pull --ff-only when possible
    - Load the verified Docker image bundle for this release
    - Apply idempotent SQLite migrations, including optional legacy
      staging tables for v0.5.1 PHP/MariaDB exports
    - Render Caddyfile and sing-box config through admin-api
    - Recreate admin-api, admin-web, singbox, and caddy with
      --no-build --pull never

What it does NOT do:
  - Drop admin users, roles, proxy accounts, settings, or audit logs
  - Print secrets, bootstrap tokens, UUIDs, or subscription URLs
  - Compile Docker images on the VPS
  - Roll back automatically on failure

Migration note:
  v0.5.1 MariaDB data must be exported into the documented legacy_*
  SQLite staging tables before ct admin migrate/ct update if you are
  moving data from the PHP release. Already-migrated SQLite
  databases are migrated in place.

Next topic:  ./ct help doctor
`,
  },
  doctor: {
    title: "doctor — health dashboard",
    body: `What it does:
  Runs read-only checks against the live stack and prints a
  PASS / WARN / FAIL table grouped by area:

    Prerequisites          docker compose, .env mode
    Structural             DNS, ports 80/443, ACME cert expiry
    Application            Hono /up endpoint, direct-dial config
    Compose stack          admin-api, admin-web, caddy, singbox, docker-proxy, redis
    Resources              disk + RAM headroom
    Info                   release version, active proxy accounts

When to run:
  - First thing when SSHing in to check a deployment
  - Before and after ct update
  - After staging a v0.5.1 migration export

What it does NOT do:
  - Modify state. It is safe during deploys and outages.
  - Repair issues automatically. It prints likely next commands.

Exit codes:
  0   - all-PASS or WARN-only
  1   - one or more FAIL rows

Next topic:  ./ct help auto-update
`,
  },
  "auto-update": {
    title: "auto-update — unattended release-pulling agent",
    body: `What it does:
  Checks origin/main for a newer release tag. If the deployed
  package.json version is older, it runs the standard ct update flow.

  The agent is DEFAULT-OFF. A fresh install never auto-upgrades.
  You opt in via:

    sudo ct auto-update enable

  Disable any time:

    sudo ct auto-update disable

Safety properties:
  - flock'd: two concurrent runs can't race.
  - Network-aware: aborts cleanly if origin is unreachable.
  - Uses the same bundle-only ct update path as manual operations.
  - Read-only when nothing to do.

Exit codes:
  0    up to date, OR upgraded successfully
  1    upgrade attempted and failed
  2    refused (network / git checkout / configuration issue)

Next topic:  ./ct help backup
`,
  },
  backup: {
    title: "backup — full deployment snapshot",
    body: `What it does:
  Creates a single tarball containing:
    - admin.sqlite copied with SQLite VACUUM INTO
    - caddy_data and caddy_etc volumes (ACME state and Caddyfile)
    - The current .env file
    - The manifest set
    - The Caddyfile template

  Output filename: backups/cool-tunnel-<UTC-timestamp>.tar.gz

What it does NOT include:
  - Container images (reload the matching release image bundle first)
  - The repo itself
  - Operating system / docker daemon state

The command redacts diagnostics and never puts passwords or tokens on argv.

Next topic:  ./ct help restore
`,
  },
  restore: {
    title: "restore — recover from a backup tarball",
    body: `What it does:
  Given backups/cool-tunnel-<ts>.tar.gz:
    - Refuses unsafe tar members before extraction
    - Restores admin.sqlite to data/admin/admin.sqlite
    - Restores Caddy data, .env, manifests, and Caddyfile template
    - Loads the release image bundle
    - Restarts admin-api, admin-web, singbox, and caddy

When to run:
  - Migrating to a new VPS
  - Recovering from SQLite corruption or accidental file deletion
  - Testing backup integrity in staging

What it does NOT do:
  - Selective restore of one table or one setting
  - Rebuild images locally
  - Publish or expose restored secrets in logs

Next topic:  ./ct help troubleshooting
`,
  },
  troubleshooting: {
    title: "Troubleshooting — common issues + diagnostic recipes",
    body: `Top issues, ranked by how often they bite operators:

1. Admin API or web container restart-loops
   - docker compose logs --tail=120 admin-api admin-web
   - Check BETTER_AUTH_SECRET, BETTER_AUTH_URL, Reality keys, and
     SQLite volume permissions.

2. Caddy fails to acquire ACME cert
   - docker compose logs --tail=80 caddy | grep -iE "acme|cert"
   - Most common: port 80 unreachable from outside.

3. DNS A record does not match host IP
   - Visible in ct doctor as a FAIL on the DNS check.
   - Compare dig +short A <DOMAIN> with curl -s4 https://ifconfig.co.

4. /up endpoint returns non-200 or connection-refused
   - docker compose ps admin-api
   - docker compose logs --tail=80 admin-api

5. Proxy clients fail after UUID rotation
   - Re-import the masked subscription URL from the admin UI.
   - Old UUIDs are accepted only during the configured grace window.

6. Migration status is not current
   - Run ct admin migrate.

When asking for help, paste:
  - The last 40 lines of the command output
  - docker compose ps output
  - Relevant container logs with secrets redacted

Topics:  ./ct help   (list all)
`,
  },
};

export const TOPIC_SLUGS: readonly string[] = Object.keys(TOPICS);

function h1(title: string): string {
  const underline = "=".repeat(title.length);
  return `\n${ANSI.bold}${ANSI.green}${title}${ANSI.reset}\n${ANSI.green}${underline}${ANSI.reset}\n`;
}

export function renderTopic(
  slug: string,
): { ok: true; output: string } | { ok: false; error: string } {
  const t = TOPICS[slug];
  if (!t) {
    return { ok: false, error: `unknown topic: ${slug}` };
  }
  return { ok: true, output: `${h1(t.title)}\n${t.body}` };
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

  if (
    rest.length === 0 ||
    rest[0] === "list" ||
    rest[0] === "topics" ||
    rest[0] === "-h" ||
    rest[0] === "--help"
  ) {
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
