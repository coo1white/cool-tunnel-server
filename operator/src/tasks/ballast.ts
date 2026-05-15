// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/ballast.ts — critical-invariant check, dedicated runner.
//
// The same 10 checks that doctor appends as the "Ballast Stones" group,
// extracted as a standalone subcommand. Use case: cron / CI loops that
// want to assert just the must-pass invariants without the noise of
// doctor's PASS/WARN dashboard.
//
// Exit codes:
//   0   every check pass or warn (deployment is safe)
//   1   one or more checks FAIL (deployment is unsafe)

import { hostname } from "node:os";
import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { loadDotenv, mergeEnv } from "../util/env";
import { collectBallast } from "../diag/collectors/ballast";

const isTty = process.stdout.isTTY === true;
const C: Record<"pass" | "warn" | "fail" | "reset" | "bold", string> = {
    pass: isTty ? "\x1b[32m" : "",
    warn: isTty ? "\x1b[33m" : "",
    fail: isTty ? "\x1b[31m" : "",
    reset: isTty ? "\x1b[0m" : "",
    bold: isTty ? "\x1b[1m" : "",
};

export class BallastTask implements Task {
    readonly name = "ballast";

    async run(ctx: RunContext): Promise<TaskResult> {
        const dotenv = await loadDotenv([`${ctx.cwd}/.env`, `${ctx.cwd}/../.env`]);
        const env = mergeEnv(ctx.env, dotenv?.env ?? null);
        const ballastCtx: RunContext = { ...ctx, env };

        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        process.stdout.write(`${C.bold}Cool Tunnel Server — Ballast Stones${C.reset}\n`);
        process.stdout.write(`${C.bold} (date ${ts}, host ${hostname()})${C.reset}\n\n`);

        const ballast = await collectBallast(ballastCtx);

        let pass = 0;
        let warn = 0;
        let fail = 0;
        for (const check of ballast.checks) {
            const color = C[check.status];
            const tag = `[${check.status.toUpperCase()}]`;
            const padded = check.slug.padEnd(20);
            const tail = check.detail ? ` — ${check.detail}` : "";
            process.stdout.write(`  ${color}${tag}${C.reset} ${padded} ${check.title}${tail}\n`);
            if (check.status === "pass") pass++;
            else if (check.status === "warn") warn++;
            else fail++;
        }

        process.stdout.write(
            `\n  ${C.pass}${pass} PASS${C.reset}, ${C.warn}${warn} WARN${C.reset}, ${C.fail}${fail} FAIL${C.reset}\n`,
        );

        const ok = fail === 0;
        return {
            ok,
            code: ok ? 0 : 1,
            summary: `${pass}P/${warn}W/${fail}F`,
            json: ballast,
        };
    }
}
