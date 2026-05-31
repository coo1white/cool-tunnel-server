// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/update.ts — `ct-operator update` task.
//
// Thin wrapper over operator/update.ts.

import { runUpdate } from "../../update";
import type { RunContext } from "../runner/context";
import type { Task, TaskResult } from "../runner/task";

export class UpdateTask implements Task {
  readonly name = "update";

  async run(_ctx: RunContext): Promise<TaskResult> {
    try {
      const code = await runUpdate();
      return code === 0
        ? { ok: true, code: 0, summary: "updated" }
        : { ok: false, code, summary: `update exited ${code}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 1, summary: msg };
    }
  }
}
