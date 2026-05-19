// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/wait.ts — bounded polling helper.
//
// Mirrors scripts/lib.sh::wait_for. Repeatedly invokes a probe
// callback (returning true to succeed) up to `maxAttempts` times,
// sleeping `intervalMs` between checks. Used by restore / install /
// update wherever the script needs to wait for a docker container
// or volume to reach a particular state.

export interface WaitOptions {
    readonly label: string;
    readonly maxAttempts: number;
    readonly intervalMs: number;
    readonly probe: () => Promise<boolean>;
    // Optional progress heartbeat. Defaults to every 15 seconds.
    readonly progressEveryMs?: number;
    // Optional logger for the timeout case. Defaults to console.error.
    readonly onTimeout?: (label: string) => void;
}

export async function waitFor(opts: WaitOptions): Promise<boolean> {
    let lastProgressAt = Date.now();
    const progressEveryMs = opts.progressEveryMs ?? 15_000;
    for (let i = 0; i < opts.maxAttempts; i++) {
        if (await opts.probe()) return true;
        const now = Date.now();
        if (progressEveryMs > 0 && now - lastProgressAt >= progressEveryMs) {
            const elapsedSec = Math.round(((i + 1) * opts.intervalMs) / 1000);
            const maxSec = Math.round((opts.maxAttempts * opts.intervalMs) / 1000);
            console.error(`    ... waiting for ${opts.label} (${elapsedSec}s/${maxSec}s)`);
            lastProgressAt = now;
        }
        await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    (opts.onTimeout ?? ((l) => console.error(`wait_for: timeout: ${l}`)))(opts.label);
    return false;
}
