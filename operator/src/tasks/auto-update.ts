// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/auto-update.ts — `ct-operator auto-update` task.
//
// Thin wrapper over operator/auto-update.ts. Same exit codes as the
// bash original: 0 OK or skipped, 1 upgrade attempted-and-failed,
// 2 refused-to-upgrade.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { parseAutoUpdateArgs, runAutoUpdate } from "../../auto-update";

export class AutoUpdateTask implements Task {
    readonly name = "auto-update";

    async run(_ctx: RunContext): Promise<TaskResult> {
        const parsed = parseAutoUpdateArgs(process.argv);
        if (typeof parsed === "string") {
            process.stderr.write(parsed + "\n");
            return { ok: false, code: 2, summary: "bad flags", skipBridge: true };
        }
        try {
            const code = await runAutoUpdate(parsed);
            return code === 0
                ? { ok: true, code: 0, summary: "auto-update" }
                : { ok: false, code, summary: `auto-update exited ${code}`, skipBridge: true };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, code: 1, summary: msg, skipBridge: true };
        }
    }
}
