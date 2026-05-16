#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/wire-probe.ts — top-level entry for the wire-protocol
// drift probe. Spawns a naive client against the deployment's
// upstream and asserts it negotiates the Padding extension.

import { WireProbeTask } from "./src/tasks/wire-probe";
import { TaskRunner } from "./src/runner/task";
import { createConsoleLogger, type RunContext } from "./src/runner/context";
import { ensureRepoRoot } from "./src/util/repo-root";

async function main(): Promise<number> {
    ensureRepoRoot(import.meta.url);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
    }

    const ctx: RunContext = {
        cwd: process.cwd(),
        env,
        logger: createConsoleLogger(),
        json: process.argv.includes("--json"),
        noBridge: process.argv.includes("--no-bridge"),
        interactive: process.stdin.isTTY === true,
    };

    const runner = new TaskRunner(ctx);
    const result = await runner.run(new WireProbeTask());
    return result.code;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
