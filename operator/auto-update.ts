#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/auto-update.ts — pure-TS port of scripts/auto_update.sh.
//
// Unattended Cool Tunnel release-pulling agent. Fetches the latest
// release tag, compares it to the deployed version, and if the
// stack is healthy + behind runs `./scripts/update.sh` to bring it
// forward. Designed to be cron-safe.
//
// Differs from the standard ops lock: this script gets its own
// dedicated `/var/lock/cool-tunnel-auto-update.lock` so a backup,
// install, or interactive update doesn't block (or get blocked
// by) a scheduled auto-update tick.
//
// Flags:
//   --quiet | -q    cron-friendly: stdout suppressed, stderr only
//   --dry-run | -n  report what would happen, don't act
//
// Exit codes (matches the bash original):
//   0   up to date, OR upgraded successfully, OR skipped a tick
//       because another auto-update is already running
//   1   upgrade attempted and failed (operator needs to look)
//   2   refused to upgrade (stack already unhealthy, no network,
//       not a git checkout, etc.) — operator investigates first

import { accessSync, constants as fsConstants } from "node:fs";
import { $, capture } from "./src/util/sh";
import { probeVersions, upgradeAvailable, readCurrentVersion } from "./src/util/release";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";

export interface AutoUpdateOptions {
    readonly quiet: boolean;
    readonly dryRun: boolean;
}

export function parseAutoUpdateArgs(argv: readonly string[]): AutoUpdateOptions | string {
    let quiet = false;
    let dryRun = false;
    const cmdIdx = argv.indexOf("auto-update");
    const rest = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2);
    for (const a of rest) {
        if (a === "--quiet" || a === "-q") quiet = true;
        else if (a === "--dry-run" || a === "-n") dryRun = true;
        else if (a === "--json" || a === "--no-bridge") continue;
        else return `auto-update: unknown flag: ${a}`;
    }
    return { quiet, dryRun };
}

function stamp(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// /var/lock is preferred (matches the bash original) but falls back
// to /tmp on hosts where /var/lock isn't writable by the operator —
// e.g. a dev box running auto-update interactively without sudo.
function pickLockPath(): string {
    try {
        accessSync("/var/lock", fsConstants.W_OK);
        return "/var/lock/cool-tunnel-auto-update.lock";
    } catch {
        return "/tmp/cool-tunnel-auto-update.lock";
    }
}

function makeLog(quiet: boolean): { say: (m: string) => void; err: (m: string) => void } {
    return {
        say: (m) => {
            if (!quiet) process.stdout.write(`[${stamp()}] auto-update: ${m}\n`);
        },
        err: (m) => process.stderr.write(`[${stamp()}] auto-update: ✗ ${m}\n`),
    };
}

async function preflightStackHealthy(): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Panel container running?
    const ps = await capture($`docker compose ps --status running --services`);
    if (!ps.ok || !ps.stdout.split("\n").map((s) => s.trim()).includes("panel")) {
        return {
            ok: false,
            reason: "stack pre-flight: panel container is not running\nrefusing to auto-upgrade an unhealthy stack — run 'ct fix' first",
        };
    }
    // Credential-lock guard OK?
    const guard = await capture(
        $`docker compose exec -T panel ct-server-core guard credential-lock`,
    );
    if (!guard.ok) {
        return {
            ok: false,
            reason: "stack pre-flight: credential-lock guard reports NG\nrefusing to auto-upgrade — run 'ct fix' (recipe credential_drift)",
        };
    }
    return { ok: true };
}

export async function runAutoUpdate(opts: AutoUpdateOptions): Promise<number> {
    // Resolve cwd to repo root so relative paths resolve.
    const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    process.chdir(repoRoot);

    // Single-flight: per-machine lock distinct from the ops-mutex.
    // A scheduled auto-update tick that collides with another tick
    // is a no-op (soft skip; exit 0 so cron logs stay clean).
    if (!process.env[LOCK_HELD_MARKER]) {
        await acquireOpLock({
            lockPath: pickLockPath(),
            busyMessage:
                "another auto-update is already running — skipping this tick",
            softSkip: true,
        });
    }

    // Don't recursively suggest `ct fix` on our own die() calls —
    // auto-update failures need their own error path, not a chain
    // to the interactive agent.
    process.env["CT_NO_FIX_HINT"] = "1";

    const log = makeLog(opts.quiet);

    // ---------- 1. Probe versions ----------
    const v = await probeVersions();
    if (!v) {
        log.err("cannot read latest tag or current version");
        log.err("skipping this tick; will retry on next cron cycle");
        return 2;
    }
    const latestVersion = v.latest.replace(/^v/, "");

    if (!upgradeAvailable(v)) {
        log.say(`up to date (deployed=${v.current}, latest=${v.latest}) — nothing to do`);
        return 0;
    }

    log.say(`upgrade available: ${v.current} -> ${latestVersion} (tag ${v.latest})`);

    if (opts.dryRun) {
        log.say("(dry-run) would now: git pull --ff-only && ./scripts/update.sh");
        log.say("(dry-run) exit 0");
        return 0;
    }

    // ---------- 2. Pre-flight ----------
    const pf = await preflightStackHealthy();
    if (!pf.ok) {
        for (const line of pf.reason.split("\n")) log.err(line);
        return 2;
    }
    log.say("pre-flight OK (panel running, credential-lock OK) — proceeding");

    // ---------- 3. Pull + update ----------
    const pull = await capture($`git pull --ff-only origin main`);
    if (!pull.ok) {
        log.err("git pull --ff-only failed — working tree may have local changes");
        log.err("left at the prior release; investigate with 'git status'");
        return 1;
    }
    if (!opts.quiet) {
        for (const line of pull.stdout.split("\n")) {
            if (line) process.stdout.write(`    ${line}\n`);
        }
    }

    const update = opts.quiet
        ? await capture($`./scripts/update.sh`.quiet())
        : await capture($`./scripts/update.sh`);
    if (!update.ok) {
        log.err("./scripts/update.sh failed — stack may be in a partial state");
        log.err("re-run interactively: ct update   (or: ct fix to walk the recipes)");
        return 1;
    }
    if (!opts.quiet) {
        for (const line of update.stdout.split("\n")) {
            if (line) process.stdout.write(`    ${line}\n`);
        }
    }

    // ---------- 4. Post-update sanity ----------
    const newVersion = (await readCurrentVersion()) ?? "?";
    log.say(`upgraded: ${v.current} -> ${newVersion} — complete.`);
    return 0;
}

async function main(): Promise<number> {
    const parsed = parseAutoUpdateArgs(process.argv);
    if (typeof parsed === "string") {
        console.error(parsed);
        return 2;
    }
    return await runAutoUpdate(parsed);
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
