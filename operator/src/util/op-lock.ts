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

export async function acquireOpLock(opts?: {
    // Override the project name (defaults to `composeProjectName()`).
    // Tests pin this to avoid spawning docker.
    readonly project?: string;
}): Promise<never> {
    const project = opts?.project ?? (await composeProjectName());
    const lockPath = `/tmp/cool-tunnel-ops-${project}.lock`;
    if (!Bun.which("flock")) {
        die("required command 'flock' is not on PATH", "apt install -y util-linux");
    }
    const result = spawnSync(
        "flock",
        ["-n", lockPath, process.execPath, ...process.argv.slice(1)],
        { stdio: "inherit", env: { ...process.env, [LOCK_HELD_MARKER]: "1" } },
    );
    // flock exits 1 on EWOULDBLOCK. The bash original `die`s with
    // an "already running" message in that case; pass through.
    if (result.status === 1 && result.signal == null) {
        die(
            `another cool-tunnel operator script is already running for project '${project}'`,
            `lockfile: ${lockPath}  (try: lsof '${lockPath}' to see who holds it)`,
        );
    }
    process.exit(result.status ?? 1);
}
