// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/wait.test.ts — progress heartbeat for bounded waits.

import { test, expect } from "bun:test";
import { waitFor } from "../src/util/wait";

test("waitFor emits periodic progress while polling", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = ((m: string) => errors.push(m)) as typeof console.error;
    try {
        const ok = await waitFor({
            label: "test dependency",
            maxAttempts: 3,
            intervalMs: 1,
            progressEveryMs: 1,
            probe: async () => false,
            onTimeout: () => undefined,
        });
        expect(ok).toBe(false);
    } finally {
        console.error = origError;
    }

    expect(errors.some((line) => line.includes("waiting for test dependency"))).toBe(true);
});

test("waitFor does not sleep after the final failed probe", async () => {
    const started = Date.now();
    const ok = await waitFor({
        label: "fast failure",
        maxAttempts: 1,
        intervalMs: 100,
        probe: async () => false,
        onTimeout: () => undefined,
    });

    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(80);
});
