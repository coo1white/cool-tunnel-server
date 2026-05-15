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

import { $, capture, which } from "./src/util/sh";
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
    const r = await capture($`docker compose --profile build-only build core-builder`);
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
    step("Rebuild sing-box + panel + haproxy");
    const r = await capture($`docker compose build sing-box panel haproxy`);
    if (!r.ok) {
        dieWithDiag(
            "sing-box / panel / haproxy build failed",
            `Common causes (in priority order):
  - Out of disk             ->  df -h /var/lib/docker
                                then docker system prune -af
  - APK / PECL transient    ->  retry: ./ct update
  - Composer.lock conflict  ->  this was the v0.0.95 class
                                of bug -- check the entrypoint
                                output for "platform-req" errors

The build prints which Dockerfile step failed; that pinpoints
which image (sing-box / panel / haproxy) and which line.`,
        );
    }
}

async function fixHaproxyAdminVolume(): Promise<void> {
    step("Ensure haproxy_admin volume ownership (one-time fix for pre-v0.0.51 deploys)");
    const ls = await capture($`docker volume ls --format ${"{{.Name}}"}`);
    const vol = ls.ok
        ? ls.stdout.split("\n").find((l) => /_haproxy_admin$/.test(l.trim()))
        : null;
    if (!vol) {
        ok("haproxy_admin volume not yet created (fresh deploy)");
        return;
    }
    const r = await capture(
        $`docker run --rm --user root --entrypoint chown -v ${`${vol.trim()}:/v`} haproxy:3.0.21-alpine -R haproxy:haproxy /v`,
    );
    if (r.ok) ok("haproxy_admin ownership verified");
    else ok("haproxy_admin chown skipped (volume may be empty or already correct)");
}

async function panelEntrypointDone(): Promise<boolean> {
    const r = await capture(
        $`docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete`,
    );
    return r.ok;
}

async function bringNewImagesUp(): Promise<void> {
    step("Bring new panel image up (entrypoint runs migrate + render)");
    const r = await capture($`docker compose up -d panel sing-box haproxy`);
    if (!r.ok) {
        dieWithDiag(
            "compose up -d panel sing-box haproxy failed",
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

async function renderSingBox(): Promise<void> {
    step("Re-render sing-box config");
    const r = await capture(
        $`docker compose exec -T panel ct-server-core --json singbox render`,
    );
    if (!r.ok) {
        dieWithDiag("ct-server-core singbox render failed", r.stderr.split("\n")[0] ?? "");
    }
}

async function assertCredentialLock(): Promise<void> {
    step("Assert credential lock (db = rendered = manifest = Mac config)");
    const r = await capture(
        $`docker compose exec -T panel ct-server-core guard credential-lock`,
    );
    if (!r.ok) {
        dieWithDiag(
            "credential-lock guard reports NG",
            "run: ct fix    (recipe credential_drift will re-render + restart sing-box)",
        );
    }
}

async function reloadSingBox(): Promise<void> {
    step("Reload sing-box and purge stale runtime state");
    await capture($`docker compose exec -T panel ct-server-core server reload`);
    await capture($`docker compose restart sing-box`);
}

async function renderHaproxy(): Promise<void> {
    step("Re-render haproxy config (v0.0.51)");
    const r = await capture($`docker compose exec -T panel ct-server-core haproxy render`);
    if (!r.ok) {
        dieWithDiag("ct-server-core haproxy render failed", r.stderr.split("\n")[0] ?? "");
    }
}

async function reloadHaproxy(): Promise<void> {
    step("Reload haproxy (SIGHUP — graceful re-exec)");
    await capture($`docker compose kill -s HUP haproxy`);
    // v0.1.3 belt-and-suspenders: ensure haproxy is up after the
    // SIGHUP-induced re-exec (sometimes exits rather than reloads).
    await capture($`docker compose up -d haproxy`);
    await new Promise((r) => setTimeout(r, 2000));
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

    const stack = await checkStackUp(["panel", "sing-box", "haproxy"]);
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
    await rebuildCore();
    await rebuildImages();
    await fixHaproxyAdminVolume();
    await bringNewImagesUp();
    await migrateDb();
    await renderSingBox();
    await assertCredentialLock();
    await reloadSingBox();
    await renderHaproxy();
    await reloadHaproxy();

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
