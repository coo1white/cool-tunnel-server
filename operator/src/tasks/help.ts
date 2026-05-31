// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/help.ts — `ct-operator help [topic]` task.
//
// Thin wrapper over operator/help.ts so the operator binary can
// serve the same topic registry that `make help-<topic>` and
// `./ct help <topic>` hit. Exit codes: 0 success, 1 unknown topic.

import { renderTopic, renderTopicList } from "../../help";
import type { RunContext } from "../runner/context";
import type { Task, TaskResult } from "../runner/task";

export class HelpTask implements Task {
  readonly name = "help";

  async run(_ctx: RunContext): Promise<TaskResult> {
    const cmdIdx = process.argv.indexOf("help");
    const rest = (cmdIdx >= 0 ? process.argv.slice(cmdIdx + 1) : []).filter((a) => a !== "--json");
    if (
      rest.length === 0 ||
      rest[0] === "list" ||
      rest[0] === "topics" ||
      rest[0] === "-h" ||
      rest[0] === "--help"
    ) {
      process.stdout.write(renderTopicList());
      return { ok: true, code: 0, summary: "list" };
    }
    const r = renderTopic(rest[0]!);
    if (!r.ok) {
      process.stderr.write(`✗ ${r.error}\n\n`);
      process.stderr.write(renderTopicList());
      return { ok: false, code: 1, summary: r.error };
    }
    process.stdout.write(r.output);
    return { ok: true, code: 0, summary: rest[0]! };
  }
}
