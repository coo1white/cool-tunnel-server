// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/runner/task.ts — Command-pattern TaskRunner.
//
// Every subcommand implements `Task`. `TaskRunner.run()` wraps execution
// in a try/catch so individual tasks can stay focused on their command.

import { redactSensitive } from "../util/redact";
import type { RunContext } from "./context";

export interface TaskResult {
  readonly ok: boolean;
  readonly code: number;
  readonly summary?: string;
  // Optional structured payload for --json mode (e.g. doctor's PASS/WARN/FAIL table).
  readonly json?: unknown;
}

export interface Task {
  readonly name: string;
  run(ctx: RunContext): Promise<TaskResult>;
}

export class TaskRunner {
  constructor(private readonly ctx: RunContext) {}

  async run(task: Task): Promise<TaskResult> {
    const start = Date.now();
    this.ctx.logger.info(`[${task.name}] start`);

    let result: TaskResult;
    try {
      result = await task.run(this.ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(`[${task.name}] threw: ${msg}`);
      result = { ok: false, code: 1, summary: `uncaught: ${msg}` };
    }

    const dur = Date.now() - start;
    const tag = result.ok ? "ok" : "fail";
    const tail = result.summary ? `, ${result.summary}` : "";
    this.ctx.logger.info(`[${task.name}] ${tag} (${dur}ms${tail})`);

    if (this.ctx.json && result.json !== undefined) {
      process.stdout.write(`${redactSensitive(JSON.stringify(result.json, null, 2))}\n`);
    }

    return result;
  }
}
