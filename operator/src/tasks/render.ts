// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/render.ts — one-shot config render subcommand.
//
// v0.5.2 render targets are owned by the Hono API boundary and run
// inside the admin-api container. Rust remains internal for Caddyfile
// rendering; singbox-core remains internal for sing-box JSON rendering.
//
// Usage:
//   ct-operator render caddyfile [--if-changed]
//   ct-operator render singbox [--if-changed]
//     ct-singbox's supervisor watches the rendered file.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture, which } from "../util/sh";
import { renderScript } from "../../install";

const TARGETS = ["caddyfile", "singbox"] as const;
type Target = typeof TARGETS[number];

// Targets that were valid in v0.1.x but no longer have a backing
// service. Surface a retirement hint rather than a generic "unknown
// target" error so operators reading old runbooks know what changed.
const RETIRED_TARGETS = new Set(["haproxy"]);

function isTarget(s: string): s is Target {
    return (TARGETS as readonly string[]).includes(s);
}

export function parseArgs(argv: readonly string[]): { target: Target; passthrough: string[] } | string {
    const cmdIdx = argv.indexOf("render");
    if (cmdIdx < 0) return "render: command missing from argv";
    const rest = argv.slice(cmdIdx + 1).filter((a) => a !== "--json");
    if (rest.length === 0) {
        return `render: target required (one of: ${TARGETS.join(", ")})`;
    }
    const [target, ...passthrough] = rest;
    if (target && RETIRED_TARGETS.has(target)) {
        return `render: target "${target}" is retired. Current targets: ${TARGETS.join(", ")}`;
    }
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
            return { ok: false, code: 2, summary: "bad args" };
        }
        const { target, passthrough } = parsed;

        if (!(await which("docker"))) {
            ctx.logger.error("docker not on PATH");
            return { ok: false, code: 2, summary: "no docker" };
        }

        ctx.logger.info(`rendering ${target} config`);
        if (passthrough.length > 0) {
            ctx.logger.warn("render passthrough flags are ignored by the v0.5.2 admin-api renderer");
        }
        const action = target === "caddyfile" ? "render-caddyfile" : "render-singbox";
        const r = await capture($`docker compose run --rm --no-deps admin-api bun -e ${renderScript(action)}`);
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        if (!r.ok) {
            return {
                ok: false,
                code: r.code || 1,
                summary: `${target} render failed (exit ${r.code})`,
            };
        }
        if (target === "singbox") {
            const file = await capture($`docker compose run --rm --no-deps --entrypoint sh admin-api -c ${"test -s /data/config/singbox.json"}`);
            if (!file.ok) {
                return {
                    ok: false,
                    code: 1,
                    summary: "singbox render did not write /data/config/singbox.json",
                };
            }
        }
        return { ok: true, code: 0, summary: `${target} rendered` };
    }
}
