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
import { isBunFsUrl } from "./repo-root";

// Re-exec the current process under `flock -n` and exit when the
// child completes. Skip when the held-marker env var is already
// set (we're inside the locked child).
//
// Callers do:
//   if (!process.env[LOCK_HELD_MARKER]) await acquireOpLock();
//   // ... lock-protected work ...
export const LOCK_HELD_MARKER = "CT_OPS_FLOCK_HELD";

// Resolve the argv to re-pass to a flock-wrapped self-re-exec.
//
//   Dev (`bun run operator/update.ts update`):
//     argv = [<bun-path>, "operator/update.ts", "update"]
//     Re-exec needs ["operator/update.ts", "update"] — bun expects
//     the script path first.
//
//   Compiled binary (`./ct update`):
//     argv = [<binary-path>, "/$bunfs/root/<binary-name>", "update"]
//     argv[1] is Bun's SYNTHETIC virtual-fs path to the embedded
//     entry point; the binary's own dispatcher ignores it. Re-
//     execing with that string as the first arg made the dispatcher
//     in the lock-holding child interpret `/$bunfs/...` as a
//     subcommand → `error: unknown command: /$bunfs/...`.
//     Surfaced 2026-05-15 on the v0.1.15 Vultr deploy: `./ct
//     update` died inside acquireOpLock with that exact message
//     before any update work ran. Drop argv[1] in this mode.
//
// Exported for tests.
export function resolveReExecArgs(argv: readonly string[]): readonly string[] {
    const compiled = isBunFsUrl(argv[1] ?? "");
    return compiled ? argv.slice(2) : argv.slice(1);
}

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

// Distinguished exit code for "flock couldn't acquire the lock"
// (the `-E` flag). Pre-this-fix the parent checked
// `result.status === 1` for lock-busy, but flock's default
// behaviour is to PASS THROUGH the child's exit code on success
// AND exit 1 when -n's lock-acquire fails — making the two
// indistinguishable. Every child task that died via dieWithDiag()
// (which always exits 1) made the parent spuriously print
// "another cool-tunnel operator script is already running"
// AFTER the real failure diagnostic, confusing operators into
// thinking they had a parallel-invocation problem. Reported
// 2026-05-15 on the v0.1.18 Vultr update.
//
// 75 = EX_TEMPFAIL from sysexits.h — flock's own documentation
// uses it in examples for the "lock busy" case.
const LOCK_BUSY_EXIT_CODE = 75;

export async function acquireOpLock(opts: AcquireOpts = {}): Promise<never> {
    const project = opts.project ?? (await composeProjectName());
    const lockPath = opts.lockPath ?? `/tmp/cool-tunnel-ops-${project}.lock`;
    const marker = opts.markerName ?? LOCK_HELD_MARKER;
    if (!Bun.which("flock")) {
        die("required command 'flock' is not on PATH", "apt install -y util-linux");
    }
    const result = spawnSync(
        "flock",
        [
            "-n",
            "-E",
            String(LOCK_BUSY_EXIT_CODE),
            lockPath,
            process.execPath,
            ...resolveReExecArgs(process.argv),
        ],
        { stdio: "inherit", env: { ...process.env, [marker]: "1" } },
    );
    if (result.status === LOCK_BUSY_EXIT_CODE && result.signal == null) {
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
