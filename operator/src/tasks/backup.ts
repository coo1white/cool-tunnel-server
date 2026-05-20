// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/backup.ts — `ct-operator backup` task.
//
// Thin wrapper over operator/backup.ts's runBackup(); same exit
// code semantics. The standalone script is the canonical
// implementation — this just plumbs it into the runner so
// `./ct backup` can dispatch through the operator binary the
// same way doctor / render / restore / update do.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";

export class BackupTask implements Task {
    readonly name = "backup";

    async run(_ctx: RunContext): Promise<TaskResult> {
        const { runBackup } = await import("../../backup");
        try {
            const code = await runBackup();
            return code === 0
                ? { ok: true, code: 0, summary: "backup written" }
                : { ok: false, code, summary: `backup exited ${code}`, skipBridge: true };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, code: 1, summary: msg, skipBridge: true };
        }
    }
}
