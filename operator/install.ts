#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/install.ts — `ct install` implementation. First-time
// bootstrap for Cool Tunnel Server on a fresh Debian VPS. Port of
// scripts/install.sh — preserves every step, prompt, and diagnostic
// the bash original carried (including the incident comments that
// document why each guard exists). Idempotent: re-runnable if any
// step fails halfway.
//
// Stages (mirrors install.sh):
//   1.  Pre-flight: required tools (openssl, sed, dig, curl, jq, docker)
//   2.  IPv6 broken-route advisory (auto-disable handled in bootstrap.sh)
//   3.  acquireOpLock (per-project flock; re-execs self under flock)
//   4.  Pre-flight: .env (existence, 0600 mode, bcrypt-hash scan, value sanity)
//   5.  Pre-flight: clone freshness vs origin/main (interactive)
//   6.  Pre-flight: leftover Docker state from prior attempt (interactive)
//   7.  Build ct-server-core (release / release-small profile)
//   8.  Build caddy / singbox / panel images
//   9.  Start db + redis; wait for MariaDB healthcheck
//  10.  Start panel; wait for entrypoint sentinel; verify migrations + seed
//  11.  Re-render Caddyfile + singbox.json from the seeded DB
//  12.  Pre-flight: DNS A-records + port-80 reachability for ACME
//  13.  Start Caddy + singbox (clear zombie ct-caddy first); wait for panel TLS cert
//  14.  Verify singbox
//  15.  Create the first Filament admin user (interactive ct:make-admin)
//  16.  Strict health gates
//  17.  Print success banner

import { spawnSync } from "node:child_process";
import { $, capture, runStreaming, which } from "./src/util/sh";
import { die, makeTerm, ANSI } from "./src/util/term";
import { dieWithDiag } from "./src/util/diag";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { waitFor } from "./src/util/wait";
import { checkIpv6Routing } from "./src/util/preflight";
import { ensureRepoRoot } from "./src/util/repo-root";
import { promptYn } from "./src/util/prompt";

const { step, ok, warn } = makeTerm();

// ---------- file-mode helper (portable; mirrors lib.sh::file_mode_octal) ----

async function fileModeOctal(path: string): Promise<string | null> {
    // GNU stat (Debian/Ubuntu): `-c '%a'`. macOS / BSD: `-f '%OLp'`.
    const gnu = await capture($`stat -c %a ${path}`);
    if (gnu.ok) return gnu.stdout.trim();
    const bsd = await capture($`stat -f %OLp ${path}`);
    if (bsd.ok) return bsd.stdout.trim();
    return null;
}

// ---------- step 1: required tools ----------------------------------------

async function preflightTools(): Promise<void> {
    step("Pre-flight: required tools");
    const tools: Array<[string, string]> = [
        ["openssl", "apt install -y openssl"],
        ["sed", "apt install -y sed"],
        ["dig", "apt install -y dnsutils      # for DNS sanity"],
        ["curl", "apt install -y curl"],
        ["jq", "apt install -y jq            # used by manifest checks"],
        ["docker", "Install per docs/installation-debian.md (uses Docker's official apt repo)."],
    ];
    for (const [bin, hint] of tools) {
        if (!(await which(bin))) die(`required command '${bin}' is not on PATH`, hint);
    }
    const compose = await capture($`docker compose version`);
    if (!compose.ok) {
        die("docker compose v2 not available", "Install with: apt install -y docker-compose-plugin");
    }
    ok("all required tools present");
}

// ---------- step 4: .env existence + mode ---------------------------------

async function preflightEnvFile(): Promise<void> {
    step("Pre-flight: .env");
    const envExists = await Bun.file(".env").exists();
    if (!envExists) {
        if (await promptYn("No .env file found. Copy .env.example to .env now?", "y")) {
            const cp = await capture($`cp .env.example .env`);
            if (!cp.ok) die("cp .env.example .env failed", cp.stderr.trim());
            const chmod = await capture($`chmod 0600 .env`);
            if (!chmod.ok) die("chmod 0600 .env failed", chmod.stderr.trim());
            ok("created .env from template (mode 0600)");
            warn("you must edit .env (DOMAIN, ACME_EMAIL, *_PASSWORD) before continuing");
            die("open .env, fill in real values, then re-run ./ct install", "$EDITOR .env");
        } else {
            die(".env is required", "cp .env.example .env  &&  $EDITOR .env");
        }
    }
    // Refuse to proceed if .env is world-readable. APP_KEY encrypts
    // every proxy_accounts.password_cleartext_encrypted row and signs
    // every subscription manifest; leaking it recovers all tenant
    // cleartext. (R2-1, docs/audits/2026-05-04T06-31-58Z.md.)
    const mode = await fileModeOctal(".env");
    if (mode === null) die("could not stat .env", "check .env exists and is readable");
    const otherBits = parseInt(mode.slice(-1), 10);
    if (Number.isFinite(otherBits) && otherBits >= 4) {
        die(`.env is world-readable (mode ${mode}); APP_KEY + DB credentials would leak`, "chmod 0600 .env");
    }
    // Bcrypt-hash scan: `set -a; . .env` aborts on `$2y$10$...` if
    // unquoted because bash reads `$2` as positional arg under set -u.
    const envText = await Bun.file(".env").text();
    const bcryptLines = envText
        .split("\n")
        .map((l, i) => ({ line: l, n: i + 1 }))
        .filter((x) => /^[A-Z_][A-Z0-9_]*=\$2[ayb]\$/.test(x.line));
    if (bcryptLines.length > 0) {
        process.stderr.write(
            "\n  ✗ .env has an unquoted bcrypt hash. Bash reads $2 / $1 etc. as\n" +
                "    positional args during 'set -a; . .env' and aborts.\n" +
                "    Wrap the value in SINGLE quotes:\n\n",
        );
        for (const x of bcryptLines) process.stderr.write(`      ${x.n}:${x.line}\n`);
        process.stderr.write("\n    Change   SOME_HASH=$2y$10$abc...\n");
        process.stderr.write("    To       SOME_HASH='$2y$10$abc...'\n\n");
        die("aborted on unquoted bcrypt hash in .env", "wrap bcrypt values in single quotes");
    }
    ok(".env loaded");
}

// ---------- step 4b/5/6: validate .env values + cross-fields --------------

interface InstallEnv {
    DOMAIN: string;
    PANEL_DOMAIN: string;
    ACME_EMAIL: string;
    CT_CORE_BUILD_PROFILE: string;
    ACME_DIRECTORY: string;
}

async function validateEnvAndDeriveDefaults(): Promise<InstallEnv> {
    const text = await Bun.file(".env").text();
    const env = parseSimpleEnv(text);
    const get = (k: string): string => env[k] ?? "";

    if ((get("DOMAIN") || "proxy.example.com") === "proxy.example.com") {
        warn("DOMAIN is still set to the placeholder 'proxy.example.com'");
        warn("ACME will fail unless you point a real domain at this server");
        if (!(await promptYn("Continue anyway (e.g. for local docker-only testing)?", "n"))) {
            die("aborted on placeholder DOMAIN", "edit .env");
        }
    }
    if ((get("ACME_EMAIL") || "admin@example.com") === "admin@example.com") {
        warn("ACME_EMAIL is still the placeholder; Let's Encrypt sends renewal warnings to it");
    }
    requireEnv(env, "DB_PASSWORD", "openssl rand -base64 32 # paste into .env DB_PASSWORD=");
    requireEnv(env, "DB_ROOT_PASSWORD", "openssl rand -base64 32 # paste into .env DB_ROOT_PASSWORD=");
    requireEnv(env, "REDIS_PASSWORD", "openssl rand -base64 32 # paste into .env REDIS_PASSWORD=");

    // PANEL_DOMAIN gate (v0.0.33 R1-1/R1-2): default to panel.${DOMAIN}
    // rather than failing — operator intent is recoverable from DOMAIN.
    let panelDomain = get("PANEL_DOMAIN");
    if (!panelDomain) {
        const domain = get("DOMAIN");
        if (!domain) {
            die("PANEL_DOMAIN and DOMAIN are both unset — cannot derive default", "edit .env: set DOMAIN= and PANEL_DOMAIN=");
        }
        panelDomain = `panel.${domain}`;
        warn(`PANEL_DOMAIN not set in .env — defaulting to ${panelDomain}`);
        warn("(R1-1 / R1-2 added a public admin panel at this name in v0.0.33)");
        await upsertEnvKey("PANEL_DOMAIN", panelDomain);
    }
    if (panelDomain === "panel.proxy.example.com") {
        warn("PANEL_DOMAIN is still set to the placeholder 'panel.proxy.example.com'");
        warn("ACME will fail unless this points at a DNS A record on this VPS");
        if (!(await promptYn("Continue anyway (e.g. for local docker-only testing)?", "n"))) {
            die("aborted on placeholder PANEL_DOMAIN", "edit .env");
        }
    }

    return {
        DOMAIN: get("DOMAIN"),
        PANEL_DOMAIN: panelDomain,
        ACME_EMAIL: get("ACME_EMAIL"),
        CT_CORE_BUILD_PROFILE: get("CT_CORE_BUILD_PROFILE") || "release",
        ACME_DIRECTORY: get("ACME_DIRECTORY"),
    };
}

function parseSimpleEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        let val = m[2] ?? "";
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        env[m[1]!] = val;
    }
    return env;
}

function requireEnv(env: Record<string, string>, key: string, hint: string): void {
    if (!env[key]) die(`env var ${key} is empty`, hint);
}

// Upsert KEY=value in .env: replace if present, append otherwise. Mirror
// scripts/install.sh's sed/grep sequence but in TS so we don't shell out
// for every write.
async function upsertEnvKey(key: string, value: string): Promise<void> {
    const text = await Bun.file(".env").text();
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => new RegExp(`^${key}=`).test(l));
    if (idx >= 0) {
        lines[idx] = `${key}=${value}`;
    } else {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(`${key}=${value}`);
    }
    await Bun.write(".env", lines.join("\n"));
}

// ---------- step 7: clone freshness check ---------------------------------

async function preflightCloneFreshness(): Promise<void> {
    step("Pre-flight: repo + Docker state freshness");
    const isGitRepo = await capture($`test -d .git`);
    if (!isGitRepo.ok) {
        ok("not a git checkout — skipping clone-freshness check (tarball install?)");
        return;
    }
    const hasOrigin = await capture($`git remote get-url origin`);
    if (!hasOrigin.ok) {
        ok("no 'origin' remote — skipping clone-freshness check");
        return;
    }
    const fetch = await capture($`git fetch --quiet origin main`);
    if (!fetch.ok) {
        warn("could not fetch origin/main (offline?); skipping freshness check");
        return;
    }
    const local = (await capture($`git rev-parse HEAD`)).stdout.trim();
    const remote = (await capture($`git rev-parse origin/main`)).stdout.trim();
    if (!local || !remote || local === remote) {
        ok("clone is up to date with origin/main");
        return;
    }
    const mergeBase = (await capture($`git merge-base HEAD origin/main`)).stdout.trim();
    if (mergeBase === local) {
        // Strictly behind.
        const behind = (await capture($`git rev-list --count HEAD..origin/main`)).stdout.trim() || "?";
        warn(`your clone is ${behind} commit(s) behind origin/main`);
        warn("stale clones often hit hotfixes that already shipped");
        if (await promptYn("Pull origin/main now?", "y")) {
            const pull = await capture($`git pull --ff-only origin main`);
            if (!pull.ok) die("git pull failed", "resolve manually then re-run ./ct install");
            const short = (await capture($`git rev-parse --short HEAD`)).stdout.trim();
            ok(`fast-forwarded to ${short}`);
            warn("the script you're running is the OLD in-memory copy; exit and re-run to pick up the new one");
            if (!(await promptYn("Continue with the OLD in-memory script anyway?", "n"))) {
                die("aborted so you can re-run with the fresh script", "./ct install");
            }
        } else {
            warn("continuing with stale clone (you've been warned)");
        }
    } else if (mergeBase === remote) {
        const ahead = (await capture($`git rev-list --count origin/main..HEAD`)).stdout.trim() || "?";
        ok(`clone has ${ahead} unpushed commit(s) ahead of origin/main (assuming intentional)`);
    } else {
        warn("clone has diverged from origin/main (commits on each side)");
        if (!(await promptYn("Continue with this state?", "n"))) {
            die("aborted on diverged clone", "git rebase origin/main  (or: git reset --hard origin/main)");
        }
    }
}

// ---------- step 8: leftover Docker state ---------------------------------

async function preflightDockerState(): Promise<void> {
    const project = (await capture($`basename ${process.cwd()}`)).stdout.trim() || "cool-tunnel-server";
    const psRes = await capture($`docker compose ps -a -q`);
    const containerCount = psRes.ok ? psRes.stdout.split("\n").filter(Boolean).length : 0;
    const volRes = await capture($`docker volume ls --format {{.Name}}`);
    const volumeCount = volRes.ok
        ? volRes.stdout
              .split("\n")
              .filter((l) => l.startsWith(`${project}_`)).length
        : 0;
    if (containerCount === 0 && volumeCount === 0) {
        ok("no leftover Docker state from prior install");
        return;
    }
    warn("Docker state from a prior install detected:");
    warn(`  containers: ${containerCount}    volumes: ${volumeCount}`);
    warn("wipe only for a fresh reinstall; keep existing state to preserve data");
    if (await promptYn("Wipe Docker volumes? DESTROYS database data", "n")) {
        await capture($`docker compose down -v`);
        ok("prior containers + volumes removed");
    } else {
        ok("keeping existing Docker volumes and database");
    }
}

// ---------- step 9: build core --------------------------------------------

async function buildCore(coreProfile: string): Promise<void> {
    step("Build ct-server-core (Rust, musl-static)");
    ok(`core build profile: ${coreProfile}`);
    const r = await runStreaming(
        $`docker compose --profile build-only build core-builder --build-arg CARGO_PROFILE=${coreProfile}`,
    );
    if (!r.ok) {
        dieWithDiag(
            "ct-server-core build failed",
            `Common causes (in priority order):
  - Out of disk     ->  df -h .   then  docker builder prune -af
  - Network blip    ->  retry: ./ct install
  - Cargo cache rot ->  rm -rf core/target  then retry`,
        );
    }
    ok(`ct-server-core built (profile=${coreProfile})`);
}

// ---------- steps 10/11/12: build caddy / singbox / panel -----------------

async function buildImage(label: string, service: string, hint?: string[]): Promise<void> {
    step(`Build ${label}`);
    if (hint) for (const h of hint) warn(h);
    const r = await runStreaming($`docker compose build ${service}`);
    if (!r.ok) dieWithDiag(`${label} build failed`, `docker compose logs --tail=80 ${service}`);
    ok(`${label.toLowerCase()} built`);
}

// ---------- step 13: bring up db + redis ----------------------------------

async function bringUpDataLayer(): Promise<void> {
    step("Start db + redis");
    const up = await capture($`docker compose up -d db redis`);
    if (!up.ok) dieWithDiag("compose up -d db redis failed", up.stderr.split("\n").slice(0, 5).join("\n"));
    ok("db + redis containers started");

    const dbHealthy = await waitFor({
        label: "MariaDB healthcheck",
        maxAttempts: 30,
        intervalMs: 2000,
        probe: async () => {
            const r = await capture(
                $`docker inspect -f {{.State.Health.Status}} ct-db`,
            );
            return r.ok && r.stdout.trim() === "healthy";
        },
    });
    if (!dbHealthy) {
        dieWithDiag(
            "MariaDB never reached healthy after 60s",
            `docker compose logs --tail=80 db
Most common: stale volume from a prior install (DB_PASSWORD
changed since volume init) — re-run install and answer 'y' to
the wipe prompt; or a CPU-starved VPS still running initdb.`,
        );
    }
}

// ---------- step 14: bring up panel + verify migrations -------------------

async function bringUpPanel(): Promise<void> {
    step("Start panel and run database migrations");
    const up = await capture($`docker compose up -d panel`);
    if (!up.ok) dieWithDiag("compose up -d panel failed", up.stderr.split("\n").slice(0, 5).join("\n"));

    warn("panel entrypoint is running 'composer install' on first boot;");
    warn("this takes ~30-90s on a small VPS. Watch progress with:");
    warn("    docker compose logs -f --tail=80 panel");

    const sentinel = await waitFor({
        label: "panel entrypoint setup complete (sentinel)",
        maxAttempts: 90,
        intervalMs: 5000,
        probe: async () => {
            const r = await capture(
                $`docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete`,
            );
            return r.ok;
        },
    });
    if (!sentinel) {
        dieWithDiag(
            "panel entrypoint never finished within 7.5 min",
            `docker compose logs --tail=120 panel
Most common stuck-step on a fresh box: composer install (slow
network or packagist blocked); on an upgrade: migrate (pending
schema change failed).`,
        );
    }

    // Verify migrate:status reports no pending — the entrypoint runs
    // `migrate --force --no-interaction || true` so we need an
    // explicit observation of success.
    const status = await capture(
        $`docker compose exec -T panel php artisan migrate:status --no-interaction`,
    );
    if (/\bPending\b/i.test(status.stdout)) {
        process.stdout.write(status.stdout.split("\n").slice(-40).join("\n") + "\n");
        dieWithDiag(
            "panel has pending migrations — entrypoint migrate failed (|| true swallowed it)",
            "docker compose logs --tail=80 panel",
        );
    }
    await capture($`docker compose exec -T panel php artisan db:seed --force --no-interaction`);
    ok("migrations applied + default seed in place");
}

// ---------- step 15: re-render configs after seed -------------------------

async function reRenderCaddyfile(): Promise<void> {
    step("Re-render Caddyfile from the seeded DB");
    const r = await capture(
        $`docker compose exec -T panel ct-server-core --json caddyfile render`,
    );
    if (!r.ok) {
        warn("Caddyfile re-render failed — Caddy will start with the entrypoint's render");
        return;
    }
    ok("Caddyfile re-rendered to /etc/caddy/Caddyfile (caddy_etc volume)");
}

async function reRenderSingbox(): Promise<void> {
    step("Re-render singbox.json from the seeded DB");
    const r = await capture(
        $`docker compose exec -T panel php artisan singbox:render --no-interaction`,
    );
    if (!r.ok) {
        dieWithDiag(
            "singbox.json render failed",
            `docker compose logs --tail=120 panel
docker compose exec -T panel php artisan singbox:render --no-interaction`,
        );
    }

    const file = await capture($`docker compose exec -T panel test -s /data/config/singbox.json`);
    if (!file.ok) {
        dieWithDiag(
            "singbox.json was not written",
            `docker compose exec -T panel ls -l /data/config
docker compose logs --tail=120 panel`,
        );
    }
    ok("singbox.json rendered to /data/config/singbox.json (singbox_config volume)");
}

// ---------- step 16: DNS + port 80 preflight ------------------------------

async function preflightDnsAndPort80(env: InstallEnv): Promise<void> {
    step("Pre-flight: DNS + port 80 reachability for ACME");
    const ipRes = await capture($`curl -s4 --max-time 5 https://icanhazip.com`);
    const publicIp = ipRes.ok ? ipRes.stdout.trim() : "";
    if (!publicIp) {
        warn("Couldn't determine public IPv4 via icanhazip.com — skipping DNS check");
        warn(`If ACME stalls, verify dig +short ${env.DOMAIN} matches your VPS IP`);
    } else {
        const apex = (await capture($`dig +short A ${env.DOMAIN}`)).stdout.trim().split("\n")[0] ?? "";
        const panel = (await capture($`dig +short A ${env.PANEL_DOMAIN}`)).stdout.trim().split("\n")[0] ?? "";
        if (apex !== publicIp) {
            warn(`DNS mismatch: ${env.DOMAIN} → ${apex || "<empty>"}, but VPS IP is ${publicIp}`);
            warn(`ACME HTTP-01 challenge for ${env.DOMAIN} WILL fail until DNS propagates`);
            warn(`Fix: at your DNS provider, set A record ${env.DOMAIN} → ${publicIp}`);
        } else {
            ok(`DNS: ${env.DOMAIN} → ${publicIp}`);
        }
        if (panel !== publicIp) {
            warn(`DNS mismatch: ${env.PANEL_DOMAIN} → ${panel || "<empty>"}, but VPS IP is ${publicIp}`);
            warn(`ACME for ${env.PANEL_DOMAIN} WILL fail until DNS propagates`);
        } else {
            ok(`DNS: ${env.PANEL_DOMAIN} → ${publicIp}`);
        }
    }
    if (publicIp) await probePort80(publicIp);
}

// Port-80 reachability: spin a one-shot Bun.serve on :80, curl ourselves
// via the public IP, stop the listener. Catches firewall blocks /
// missing security-group rule / CGNAT before the 90-s ACME wait.
async function probePort80(publicIp: string): Promise<void> {
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
        server = Bun.serve({
            port: 80,
            fetch: () => new Response("ok"),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Could not bind :80 for self-test (${msg.split("\n")[0]}); skipping port-80 probe`);
        return;
    }
    // Give the listener a moment.
    await new Promise((r) => setTimeout(r, 1000));
    const r = await capture($`curl -s --max-time 8 http://${publicIp}:80`);
    server.stop(true);
    if (r.ok && r.stdout.includes("ok")) {
        ok("Port 80 reachable from public IP");
    } else {
        warn(`Port 80 NOT reachable from public IP ${publicIp}`);
        warn("Likely causes: cloud-provider firewall, ufw, IPv6-only DNS, CGNAT");
        warn("ACME HTTP-01 will fail. Fix: open TCP 80 inbound + verify DNS");
    }
}

// ---------- step 17: start caddy + singbox + wait for panel cert ----------

async function bringUpCaddy(env: InstallEnv): Promise<void> {
    step(`Start Caddy + singbox (ACME — :80 challenges; Caddy manages cert for ${env.PANEL_DOMAIN})`);
    // v0.1.9 fix: clear a stale ct-caddy from a prior failed attempt
    // so `compose up` doesn't hit "bind 0.0.0.0:80: address already
    // in use" forever.
    const state = (await capture($`docker inspect -f {{.State.Status}} ct-caddy`)).stdout.trim();
    if (state === "created" || state === "exited" || state === "dead") {
        warn(`removing stale ct-caddy (state=${state}) from prior attempt`);
        await capture($`docker rm -f ct-caddy`);
    }
    const up = await capture($`docker compose up -d caddy singbox`);
    if (!up.ok) dieWithDiag("compose up -d caddy singbox failed", up.stderr.split("\n").slice(0, 5).join("\n"));
    ok("caddy running on :80/:443 and singbox starting behind the SNI splitter");
    warn("Caddy will fetch the panel TLS cert from Let's Encrypt now;");
    warn("this usually obtains in 10-60 s. Tail logs with:");
    warn("    docker compose logs -f --tail=80 caddy");

    const caFolder = env.ACME_DIRECTORY.includes("staging")
        ? "acme-staging-v02.api.letsencrypt.org-directory"
        : "acme-v02.api.letsencrypt.org-directory";
    const panelCert = `/data/caddy/certificates/${caFolder}/${env.PANEL_DOMAIN}/${env.PANEL_DOMAIN}.crt`;

    step("Wait for Caddy to obtain the panel TLS certificate (up to 90 s)");
    const caddyAcmeHint = `docker compose logs --tail=120 caddy
Then check, in order:
  (1) DNS A record for ${env.PANEL_DOMAIN} points at this server's public IP
  (2) cloud-firewall TCP/80 inbound is open
  (3) Caddy didn't crash-loop
  (4) Let's Encrypt rate limit not hit (https://letsencrypt.org/docs/rate-limits/)
      — switch to staging via ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory in .env if you've been retrying`;

    const panelOk = await waitFor({
        label: `Caddy cert (panel) at ${panelCert}`,
        maxAttempts: 45,
        intervalMs: 2000,
        probe: async () => (await capture($`docker compose exec -T caddy test -f ${panelCert}`)).ok,
    });
    if (!panelOk) dieWithDiag(`Caddy panel cert never appeared after 90s`, caddyAcmeHint);
}

// ---------- step 18: start singbox ----------------------------------------

async function bringUpSingbox(env: InstallEnv): Promise<void> {
    step("Verify singbox (reads singbox.json from singbox_config)");
    const r = await capture($`docker compose ps singbox --status running --quiet`);
    if (!r.ok || !r.stdout.trim()) {
        dieWithDiag(
            "singbox is not running",
            `docker compose ps singbox
docker compose logs --tail=80 singbox`,
        );
    }
    ok("singbox running (sing-box VLESS+Reality, supervised by singbox-core)");
    ok("  Caddy's layer-4 SNI splitter routes :443 traffic:");
    ok(`    non-panel SNI     → singbox (VLESS+Reality)`);
    ok(`    SNI=${env.PANEL_DOMAIN} → inner panel listener`);
}

// ---------- step 19: create first admin -----------------------------------

async function createAdmin(): Promise<void> {
    step("Create the first Filament admin user (interactive prompt follows)");
    if (!process.stdin.isTTY) {
        warn("non-interactive run - skipping admin creation");
        warn("create one later with: docker compose exec panel php artisan ct:make-admin");
        return;
    }
    // Pass-through TTY for the interactive artisan prompt. Don't use
    // Bun.$ here — it captures stdio and the prompt would never appear.
    const r = spawnSync(
        "docker",
        ["compose", "exec", "panel", "php", "artisan", "ct:make-admin"],
        { stdio: "inherit" },
    );
    if (r.status !== 0) {
        warn("could not create admin — re-run later with: docker compose exec panel php artisan ct:make-admin");
    }
}

// ---------- success banner ------------------------------------------------

function printSuccessBanner(env: InstallEnv): void {
    const bold = ANSI.bold;
    const green = ANSI.green;
    const reset = ANSI.reset;
    process.stdout.write(`
${bold}${green}Cool Tunnel Server is up.${reset}

  Panel         https://${env.PANEL_DOMAIN}/admin
  Subscription  https://${env.PANEL_DOMAIN}/api/v1/subscription/<token>
                  (issued from the panel; clients import this URL
                  rather than constructing a per-account proxy URL
                  manually)

What to do next:

  1. Watch ACME finish:
       ${bold}docker compose logs -f --tail=80 caddy${reset}

  2. Create your first proxy account:
       open https://${env.PANEL_DOMAIN}/admin -> ProxyAccounts -> New
       (cleartext password is shown ONCE - copy it then)

  3. Import the subscription URL into the macOS client.

  4. Run the health gate:
       ${bold}./ct doctor${reset}

If something looks wrong, the safe first move is:
       ${bold}${green}ct doctor${reset}        (PASS / WARN / FAIL dashboard)

To have this box auto-pull new releases (default OFF, opt-in):
       ${bold}sudo ct auto-update enable${reset}
`);
}

// ---------- top-level entry -----------------------------------------------

export async function runInstall(): Promise<number> {
    ensureRepoRoot(import.meta.url);

    // Pre-lock silent gates so any operator running install on a box
    // missing docker / .env fails fast WITHOUT racing the re-exec.
    if (!(await which("docker"))) {
        die("required command 'docker' is not on PATH", "Install per docs/installation-debian.md (uses Docker's official apt repo).");
    }
    if (!(await Bun.file(".env").exists())) {
        if (await promptYn("No .env file found. Copy .env.example to .env now?", "y")) {
            const cp = await capture($`cp .env.example .env`);
            if (!cp.ok) die("cp .env.example .env failed", cp.stderr.trim());
            await capture($`chmod 0600 .env`);
            warn("created .env from template (mode 0600)");
            die("open .env, fill in real values, then re-run ./ct install", "$EDITOR .env");
        } else {
            die(".env is required", "cp .env.example .env  &&  $EDITOR .env");
        }
    }

    if (!process.env[LOCK_HELD_MARKER]) {
        await acquireOpLock();
    }

    await preflightTools();

    // IPv6 routing advisory. Auto-disable happens in bootstrap.sh
    // (writes /etc/sysctl.d/99-disable-ipv6.conf + /etc/docker/
    // daemon.json). install.ts only flags the live routing state so
    // a box that was upgraded post-bootstrap and lost the disable
    // gets a visible warning before the Rust build's first
    // `static.rust-lang.org Network unreachable`.
    const ipv6 = await checkIpv6Routing();
    if (ipv6.action === "warn") warn(ipv6.detail);
    else ok(ipv6.detail);

    await preflightEnvFile();
    const env = await validateEnvAndDeriveDefaults();
    await preflightCloneFreshness();
    await preflightDockerState();

    await buildCore(env.CT_CORE_BUILD_PROFILE);
    await buildImage("caddy image (stock Caddy 2 — ACME provider only, no plugins)", "caddy");
    await buildImage("singbox image (downloads upstream sing-box binary)", "singbox");
    await buildImage(
        "panel image (FrankenPHP + Composer + ct-server-core baked in)",
        "panel",
        [
            "First panel build takes 8-15 min on a 1-vCPU VPS — most of the time",
            "is gd / intl / zip PHP-extension compilation against icu-dev /",
            "libzip-dev (no prebuilt wheels in dunglas/frankenphp:alpine). On a",
            "4-vCPU box ~3-5 min. Subsequent builds hit the layer cache and",
            "drop to ~30 s. Tail: docker compose logs -f --tail=80 panel",
        ],
    );

    await bringUpDataLayer();
    await bringUpPanel();
    await reRenderCaddyfile();
    await reRenderSingbox();
    await preflightDnsAndPort80(env);
    await bringUpCaddy(env);
    await bringUpSingbox(env);
    await createAdmin();
    printSuccessBanner(env);
    return 0;
}

if (import.meta.main) {
    const code = await runInstall();
    process.exit(code);
}
