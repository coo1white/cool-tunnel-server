// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/op-lock.ts — per-project operator mutex.
//
// Mirrors scripts/lib.sh::acquire_op_lock. Used by backup, restore,
// install, update — any cool-tunnel operator script that mutates
// deployment state needs this so two operators (or one operator and
// a cron job) can't race.
//
// Implementation: re-exec self under `flock -n <path>`. The kernel
// releases on process exit (including SIGKILL); no manual cleanup
// needed. Per-project lockfile means parallel deployments on the
// same host (`/opt/ct-prod`, `/opt/ct-staging`) don't serialise
// against each other.

import { spawnSync } from "node:child_process";
import { composeProjectName } from "./compose";
import { die } from "./term";

// Re-exec the current process under `flock -n` and exit when the
// child completes. Skip when the held-marker env var is already
// set (we're inside the locked child).
//
// Callers do:
//   if (!process.env[LOCK_HELD_MARKER]) await acquireOpLock();
//   // ... lock-protected work ...
export const LOCK_HELD_MARKER = "CT_OPS_FLOCK_HELD";

export interface AcquireOpts {
    // Override the project name (defaults to `composeProjectName()`).
    // Tests pin this to avoid spawning docker.
    readonly project?: string;
    // Override the lock path (defaults to
    // `/tmp/cool-tunnel-ops-${project}.lock`). Auto-update uses a
    // dedicated path so a scheduled run doesn't block on a backup /
    // install / restore — and vice versa.
    readonly lockPath?: string;
    // Override the "already held" die message. Useful when the
    // caller wants a context-specific hint (e.g. "another
    // auto-update is already running — skipping this tick").
    readonly busyMessage?: string;
    readonly busyHint?: string;
    // If the lock is busy and `softSkip` is true, exit 0 instead of
    // calling die(). Used by cron-triggered auto-update so missing
    // the lock isn't logged as an error.
    readonly softSkip?: boolean;
    // Override the held-marker env var name. Distinct markers let
    // a process hold multiple locks at once without the inner
    // acquireOpLock collapsing into the outer one's marker (the
    // auto-update agent calls runUpdate() in-process and each
    // wants its own lock).
    readonly markerName?: string;
}

export async function acquireOpLock(opts: AcquireOpts = {}): Promise<never> {
    const project = opts.project ?? (await composeProjectName());
    const lockPath = opts.lockPath ?? `/tmp/cool-tunnel-ops-${project}.lock`;
    const marker = opts.markerName ?? LOCK_HELD_MARKER;
    if (!Bun.which("flock")) {
        die("required command 'flock' is not on PATH", "apt install -y util-linux");
    }
    const result = spawnSync(
        "flock",
        ["-n", lockPath, process.execPath, ...process.argv.slice(1)],
        { stdio: "inherit", env: { ...process.env, [marker]: "1" } },
    );
    if (result.status === 1 && result.signal == null) {
        if (opts.softSkip) {
            process.stderr.write(
                (opts.busyMessage ??
                    `another cool-tunnel operator script is already running for project '${project}'`) +
                    "\n",
            );
            process.exit(0);
        }
        die(
            opts.busyMessage ??
                `another cool-tunnel operator script is already running for project '${project}'`,
            opts.busyHint ?? `lockfile: ${lockPath}  (try: lsof '${lockPath}' to see who holds it)`,
        );
    }
    process.exit(result.status ?? 1);
}
