// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/auto-sync.ts — `ct-operator auto-sync` task.
//
// Wraps src/util/credential-sync.ts as a runner Task. Same exit
// codes as ct auto-sync:
//   0   no drift, OR drift was detected and corrected
//   1   drift was detected and the correction failed
//   2   prerequisite missing (docker not on PATH, etc.)
//
// Flags:
//   --dry-run   skip the corrective action; report what would happen

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { runCredentialSync } from "../util/credential-sync";

export class AutoSyncTask implements Task {
    readonly name = "auto-sync";

    async run(_ctx: RunContext): Promise<TaskResult> {
        const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
        const result = await runCredentialSync({
            dryRun,
            logger: {
                info: (line) => process.stdout.write(line + "\n"),
                err: (line) => process.stderr.write(line + "\n"),
                raw: (text) => process.stdout.write(text + "\n"),
            },
        });

        if (result.outcome === "no_docker") {
            return { ok: false, code: 2, summary: "docker missing", skipBridge: true };
        }
        if (result.ok) {
            return { ok: true, code: 0, summary: result.outcome };
        }
        // drift detected and not corrected — operator needs to look
        return { ok: false, code: 1, summary: result.outcome, skipBridge: true };
    }
}
