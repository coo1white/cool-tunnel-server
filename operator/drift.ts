#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/drift.ts — top-level entry for the three-way cleartext
// drift detector. Mirrors operator/backup.ts shape: argv-only, no
// flags beyond `--json` (forwarded to the task via its own
// argv-parsing). The compiled ct-operator binary dispatches the
// `drift` subcommand into the same task.

import { DriftTask } from "./src/tasks/drift";
import { TaskRunner } from "./src/runner/task";
import { createConsoleLogger, type RunContext } from "./src/runner/context";
import { ensureRepoRoot } from "./src/util/repo-root";

async function main(): Promise<number> {
    ensureRepoRoot(import.meta.url);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
    }

    const json = process.argv.includes("--json");
    const ctx: RunContext = {
        cwd: process.cwd(),
        env,
        logger: createConsoleLogger(),
        json,
        noBridge: process.argv.includes("--no-bridge"),
        interactive: process.stdin.isTTY === true,
    };

    const runner = new TaskRunner(ctx);
    const result = await runner.run(new DriftTask());
    return result.code;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
