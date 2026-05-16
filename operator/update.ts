#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/update.ts — pure-TS port of scripts/update.sh.
//
// Pulls a new release, rebuilds images, runs migrations + render
// + credential-lock guard + sing-box reload + haproxy reload, then
// component-checks the result. On NG the OLD images are still
// running on their volumes (compose hasn't swapped traffic).
//
// Stages preserved from the bash original:
//   1. acquireOpLock (per-project flock)
//   2. preflight: network, disk space, stack-up, clean tree
//      (TTY: interactive stash/discard/abort; non-TTY: dies)
//   3. git pull --ff-only
//   4. .env auto-migrate (PANEL_DOMAIN + APP_URL)
//   5. compose build core-builder (Rust)
//   6. compose build sing-box panel haproxy
//   7. haproxy_admin volume chown (one-time fix for pre-v0.0.51)
//   8. compose up -d panel sing-box haproxy
//   9. wait for panel entrypoint sentinel
//  10. php artisan migrate --force
//  11. ct-server-core singbox render
//  12. ct-server-core guard credential-lock
//  13. ct-server-core server reload + compose restart sing-box
//  14. ct-server-core haproxy render
//  15. compose kill -s HUP haproxy + compose up -d haproxy
//  16. component_check_strict /srv/manifests
//  17. fetch_operator_binary.sh (non-fatal)

import { $, capture, runStreaming, which } from "./src/util/sh";
import { die, makeTerm, ANSI } from "./src/util/term";
import { dieWithDiag, type DiagFailure } from "./src/util/diag";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { waitFor } from "./src/util/wait";
import { checkNetwork, checkDiskSpace, checkStackUp, checkIpv6Routing } from "./src/util/preflight";
import { ensureRepoRoot } from "./src/util/repo-root";
import { migrateEnv } from "./src/util/env-migrate";
import { runComponentCheckStrict } from "./src/util/component-check";
import { promptChoice, promptYn } from "./src/util/prompt";

const { step, ok, warn } = makeTerm();

function dieOnFailure(f: DiagFailure | undefined): void {
    if (f) dieWithDiag(f.summary, f.diag);
}

async function preflightCleanTree(): Promise<void> {
    const head = await capture($`git diff --quiet HEAD`);
    const cached = await capture($`git diff --quiet --cached`);
    if (head.ok && cached.ok) {
        ok("working tree clean");
        return;
    }
    process.stderr.write(`\n  ${ANSI.yellow}!${ANSI.reset} Working tree has uncommitted changes:\n\n`);
    const stat = await capture($`git diff --stat HEAD`);
    if (stat.ok) for (const l of stat.stdout.split("\n")) if (l) process.stderr.write(`    ${l}\n`);
    process.stderr.write(`\n  Preview (first 30 lines of diff):\n`);
    const diff = await capture($`git diff HEAD`);
    if (diff.ok) for (const l of diff.stdout.split("\n").slice(0, 30)) process.stderr.write(`    ${l}\n`);
    process.stderr.write(`\n`);

    // Interactive prompt (matches scripts/lib.sh::preflight_clean_tree).
    // Non-TTY (cron, CI) → dies with a diagnostic that points at
    // the manual recovery commands; same shape as before.
    if (!process.stdin.isTTY) {
        dieWithDiag(
            "uncommitted changes block git pull",
            `Running non-interactively, so this script will not auto-decide.

To preserve the edits and proceed:
  git stash push -u -m "preflight-$(date -u +%Y%m%dT%H%M%SZ)"
  ./ct update

To discard the edits and proceed:
  git checkout -- .
  ./ct update`,
        );
    }

    for (;;) {
        const choice = await promptChoice(
            [
                "  How do you want to proceed?",
                "    [s] stash with timestamp label (preserves edits, recoverable via 'git stash pop')",
                "    [d] discard local edits (NOT recoverable)",
                "    [a] abort — I'll handle it manually",
            ],
            "  choice [s/d/a]: ",
            ["s", "d", "a"],
            "a",
        );
        if (choice === "s") {
            const label = `preflight-${new Date().toISOString().replace(/[-:.]/g, "").replace(/\..*/, "").replace("T", "T")}Z`;
            const stash = await capture($`git stash push -u -m ${label}`);
            if (stash.ok) {
                ok(`stashed as '${label}' (recover with: git stash pop)`);
                return;
            }
            dieWithDiag(
                "git stash failed",
                `git refused to stash — usually means the index is in a
broken state. Inspect with:
  git status
  git stash list
If you see an in-progress merge / rebase / cherry-pick:
  git merge --abort  (or rebase --abort, etc.)`,
            );
        }
        if (choice === "d") {
            if (
                await promptYn(
                    "Discard ALL uncommitted changes to TRACKED files? (untracked files preserved)",
                    "n",
                )
            ) {
                const checkout = await capture($`git checkout -- .`);
                if (!checkout.ok) {
                    dieWithDiag(
                        "git checkout -- . failed",
                        checkout.stderr.split("\n")[0] ?? "",
                    );
                }
                ok("tracked-file changes reverted (untracked files left alone)");
                return;
            }
            // user declined the second confirmation; re-prompt the
            // top-level menu.
            continue;
        }
        // 'a' (abort) — or fallback when prompt returned null.
        dieWithDiag(
            "aborted on uncommitted changes",
            `You chose to handle this manually. The diff is shown above.
When ready to retry, run:
  ./ct update`,
        );
    }
}

async function gitPullFfOnly(): Promise<void> {
    step("git pull (fast-forward only)");
    const r = await capture($`git pull --ff-only`);
    if (!r.ok) {
        dieWithDiag(
            "git pull --ff-only refused to fast-forward",
            `Working tree is clean (preflight passed), so this is a non-FF
situation -- usually one of:
  - Upstream main was force-pushed (rare; check #incidents channel)
  - Local main has diverged from origin/main (you committed
    directly to main, not through a PR)
  - Detached HEAD or wrong branch

Inspect with:
  git log --oneline -5 HEAD origin/main
  git status

Recover by hard-resetting to the published main (loses any local
main commits -- be sure that is what you want):
  git fetch origin
  git reset --hard origin/main
  ./ct update`,
        );
    }
    if (r.stdout) process.stdout.write(r.stdout);
}

async function autoMigrateEnv(): Promise<void> {
    step("Auto-migrate legacy .env (PANEL_DOMAIN canonical placement + APP_URL hostname)");
    const f = Bun.file(".env");
    if (!(await f.exists())) die("required file '.env' is missing", "cp .env.example .env  &&  $EDITOR .env");
    const before = await f.text();
    const r = migrateEnv(before);
    if (r.warning) warn(r.warning);
    if (r.changes.length === 0) {
        ok("PANEL_DOMAIN already present in .env");
        ok("APP_URL already canonical");
        return;
    }
    await Bun.write(".env", r.content);
    for (const c of r.changes) ok(c.summary);
}

async function rebuildCore(): Promise<void> {
    step("Rebuild ct-server-core (Rust)");
    // Streams BuildKit progress live (`[+] Building 31.6s (17/23)...`).
    // The pre-v0.1.17 capture() variant buffered until subprocess
    // exit; on a 1 vCPU VPS the operator saw the "==> Rebuild" step
    // hang for 60-180s with no output and assumed the build was
    // stuck. Surfaced 2026-05-15 on the v0.1.16 Vultr update.
    const r = await runStreaming($`docker compose --profile build-only build core-builder`);
    if (!r.ok) {
        dieWithDiag(
            "ct-server-core build failed",
            `Common causes (in priority order):
  - Out of disk     ->  df -h .   then  docker builder prune -af
  - Network blip    ->  retry: ./ct update
  - Cargo cache rot ->  rm -rf core/target  then retry
  - Buildkit bug    ->  docker buildx rm default-builder; retry

If the build error mentions a specific Rust crate, paste the last
20 lines of output when asking for help. The crate name + line
number are usually enough to diagnose.`,
        );
    }
}

async function rebuildImages(): Promise<void> {
    step("Rebuild caddy + panel images");
    // v0.2.0+: caddy + panel only. sing-box and haproxy services
    // retired in the architecture cut. Same live-streaming rationale
    // as rebuildCore.
    const r = await runStreaming($`docker compose build caddy panel`);
    if (!r.ok) {
        dieWithDiag(
            "caddy / panel build failed",
            `Common causes (in priority order):
  - Out of disk             ->  df -h /var/lib/docker
                                then docker system prune -af
  - xcaddy / Go transient   ->  retry: ./ct update
                                (Caddy is built with the
                                klzgrad/forwardproxy plugin via
                                xcaddy; first build pulls a Go
                                dep graph from proxy.golang.org)
  - Composer.lock conflict  ->  this was the v0.0.95 class
                                of bug -- check the entrypoint
                                output for "platform-req" errors

The build prints which Dockerfile step failed; that pinpoints
which image (caddy / panel) and which line.`,
        );
    }
}

// v0.2.0 migration: detect v0.1.x containers (sing-box, haproxy)
// left over from before the architecture cut and stop+remove them
// so the new Caddy on :443 can bind without a port-collision war.
//
// Idempotent — running this on a freshly-cut v0.2.0 deploy that
// never had sing-box / haproxy is a clean no-op.
//
// Rollback note: image tags are NOT preserved here; a clean
// downgrade path is `git checkout v0.1.20 && ./ct update`, which
// re-introduces the sing-box and haproxy services via the v0.1.x
// docker-compose.yml. The image tags `cool-tunnel-server-singbox:
// latest` and `cool-tunnel-server-haproxy:latest` linger in the
// local docker registry until `docker image prune -a`; for the
// 30-day rollback window we recommend operators run `docker image
// tag cool-tunnel-server-singbox:latest cool-tunnel-server-
// singbox:v0.1.20-rollback` BEFORE running ./ct update if they
// expect to downgrade. (Auto-tagging the rollback target is a
// v0.2.1+ feature; cost-benefit doesn't yet justify the diff.)
async function stopLegacyV01Containers(): Promise<void> {
    step("v0.2.0 migration — stop v0.1.x sing-box + haproxy containers (if present)");
    let stopped = 0;
    for (const name of ["ct-singbox", "ct-haproxy"]) {
        const ps = await capture($`docker ps -aq --filter ${`name=^${name}$`}`);
        if (!ps.ok || !ps.stdout.trim()) {
            continue;
        }
        const id = ps.stdout.trim();
        // `docker compose down` won't touch these — they're no longer
        // listed in the v0.2.0 compose. Stop + rm directly. -t 15
        // gives sing-box / haproxy 15s to drain in-flight conns
        // before SIGKILL; matches their compose-default stop_grace_period.
        await capture($`docker stop -t 15 ${id}`);
        await capture($`docker rm -f ${id}`);
        ok(`stopped + removed legacy container ${name} (${id.slice(0, 12)})`);
        stopped++;
    }
    if (stopped === 0) {
        ok("no legacy v0.1.x containers present (fresh v0.2.0 deploy or already migrated)");
    }
}

async function panelEntrypointDone(): Promise<boolean> {
    const r = await capture(
        $`docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete`,
    );
    return r.ok;
}

async function bringNewImagesUp(): Promise<void> {
    step("Bring new panel + caddy images up (entrypoint runs migrate + render)");
    // v0.2.0+: caddy + panel only. sing-box + haproxy are no longer in
    // compose. The panel container's entrypoint shells out to
    // ct-server-core caddyfile render on startup, so by the time
    // bringNewImagesUp returns, /etc/caddy/Caddyfile is on disk and
    // caddy is reading from it.
    const r = await capture($`docker compose up -d panel caddy`);
    if (!r.ok) {
        dieWithDiag(
            "compose up -d panel caddy failed",
            r.stderr.split("\n").slice(0, 5).join("\n") || "check `docker compose ps`",
        );
    }
    if (
        !(await waitFor({
            label: "panel entrypoint sentinel",
            maxAttempts: 18, // 90s window matches the bash original
            intervalMs: 5000,
            probe: panelEntrypointDone,
        }))
    ) {
        dieWithDiag(
            "panel entrypoint did not finish within 90s",
            "docker compose logs --tail=120 panel",
        );
    }
}

async function migrateDb(): Promise<void> {
    step("Verify migrations applied (idempotent re-run)");
    const r = await capture(
        $`docker compose exec -T panel php artisan migrate --force --no-interaction`,
    );
    if (!r.ok) {
        dieWithDiag(
            "php artisan migrate failed",
            r.stderr.split("\n").slice(0, 5).join("\n") || "check ct-db + panel logs",
        );
    }
}

async function renderCaddyfile(): Promise<void> {
    step("Re-render Caddyfile");
    // v0.2.0+: a single render covers the role formerly split across
    // singbox render + haproxy render. The renderer pulls
    // ProxyAccount rows + ServerConfig and emits the consolidated
    // Caddyfile (panel reverse_proxy + forward_proxy basic_auth +
    // probe_resistance). See core/ct-server-core/src/caddy/mod.rs.
    const r = await capture(
        $`docker compose exec -T panel ct-server-core --json caddyfile render`,
    );
    if (!r.ok) {
        dieWithDiag("ct-server-core caddyfile render failed", r.stderr.split("\n")[0] ?? "");
    }
}

async function reloadCaddy(): Promise<void> {
    step("Reload Caddy (graceful — drains in-flight connections)");
    // v0.2.0+ replacement for the v0.1.x reloadSingBox + reloadHaproxy
    // chain. Caddy's reload is graceful + zero-downtime — in-flight
    // forward_proxy connections drain naturally as the new config
    // picks up new ones. Implementation: `docker exec ct-caddy caddy
    // reload --config /etc/caddy/Caddyfile`. Caddy validates the
    // new config BEFORE swapping; a parse error leaves the running
    // config in place (fail-closed; matches singbox::reload's posture).
    const r = await capture(
        $`docker compose exec -T panel ct-server-core caddyfile reload`,
    );
    if (!r.ok) {
        dieWithDiag(
            "ct-server-core caddyfile reload failed",
            r.stderr.split("\n")[0] ??
                "check `docker compose logs --tail=40 caddy` and that ct-caddy is running",
        );
    }
}

async function fetchOperatorBinary(): Promise<void> {
    step("Operator binary");
    const r = await capture($`./scripts/fetch_operator_binary.sh`);
    if (!r.ok) {
        process.stdout.write(
            `  ${ANSI.yellow}!${ANSI.reset} operator binary fetch did not complete; .sh fallbacks remain in use.\n`,
        );
        process.stdout.write(`     retry later with:  make operator-fetch\n`);
        return;
    }
    if (r.stdout) process.stdout.write(r.stdout);
}

export async function runUpdate(): Promise<number> {
    ensureRepoRoot(import.meta.url);

    if (!(await Bun.file(".env").exists())) {
        die("required file '.env' is missing", "cp .env.example .env  &&  $EDITOR .env");
    }
    if (!(await which("docker"))) {
        die("required command 'docker' is not on PATH", "Install per docs/installation-debian.md");
    }
    if (!process.env[LOCK_HELD_MARKER]) {
        await acquireOpLock();
    }

    // ---------- Pre-flight ----------
    step("Pre-flight");
    const net = await checkNetwork();
    if (!net.ok) dieOnFailure(net.failure);
    else ok(net.summary ?? "network ok");

    const disk = await checkDiskSpace();
    if (!disk.ok) dieOnFailure(disk.failure);
    else ok(disk.summary ?? "disk ok");

    // v0.2.0: the live services are caddy + panel + db + redis.
    // sing-box and haproxy may still be running on a pre-v0.2.0
    // deploy — those are not a failure case here, they're picked up
    // and stopped by stopLegacyV01Containers() below after git pull
    // brings in the v0.2.0 compose.
    const stack = await checkStackUp(["panel", "caddy"]);
    if (!stack.ok) dieOnFailure(stack.failure);
    else if (stack.missing.length > 0) warn(stack.summary);
    else ok(stack.summary);

    // v0.1.14: IPv6 broken-routing auto-disable. The v0.1.9 install.sh
    // and bootstrap.sh both run this check on first install, but
    // update.sh / update.ts did not — so a Vultr/RackNerd box whose
    // docker daemon.json got re-enabled for IPv6 (kernel update,
    // provider reboot, manual /etc/docker mucking) would hit the
    // exact "static.rust-lang.org Network unreachable" wall on the
    // next Rust rebuild, with no auto-recovery. checkIpv6Routing()
    // mirrors the install-time logic: detect missing IPv6 route +
    // missing sysctl override, write the sysctl + daemon.json, then
    // restart docker. Skippable via CT_SKIP_IPV6_AUTO_DISABLE=1.
    const ipv6 = await checkIpv6Routing();
    if (ipv6.action === "warn") warn(ipv6.detail);
    else ok(ipv6.detail);

    await preflightCleanTree();

    await gitPullFfOnly();
    await autoMigrateEnv();
    // v0.2.0 migration step: stop v0.1.x sing-box + haproxy
    // containers if they're still running. Idempotent — no-op on a
    // fresh v0.2.0 deploy. MUST run after gitPullFfOnly (so the
    // new compose is on disk) and BEFORE rebuildImages (so the new
    // caddy image build doesn't race the old caddy's :443 with
    // haproxy's stale :443 binding).
    await stopLegacyV01Containers();
    await rebuildCore();
    await rebuildImages();
    await bringNewImagesUp();
    await migrateDb();
    await renderCaddyfile();
    await reloadCaddy();

    step("Component check (post-swap)");
    const cc = await runComponentCheckStrict();
    if (cc.raw) process.stdout.write(cc.raw);
    if (!cc.ok) dieOnFailure(cc.failure);
    ok("all components OK");

    // v0.1.5: non-fatal operator-binary fetch.
    await fetchOperatorBinary();

    ok("Update complete.");
    ok("If something looks off, the safe first move is:  ct fix");
    return 0;
}

if (import.meta.main) {
    const code = await runUpdate();
    process.exit(code);
}
