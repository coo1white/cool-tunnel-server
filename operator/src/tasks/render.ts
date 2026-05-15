// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/render.ts — one-shot config render subcommand.
//
// Consolidates the three scripts/render-{caddyfile,haproxy,singbox}.sh
// thin wrappers. All three do the same thing: forward to
// `ct-server-core --json <target> render` inside the panel container.
// The shell scripts remain in place for back-compat; this task is the
// Bun-native path used when the operator binary is available.
//
// Usage:
//   ct-operator render <target> [--if-changed]
//   target = caddyfile | haproxy | singbox

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture, which } from "../util/sh";

const TARGETS = ["caddyfile", "haproxy", "singbox"] as const;
type Target = typeof TARGETS[number];

function isTarget(s: string): s is Target {
    return (TARGETS as readonly string[]).includes(s);
}

export function parseArgs(argv: readonly string[]): { target: Target; passthrough: string[] } | string {
    const cmdIdx = argv.indexOf("render");
    if (cmdIdx < 0) return "render: command missing from argv";
    const rest = argv.slice(cmdIdx + 1).filter((a) => a !== "--json" && a !== "--no-bridge");
    if (rest.length === 0) {
        return `render: target required (one of: ${TARGETS.join(", ")})`;
    }
    const [target, ...passthrough] = rest;
    if (!target || !isTarget(target)) {
        return `render: unknown target "${target}" (one of: ${TARGETS.join(", ")})`;
    }
    return { target, passthrough };
}

export class RenderTask implements Task {
    readonly name = "render";

    async run(ctx: RunContext): Promise<TaskResult> {
        const parsed = parseArgs(process.argv);
        if (typeof parsed === "string") {
            ctx.logger.error(parsed);
            return { ok: false, code: 2, summary: "bad args", skipBridge: true };
        }
        const { target, passthrough } = parsed;

        if (!(await which("docker"))) {
            ctx.logger.error("docker not on PATH");
            return { ok: false, code: 2, summary: "no docker", skipBridge: true };
        }

        ctx.logger.info(`rendering ${target} config via ct-server-core`);
        const r = await capture(
            $`docker compose exec -T panel ct-server-core --json ${target} render ${passthrough}`,
        );
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        if (!r.ok) {
            return {
                ok: false,
                code: r.code || 1,
                summary: `${target} render failed (exit ${r.code})`,
            };
        }
        return { ok: true, code: 0, summary: `${target} rendered` };
    }
}
