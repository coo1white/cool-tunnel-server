// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/restore.ts — `ct-operator restore <path>` task.
//
// Thin wrapper over operator/restore.ts's runRestore(). Same exit
// code semantics: 0 success, 2 argv error, 1 anything else.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { parseRestoreArgs, runRestore } from "../../restore";

export class RestoreTask implements Task {
    readonly name = "restore";

    async run(_ctx: RunContext): Promise<TaskResult> {
        const parsed = parseRestoreArgs(process.argv);
        if (typeof parsed === "string") {
            process.stderr.write(parsed + "\n");
            process.stderr.write("ls backups/\n");
            return { ok: false, code: 2, summary: "bad args" };
        }
        try {
            const code = await runRestore(parsed.path);
            return code === 0
                ? { ok: true, code: 0, summary: "restored" }
                : { ok: false, code, summary: `restore exited ${code}` };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, code: 1, summary: msg };
        }
    }
}
