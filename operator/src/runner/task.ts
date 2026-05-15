// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/runner/task.ts — Command-pattern TaskRunner.
//
// Every subcommand implements `Task`. `TaskRunner.run()` wraps execution
// in a try/catch so the Phase 2 incident-bridge hook lives in exactly
// one place; individual tasks don't have to think about it.

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

        // Phase 2 hook: on failure, capture incident context and print
        // the AI bridge unless suppressed. Centralised here so no per-task
        // plumbing is required.
        if (!result.ok && !this.ctx.noBridge) {
            await this.maybeEmitBridge(task, result);
        }

        if (this.ctx.json && result.json !== undefined) {
            process.stdout.write(JSON.stringify(result.json, null, 2) + "\n");
        }

        return result;
    }

    private async maybeEmitBridge(task: Task, result: TaskResult): Promise<void> {
        try {
            const mod = await import("../diag/capture");
            await mod.captureIncidentContext(this.ctx, task.name, result);
        } catch (err) {
            // Bridge collection itself must never mask the original failure.
            const msg = err instanceof Error ? err.message : String(err);
            this.ctx.logger.debug(`incident-bridge skipped: ${msg}`);
        }
    }
}
