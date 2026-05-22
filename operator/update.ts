#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/update.ts — `ct update` implementation.
//
// Pulls a new release, rebuilds images, runs migrations + Caddy
// reload, then runs health gates. On failure the OLD images are
// still running on their volumes (compose hasn't swapped traffic).
//
// Stages:
//   1. acquireOpLock (per-project flock)
//   2. preflight: network, disk space, low-space cleanup, stack-up, clean tree
//      (TTY: interactive stash/discard/abort; non-TTY: dies)
//   3. git pull --ff-only
//   4. .env auto-migrate (PANEL_DOMAIN + APP_URL)
//   5. prepare ct-server-core image (prebuilt release asset; source fallback)
//   6. prepare singbox-core image (prebuilt release asset)
//   7. compose build caddy singbox panel
//   8. compose up -d panel
//   9. wait for panel entrypoint sentinel
//  10. clear stale non-running ct-caddy, then compose up -d caddy singbox
//  11. php artisan migrate --force
//  12. ct-server-core caddyfile render
//  13. caddy reload from the host-side operator
//  14. post-deploy settle gate
//  15. fetch_operator_binary.sh (non-fatal)

import { $, capture, runStreaming, which } from "./src/util/sh";
import { die, makeArrowProgress, makeTerm, ANSI } from "./src/util/term";
import { dieWithDiag, type DiagFailure } from "./src/util/diag";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { waitFor } from "./src/util/wait";
import { checkNetwork, checkStackUp, checkIpv4OnlyRouting } from "./src/util/preflight";
import { ensureRepoRoot } from "./src/util/repo-root";
import { migrateEnv } from "./src/util/env-migrate";
import { promptChoice, promptYn } from "./src/util/prompt";
import { formatAutoTempCleanSummary, runAutoTempClean } from "./src/util/disk-cleanup";
import {
    credentialLockRecoveryHint,
    settleCredentialLock,
    waitForServicesReady,
} from "./src/util/deploy-settle";

const { step, ok, warn } = makeTerm();
const progress = makeArrowProgress({ total: 13 });
let progressFinished = false;

process.on("exit", (code) => {
    if (code !== 0 && !progressFinished) {
        progress.fail("failed");
        progressFinished = true;
    }
});

function phase(msg: string): void {
    progress.advance(msg);
    step(msg);
}

async function withProgressPulse<T>(msg: string, work: () => Promise<T>): Promise<T> {
    progress.pulse(msg);
    const timer = setInterval(() => progress.pulse(msg), 1000);
    try {
        return await work();
    } finally {
        clearInterval(timer);
        progress.pulse(msg);
    }
}

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
    phase("git pull (fast-forward only)");
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
    phase("Auto-migrate legacy .env (PANEL_DOMAIN canonical placement + APP_URL hostname)");
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
    const msg = "Prepare ct-server-core image";
    phase(msg);
    const prebuilt = await withProgressPulse(msg, () => runStreaming($`./scripts/fetch_core_binary.sh`));
    if (prebuilt.ok) {
        ok("ct-server-core prebuilt release image ready");
        return;
    }
    if (prebuilt.code !== 2) {
        dieWithDiag(
            "ct-server-core prebuilt fetch failed",
            `The release binary could not be downloaded, verified, or wrapped as a Docker image.

Recovery:
  ./scripts/fetch_core_binary.sh
  ./ct update

If you intentionally want to compile Rust on this VPS:
  CT_CORE_BUILD_FROM_SOURCE=1 ./ct update`,
        );
    }

    warn("prebuilt ct-server-core asset unavailable; falling back to local Rust build");
    warn("on a 1-vCPU / 1 GB VPS this can take a long time and may need swap");
    const source = await withProgressPulse("Build ct-server-core from source", () =>
        runStreaming($`docker compose --profile build-only build core-builder`),
    );
    if (!source.ok) {
        dieWithDiag(
            "ct-server-core build failed",
            `Common causes (in priority order):
  - Release asset missing ->  ./scripts/fetch_core_binary.sh
  - Docker cache pressure ->  docker builder prune -af
  - Network route issue   ->  curl -4 -I https://static.rust-lang.org/
                              curl -4 -I https://index.crates.io/
  - Cargo cache rot       ->  rm -rf core/target  then retry
  - Buildkit bug          ->  docker buildx rm default-builder; retry

This release pins Rust to the exact rust:1.88.0-alpine image and
skips already-installed rustup targets. If the log still says
NetworkUnreachable, it is not an IPv6 drift bug; it means the VPS
cannot reach the Rust or crates.io endpoints over outbound IPv4.

Recovery:
  docker builder prune -af
  ./ct update

If the build error mentions a specific Rust crate, paste the last 20
lines of output when asking for help. The crate name + line number
are usually enough to diagnose.`,
        );
    }
}

async function prepareSingboxCore(): Promise<void> {
    const msg = "Prepare singbox-core image";
    phase(msg);
    const prebuilt = await withProgressPulse(msg, () => runStreaming($`./scripts/fetch_singbox_core_binary.sh`));
    if (prebuilt.ok) {
        ok("singbox-core prebuilt release image ready");
        return;
    }
    if (prebuilt.code !== 2) {
        dieWithDiag(
            "singbox-core prebuilt fetch failed",
            `The release binary could not be downloaded, verified, or wrapped as a Docker image.

Recovery:
  ./scripts/fetch_singbox_core_binary.sh
  ./ct update

If this is a just-published release, wait for the release assets to finish,
then retry the same command.`,
        );
    }

    dieWithDiag(
        "singbox-core release asset unavailable",
        `This release is missing the prebuilt ${"singbox-core"} binary for this VPS.

Recovery:
  ./scripts/fetch_singbox_core_binary.sh
  ./ct update

Maintainer recovery:
  build and upload singbox-core-linux-x64 / singbox-core-linux-arm64,
  then re-run ./ct update.`,
    );
}

async function rebuildImages(): Promise<void> {
    const msg = "Rebuild caddy + singbox + panel images";
    phase(msg);
    // v0.4.0: caddy (layer4 SNI splitter via mholt/caddy-l4) +
    // singbox (sing-box VLESS+Reality, supervisored by singbox-core)
    // + panel.
    const r = await withProgressPulse(msg, () =>
        runStreaming($`docker compose build caddy singbox panel`),
    );
    if (!r.ok) {
        dieWithDiag(
            "caddy / singbox / panel build failed",
            `Common causes (in priority order):
  - Out of disk             ->  df -h /var/lib/docker
                                then docker system prune -af
  - xcaddy / Go transient   ->  retry: ./ct update
                                (Caddy is built with the
                                mholt/caddy-l4 plugin via xcaddy;
                                first build pulls a Go dep graph
                                from proxy.golang.org.)
  - singbox-core asset gap    ->  ./scripts/fetch_singbox_core_binary.sh
                                then retry: ./ct update
  - Composer.lock conflict  ->  check the entrypoint output for
                                "platform-req" errors

The build prints which Dockerfile step failed; that pinpoints
which image (caddy / singbox / panel) and which line.`,
        );
    }
}

async function panelEntrypointDone(): Promise<boolean> {
    const r = await capture(
        $`docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete`,
    );
    return r.ok;
}

export function shouldRemoveStaleCaddy(state: string): boolean {
    return state === "created" || state === "exited" || state === "dead";
}

export function caddyReloadCommand(): string[] {
    return [
        "docker",
        "compose",
        "exec",
        "-T",
        "caddy",
        "caddy",
        "reload",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
    ];
}

async function removeStaleCaddy(): Promise<void> {
    const state = (await capture($`docker inspect -f {{.State.Status}} ct-caddy`)).stdout.trim();
    if (shouldRemoveStaleCaddy(state)) {
        warn(`removing stale ct-caddy (state=${state}) from prior attempt`);
        const rm = await capture($`docker rm -f ct-caddy`);
        if (!rm.ok) {
            dieWithDiag(
                "failed to remove stale ct-caddy",
                rm.stderr.split("\n").slice(0, 5).join("\n") || "docker rm -f ct-caddy",
            );
        }
    }
}

async function bringNewImagesUp(): Promise<void> {
    phase("Bring new panel image up (entrypoint runs migrate + render)");
    // v0.4.0: panel's entrypoint shells out to
    // `ct-server-core caddyfile render` AND `singbox-core
    // render-server` on startup (via SingBoxConfigGenerator).
    // Start panel first and wait for the sentinel before the
    // public-facing services start; otherwise caddy can boot
    // against an absent /etc/caddy/Caddyfile and compose aborts
    // with ct-caddy left in Created state.
    //
    // --remove-orphans cleans up containers from removed services
    // (e.g. ct-naive lingering from a v0.3.x box, ct-haproxy from
    // a v0.1.x box, or a future service we retire). Safer than
    // the default that would leave orphans mapping ports.
    const panel = await capture($`docker compose up -d --remove-orphans panel`);
    if (!panel.ok) {
        dieWithDiag(
            "compose up -d panel failed",
            panel.stderr.split("\n").slice(0, 5).join("\n") || "check `docker compose ps panel`",
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

    phase("Bring new caddy + singbox images up");
    await removeStaleCaddy();
    const r = await capture($`docker compose up -d caddy singbox`);
    if (!r.ok) {
        dieWithDiag(
            "compose up -d caddy singbox failed",
            r.stderr.split("\n").slice(0, 5).join("\n") || "check `docker compose ps`",
        );
    }
}

async function migrateDb(): Promise<void> {
    phase("Verify migrations applied (idempotent re-run)");
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
    phase("Re-render Caddyfile");
    // v0.4.0: Caddyfile is mostly-static (Domain / PanelDomain /
    // ACME email / ACME directory only); per-account credentials
    // live in singbox.json (rendered separately by the panel
    // entrypoint via singbox-core render-server). The Caddyfile
    // renderer is still wired so a domain/email change picks up
    // cleanly. See core/ct-server-core/src/caddy/mod.rs.
    const r = await capture(
        $`docker compose exec -T panel ct-server-core --json caddyfile render`,
    );
    if (!r.ok) {
        dieWithDiag("ct-server-core caddyfile render failed", r.stderr.split("\n")[0] ?? "");
    }
}

async function reloadCaddy(): Promise<void> {
    phase("Reload Caddy (graceful — drains in-flight connections)");
    // Run Caddy's reload from the operator/host side. Calling
    // `ct-server-core caddyfile reload` inside the panel container
    // tries to spawn `docker`, but the panel image intentionally
    // does not ship a Docker CLI; that surfaced on v0.4.5 VPS
    // updates as `io failed: No such file or directory (os error 2)`.
    // `docker compose exec caddy ...` keeps Docker access in the
    // operator process where it belongs while still using Caddy's
    // graceful config swap.
    const [bin, ...args] = caddyReloadCommand();
    const r = await capture($`${bin} ${args}`);
    if (!r.ok) {
        dieWithDiag(
            "caddy reload failed",
            r.stderr.split("\n")[0] ??
                "check `docker compose logs --tail=40 caddy` and that ct-caddy is running",
        );
    }
}

async function runPostUpdateHealthGates(): Promise<void> {
    phase("Post-update settle gate");
    const ready = await waitForServicesReady({
        services: ["panel", "caddy", "singbox", "db", "redis"],
        log: (message) => warn(message),
    });
    if (!ready) {
        dieWithDiag(
            "containers did not become healthy after update",
            "docker compose ps\ndocker compose logs --tail=80 caddy singbox panel",
        );
    }
    ok("containers healthy");

    const guard = await settleCredentialLock({
        log: (message) => warn(message),
    });
    if (!guard.ok) {
        dieWithDiag(
            "credential-lock guard failed after update",
            credentialLockRecoveryHint(guard.guard),
        );
    }
    ok("credential-lock OK");
}

async function fetchOperatorBinary(): Promise<void> {
    phase("Operator binary");
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
    try {
        return await runUpdateInner();
    } catch (err) {
        progressFinished = true;
        progress.fail(err instanceof Error ? err.message : "failed");
        throw err;
    }
}

async function runUpdateInner(): Promise<number> {
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
    phase("Pre-flight");
    const net = await checkNetwork();
    if (!net.ok) dieOnFailure(net.failure);
    else ok(net.summary ?? "network ok");

    const cleanup = await runAutoTempClean({ forceDockerCleanup: true });
    for (const s of cleanup.steps) {
        if (s.action === "failed") warn(`${s.label}: ${s.detail}`);
    }
    if (!cleanup.disk.ok) dieOnFailure(cleanup.disk.failure);
    else ok(formatAutoTempCleanSummary(cleanup));

    // v0.4.0: the live services are caddy + singbox + panel + db
    // + redis. Preflight only checks the public-facing pair
    // (panel + caddy); db/redis come up alongside, and singbox
    // depends on the panel-rendered singbox.json so it's allowed
    // to be transiently down here.
    const stack = await checkStackUp(["panel", "caddy"]);
    if (!stack.ok) dieOnFailure(stack.failure);
    else if (stack.missing.length > 0) warn(stack.summary);
    else ok(stack.summary);

    // Enforce IPv4-only before the Rust build so Docker/Rust never
    // drift into broken provider routes for static.rust-lang.org.
    // Skip via CT_SKIP_IPV6_AUTO_DISABLE=1.
    const ipv4Only = await checkIpv4OnlyRouting();
    if (ipv4Only.action === "warn") warn(ipv4Only.detail);
    else ok(ipv4Only.detail);

    await preflightCleanTree();

    await gitPullFfOnly();
    await autoMigrateEnv();
    await rebuildCore();
    await prepareSingboxCore();
    await rebuildImages();
    await bringNewImagesUp();
    await migrateDb();
    await renderCaddyfile();
    await reloadCaddy();
    // v0.4.0: singbox.json is rendered by the panel entrypoint
    // (SingBoxConfigGenerator → singbox-core render-server) when
    // bringNewImagesUp completes. The settle gate reconciles once
    // more after reload so transient healthcheck "starting" states
    // and stale singbox.json reads do not look like real failures.
    await runPostUpdateHealthGates();

    // Non-fatal operator-binary fetch (signed release from GitHub).
    await fetchOperatorBinary();

    progressFinished = true;
    progress.complete("Update complete");
    ok("Update complete.");
    ok("If something looks off, the safe first move is:  ct doctor");
    return 0;
}

if (import.meta.main) {
    const code = await runUpdate();
    process.exit(code);
}
