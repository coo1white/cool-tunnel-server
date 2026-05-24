// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/render.ts — one-shot config render subcommand.
//
// v0.4.0+ has two live render targets:
//   - caddyfile: ct-server-core still owns the Caddyfile renderer.
//   - singbox: Bun admin shells to singbox-core.
// `haproxy` stays retired.
//
// Usage:
//   ct-operator render caddyfile [--if-changed]
//   ct-operator render singbox [--if-changed]
//     ct-singbox's supervisor watches the rendered file.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture, which } from "../util/sh";
import { redactSensitive } from "../util/redact";
import type { EnvMap } from "../util/env";

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

export function renderFailureSummary(target: Target, code: number, stdout: string, stderr: string, _env: EnvMap = {}): string {
    const output = `${stdout}\n${stderr}`;
    if (target === "singbox" && output.includes("rendered sing-box config missing")) {
        return "singbox render failed: /data/config/singbox.json was not created. Run: ct recover diagnose";
    }
    return `${target} render failed (exit ${code}). Run: ct recover diagnose`;
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
        const r = target === "singbox"
            ? await capture($`docker compose exec -T panel bun run /opt/cool-tunnel/operator/src/index.ts admin render-singbox ${passthrough}`)
            : await capture($`docker compose exec -T panel bun run /opt/cool-tunnel/operator/src/index.ts admin render-caddyfile ${passthrough}`);
        if (r.stdout) process.stdout.write(redactSensitive(r.stdout));
        if (r.stderr) process.stderr.write(redactSensitive(r.stderr));
        if (!r.ok) {
            return {
                ok: false,
                code: r.code || 1,
                summary: renderFailureSummary(target, r.code, r.stdout, r.stderr, ctx.env),
            };
        }
        if (target === "singbox") {
            const file = await capture($`docker compose exec -T panel test -s /data/config/singbox.json`);
            if (!file.ok) {
                return {
                    ok: false,
                    code: 1,
                    summary: "singbox render command exited 0 but /data/config/singbox.json is missing or empty. Run: ct recover diagnose",
                };
            }
        }
        return { ok: true, code: 0, summary: `${target} rendered` };
    }
}
