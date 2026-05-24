#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/auto-update.ts — unattended release-pulling agent (cron-safe).
//
// Unattended cool-tunnel-server release-pulling agent. Fetches the latest
// release tag, compares it to the deployed version, and if the
// stack is healthy + behind runs `./ct update` to bring it
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
import { acquireOpLock } from "./src/util/op-lock";
import { ensureRepoRoot } from "./src/util/repo-root";
import { credentialLockCheck } from "./src/util/credential-control";
import { redactSensitive } from "./src/util/redact";

// Distinct marker so the inner `./ct update` subprocess (which
// acquires its own per-project ops flock under the default
// CT_OPS_FLOCK_HELD marker) doesn't see our auto-update flock as
// already-held when it re-execs under flock.
const AUTO_UPDATE_MARKER = "CT_AUTOUPDATE_FLOCK_HELD";

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
        else if (a === "--json") continue;
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

function firstNonEmptyLine(text: string): string {
    return redactSensitive(text).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

export function gitPullFailureHint(stderr: string, stdout = ""): readonly string[] {
    const combined = `${stderr}\n${stdout}`.toLowerCase();
    const firstLine = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
    const detail = firstLine ? `git said: ${firstLine}` : "git exited without a diagnostic line";

    if (combined.includes("would be overwritten by merge") || combined.includes("local changes")) {
        return [
            "git pull --ff-only failed — the checkout has local changes",
            detail,
            "left at the prior release; run 'git status --short' and either keep, commit, or remove the local edits, then run 'ct update'",
        ];
    }
    if (combined.includes("not possible to fast-forward") || combined.includes("divergent branches")) {
        return [
            "git pull --ff-only failed — the VPS checkout diverged from origin/main",
            detail,
            "left at the prior release; run 'git status' and reconcile the branch, or reinstall from a clean checkout if this VPS has no intentional local commits",
        ];
    }
    if (combined.includes("could not resolve host") || combined.includes("failed to connect") || combined.includes("network is unreachable")) {
        return [
            "git pull --ff-only failed — GitHub was not reachable from this VPS",
            detail,
            "left at the prior release; check DNS/network with 'curl -I https://github.com' and rerun 'ct auto-update --dry-run'",
        ];
    }
    if (combined.includes("repository not found") || combined.includes("authentication failed") || combined.includes("permission denied")) {
        return [
            "git pull --ff-only failed — origin/main could not be fetched",
            detail,
            "left at the prior release; check 'git remote -v' and repository access, then rerun 'ct update'",
        ];
    }
    return [
        "git pull --ff-only failed — release code was not updated",
        detail,
        "left at the prior release; run 'git status' and 'git pull --ff-only origin main' interactively for the full git output",
    ];
}

export function ctUpdateFailureHint(code: number, stderr: string, stdout = ""): readonly string[] {
    const combined = `${stderr}\n${stdout}`;
    const lower = combined.toLowerCase();
    const firstLine = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
    const detail = firstLine ? `ct update said: ${firstLine}` : `ct update exited ${code} without a diagnostic line`;

    if (lower.includes("unsupported cipher or incorrect key length")) {
        return [
            "ct update failed — panel APP_KEY is malformed",
            detail,
            "fix /opt/cool-tunnel-server/.env so APP_KEY is exactly a Laravel key such as base64:<44 chars>, then run 'ct recover diagnose'",
        ];
    }
    if (lower.includes("could not decrypt the data")) {
        return [
            "ct update failed — encrypted panel data cannot be decrypted with the current APP_KEY",
            detail,
            "if this happened after changing APP_KEY, restore the old key or set APP_PREVIOUS_KEYS; for Reality key drift run 'ct recover reset-reality'",
        ];
    }
    if (lower.includes("credential-lock")) {
        return [
            "ct update failed — credential-lock guard blocked the deploy",
            detail,
            "run 'ct recover diagnose' to see the failing config fields and exact repair command",
        ];
    }
    if (lower.includes("no space left on device")) {
        return [
            "ct update failed — the VPS ran out of disk space",
            detail,
            "run 'df -h' and 'docker system df', free space, then rerun 'ct update'",
        ];
    }
    if (lower.includes("port is already allocated") || lower.includes("bind: address already in use")) {
        return [
            "ct update failed — a required port is already in use",
            detail,
            "run 'docker compose ps' and 'ss -ltnp | grep -E \":(80|443)\"' before rerunning 'ct update'",
        ];
    }
    return [
        "ct update failed — stack may be in a partial state",
        detail,
        "run 'ct recover diagnose' first; then rerun 'ct update' interactively if the diagnostics are PASS",
    ];
}

async function preflightStackHealthy(): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Panel container running?
    const ps = await capture($`docker compose ps --status running --services`);
    if (!ps.ok || !ps.stdout.split("\n").map((s) => s.trim()).includes("panel")) {
        return {
            ok: false,
            reason: "stack pre-flight: panel container is not running\nrefusing to auto-upgrade an unhealthy stack — run 'ct doctor' first",
        };
    }
    // Credential-lock guard OK?
    const guard = await credentialLockCheck();
    if (!guard.ok) {
        return {
            ok: false,
            reason: "stack pre-flight: credential-lock guard reports NG\nrefusing to auto-upgrade — run 'docker compose exec -T panel php artisan credential-lock:check'",
        };
    }
    return { ok: true };
}

export async function runAutoUpdate(opts: AutoUpdateOptions): Promise<number> {
    ensureRepoRoot(import.meta.url);

    // Single-flight: per-machine lock distinct from the ops-mutex.
    // A scheduled auto-update tick that collides with another tick
    // is a no-op (soft skip; exit 0 so cron logs stay clean).
    if (!process.env[AUTO_UPDATE_MARKER]) {
        await acquireOpLock({
            lockPath: pickLockPath(),
            markerName: AUTO_UPDATE_MARKER,
            busyMessage:
                "another auto-update is already running — skipping this tick",
            softSkip: true,
        });
    }

    // Auto-update failures need their own error path.
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
        log.say("(dry-run) would now: git pull --ff-only && ./ct update");
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
        for (const line of gitPullFailureHint(pull.stderr, pull.stdout)) log.err(line);
        return 1;
    }
    if (!opts.quiet) {
        for (const line of pull.stdout.split("\n")) {
            if (line) process.stdout.write(`    ${redactSensitive(line)}\n`);
        }
    }

    // Delegate the actual deploy to `./ct update` so we ride the
    // dispatch_via_operator path — operator binary when present
    // (canonical Bun runUpdate), bash ct update otherwise.
    // The subprocess gets its own ops flock; AUTO_UPDATE_MARKER
    // is distinct from CT_OPS_FLOCK_HELD so the child re-execs
    // under its own lock without thinking ours is "already held".
    const update = opts.quiet
        ? await capture($`./ct update`.quiet())
        : await capture($`./ct update`);
    if (!update.ok) {
        for (const line of ctUpdateFailureHint(update.code, update.stderr, update.stdout)) log.err(line);
        return 1;
    }
    if (!opts.quiet) {
        for (const line of update.stdout.split("\n")) {
            if (line) process.stdout.write(`    ${redactSensitive(line)}\n`);
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
