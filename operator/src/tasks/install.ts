// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/install.ts — `ct-operator install` task.
//
// Thin wrapper over operator/install.ts.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { runInstall } from "../../install";

export class InstallTask implements Task {
    readonly name = "install";

    async run(_ctx: RunContext): Promise<TaskResult> {
        try {
            const code = await runInstall();
            return code === 0
                ? { ok: true, code: 0, summary: "installed" }
                : { ok: false, code, summary: `install exited ${code}` };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, code: 1, summary: msg };
        }
    }
}
