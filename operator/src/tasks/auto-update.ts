// SPDX-License-Identifier: AGPL-3.0-only

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { runAutoUpdate, parseAutoUpdateArgs } from "../../auto-update";

export class AutoUpdateTask implements Task {
    readonly name = "auto-update";

    async run(_ctx: RunContext): Promise<TaskResult> {
        const parsed = parseAutoUpdateArgs(process.argv);
        if (typeof parsed === "string") {
            process.stderr.write(parsed + "\n");
            return { ok: false, code: 2, summary: "bad args" };
        }
        const code = await runAutoUpdate(parsed);
        return code === 0
            ? { ok: true, code: 0, summary: "auto-update complete" }
            : { ok: false, code, summary: `auto-update exited ${code}` };
    }
}
