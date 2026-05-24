#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/update.ts — `ct update` implementation.
//
// Pulls a new release, loads the release's prebuilt Docker image
// bundle, runs migrations + Caddy reload, then runs health gates. The
// production VPS path does not compile or build runtime images locally.
//
// Stages:
//   1. acquireOpLock (per-project flock)
//   2. preflight: network, disk space, low-space cleanup, stack-up,
//      auto-stash local edits
//   3. git pull --ff-only
//   4. .env auto-migrate (PANEL_DOMAIN + APP_URL)
//   5. load prebuilt Docker image bundle
//   6. compose up -d panel
//   7. wait for panel entrypoint sentinel
//   8. clear stale non-running ct-caddy, then compose up -d caddy singbox
//   9. admin SQLite migrations are handled by panel entrypoint
//  10. ct admin bootstrap remains explicit; no default password
//  11. render Caddyfile
//  12. caddy reload from the host-side operator
//  13. post-deploy settle gate
//  14. fetch_operator_binary.sh (non-fatal)

import { $, capture, runStreaming, which } from "./src/util/sh";
import { die, makeArrowProgress, makeTerm, ANSI } from "./src/util/term";
import { dieWithDiag, type DiagFailure } from "./src/util/diag";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { waitFor } from "./src/util/wait";
import { checkNetwork, checkStackUp, checkIpv4OnlyRouting } from "./src/util/preflight";
import { ensureRepoRoot } from "./src/util/repo-root";
import { migrateEnv } from "./src/util/env-migrate";
import { generateAdminAuthSecret } from "./src/util/bootstrap-admin";
import { formatAutoTempCleanSummary, runAutoTempClean } from "./src/util/disk-cleanup";
import {
    deploymentSettleRecoveryHint,
    settleDeployment,
} from "./src/util/deploy-settle";

const { step, ok, warn } = makeTerm();
const UPDATE_PROGRESS_STEPS = 12;
const progress = makeArrowProgress({ total: UPDATE_PROGRESS_STEPS });
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

    warn("auto-stashing local edits before update (no prompt)");
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
  git merge --abort  (or rebase --abort, etc.)

After fixing git state, retry:
  ./ct update`,
    );
}

async function resetToOriginMainAfterPullFailure(stderr: string): Promise<void> {
    warn("git pull --ff-only refused; creating backup branch and resetting to origin/main");
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/\..*/, "").replace("T", "T");
    const short = (await capture($`git rev-parse --short HEAD`)).stdout.trim() || "unknown";
    const backup = `ct-backup/pre-update-${stamp}Z-${short}`;
    const branch = await capture($`git branch ${backup} HEAD`);
    if (!branch.ok) {
        dieWithDiag(
            "could not create backup branch before reset",
            `${branch.stderr.split("\n")[0] ?? ""}

Original git pull error:
${stderr || "(no stderr)"}`,
        );
    }
    const fetch = await capture($`git fetch --quiet origin main`);
    if (!fetch.ok) {
        dieWithDiag("git fetch origin main failed", fetch.stderr.split("\n")[0] ?? "");
    }
    const reset = await capture($`git reset --hard origin/main`);
    if (!reset.ok) {
        dieWithDiag(
            "git reset --hard origin/main failed",
            `${reset.stderr.split("\n")[0] ?? ""}

Your previous HEAD is preserved at:
  ${backup}`,
        );
    }
    ok(`reset to origin/main; previous HEAD saved as ${backup}`);
}

async function gitPullFfOnly(): Promise<void> {
    phase("git pull (fast-forward only)");
    const r = await capture($`git pull --ff-only`);
    if (!r.ok) {
        await resetToOriginMainAfterPullFailure(r.stderr);
        return;
    }
    if (r.stdout) process.stdout.write(r.stdout);
}

async function autoMigrateEnv(): Promise<void> {
    phase("Auto-migrate legacy .env (PANEL_DOMAIN canonical placement + APP_URL hostname)");
    const f = Bun.file(".env");
    if (!(await f.exists())) die("required file '.env' is missing", "cp .env.example .env  &&  $EDITOR .env");
    const before = await f.text();
    const r = migrateEnv(before, generateAdminAuthSecret);
    if (r.warning) warn(r.warning);
    if (r.changes.length === 0) {
        ok("PANEL_DOMAIN already present in .env");
        ok("APP_URL already canonical");
        return;
    }
    await Bun.write(".env", r.content);
    for (const c of r.changes) ok(c.summary);
}

async function prepareImageBundle(): Promise<void> {
    const msg = "Prepare prebuilt Docker image bundle";
    phase(msg);
    const bundle = await withProgressPulse(msg, () => runStreaming($`./scripts/fetch_image_bundle.sh`));
    if (bundle.ok) {
        ok("prebuilt Docker image bundle loaded");
        return;
    }
    dieWithDiag(
        "prebuilt Docker image bundle is required",
        `This VPS install/update path does not compile Docker images locally.

Recovery:
  ./scripts/fetch_image_bundle.sh
  ./ct update

Maintainer recovery:
  build and upload cool-tunnel-server-images-linux-x64.tar.gz and
  cool-tunnel-server-images-linux-arm64.tar.gz for this release.`,
    );
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
    const panel = await capture($`docker compose up -d --no-build --pull never --remove-orphans panel`);
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
    const r = await capture($`docker compose up -d --no-build --pull never caddy singbox`);
    if (!r.ok) {
        dieWithDiag(
            "compose up -d caddy singbox failed",
            r.stderr.split("\n").slice(0, 5).join("\n") || "check `docker compose ps`",
        );
    }
}

async function migrateDb(): Promise<void> {
    phase("Verify admin migrations applied (idempotent re-run)");
    const r = await capture(
        $`docker compose exec -T panel bun run /opt/cool-tunnel/operator/src/index.ts admin migrate`,
    );
    if (!r.ok) {
        dieWithDiag(
            "admin migration failed",
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
        $`docker compose exec -T panel bun run /opt/cool-tunnel/operator/src/index.ts render caddyfile`,
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
    const settled = await settleDeployment({
        services: ["panel", "caddy", "singbox", "db", "redis"],
        log: (message) => warn(message),
    });
    if (!settled.services.ok) {
        dieWithDiag(
            "containers did not become healthy after update",
            deploymentSettleRecoveryHint(settled),
        );
    }
    ok("containers healthy");
    if (!settled.credentialLock?.ok) {
        dieWithDiag("credential-lock guard failed after update", deploymentSettleRecoveryHint(settled));
    }
    ok("credential-lock OK");
}

async function fetchOperatorBinary(): Promise<void> {
    phase("Operator binary");
    const r = await capture($`./scripts/fetch_operator_binary.sh`);
    if (!r.ok) {
        process.stdout.write(
            `  ${ANSI.yellow}!${ANSI.reset} operator binary fetch did not complete; retry before the next ct command if needed.\n`,
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

    // Enforce IPv4-only before fetching the release image bundle so
    // low-end VPSes do not drift into broken provider IPv6 routes.
    // Skip via CT_SKIP_IPV6_AUTO_DISABLE=1.
    const ipv4Only = await checkIpv4OnlyRouting();
    if (ipv4Only.action === "warn") warn(ipv4Only.detail);
    else ok(ipv4Only.detail);

    await preflightCleanTree();

    await gitPullFfOnly();
    await autoMigrateEnv();
    await prepareImageBundle();
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
