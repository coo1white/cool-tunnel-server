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
    // Optional logger for the timeout case. Defaults to console.error.
    readonly onTimeout?: (label: string) => void;
}

export async function waitFor(opts: WaitOptions): Promise<boolean> {
    for (let i = 0; i < opts.maxAttempts; i++) {
        if (await opts.probe()) return true;
        await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    (opts.onTimeout ?? ((l) => console.error(`wait_for: timeout: ${l}`)))(opts.label);
    return false;
}
