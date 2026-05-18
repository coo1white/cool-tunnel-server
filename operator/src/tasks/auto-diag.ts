// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/auto-diag.ts — read-only diagnostic bundle.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture } from "../util/sh";
import { redact } from "../diag/bridge";

export interface AutoDiagOptions {
    readonly tail: number;
    readonly includeLogs: boolean;
}

export interface AutoDiagSection {
    readonly title: string;
    readonly command: string;
    readonly ok: boolean;
    readonly code: number;
    readonly duration_ms: number;
    readonly output: string;
}

const DEFAULT_TAIL = 120;

export function parseAutoDiagArgs(argv: readonly string[]): AutoDiagOptions | string {
    const cmdIdx = argv.indexOf("auto-diag");
    const rest = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2);
    let tail = DEFAULT_TAIL;
    let includeLogs = true;

    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === "--json" || arg === "--no-bridge") continue;
        if (arg === "--no-logs") {
            includeLogs = false;
            continue;
        }
        if (arg === "--tail") {
            const next = rest[++i];
            if (next === undefined) return "auto-diag: --tail requires a number";
            const parsed = Number(next);
            if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2000) {
                return "auto-diag: --tail must be an integer between 0 and 2000";
            }
            tail = parsed;
            continue;
        }
        if (arg.startsWith("--tail=")) {
            const parsed = Number(arg.slice("--tail=".length));
            if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2000) {
                return "auto-diag: --tail must be an integer between 0 and 2000";
            }
            tail = parsed;
            continue;
        }
        return `auto-diag: unknown flag: ${arg}`;
    }

    return { tail, includeLogs };
}

export function reportPathFor(date = new Date()): string {
    const ts = date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
    return `diagnostics/ct-auto-diag-${ts}.txt`;
}

export function summarizeSections(sections: readonly AutoDiagSection[]): {
    ok: boolean;
    passed: number;
    failed: number;
} {
    const failed = sections.filter((s) => !s.ok).length;
    return { ok: failed === 0, passed: sections.length - failed, failed };
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function commands(opts: AutoDiagOptions): Array<{ title: string; command: string }> {
    const cmds: Array<{ title: string; command: string }> = [
        { title: "Version", command: "./ct version" },
        { title: "Git State", command: "git status --short --branch && git log --oneline --decorate -5" },
        { title: "Host Resources", command: "uptime; free -h 2>/dev/null || true; df -h / /var/lib/docker . 2>/dev/null || df -h" },
        { title: "Compose State", command: "docker compose ps --all" },
        { title: "Doctor", command: "./ct doctor --no-bridge" },
        { title: "Ballast", command: "./ct ballast --no-bridge" },
        { title: "Version Bridge", command: "./ct version-bridge --no-bridge" },
        { title: "Drift", command: "./ct drift --no-bridge" },
    ];
    if (opts.includeLogs && opts.tail > 0) {
        cmds.push({
            title: `Recent Logs (tail ${opts.tail})`,
            command: `docker compose logs --no-color --tail=${opts.tail} caddy singbox panel db redis`,
        });
    }
    return cmds;
}

async function runSection(title: string, command: string): Promise<AutoDiagSection> {
    const start = Date.now();
    const r = await capture($`bash --noprofile --norc -c ${command}`);
    const raw = [r.stdout, r.stderr].filter((s) => s.length > 0).join("\n");
    return {
        title,
        command,
        ok: r.ok,
        code: r.code,
        duration_ms: Date.now() - start,
        output: redact(raw.trimEnd()),
    };
}

function renderReport(sections: readonly AutoDiagSection[]): string {
    const summary = summarizeSections(sections);
    const lines: string[] = [
        "Cool Tunnel Server — auto-diag report",
        `date: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`,
        `host: ${hostname()}`,
        `summary: ${summary.passed} passed, ${summary.failed} failed`,
        "",
    ];
    for (const section of sections) {
        lines.push(`## ${section.title}`);
        lines.push(`$ ${section.command}`);
        lines.push(`exit: ${section.code} (${section.duration_ms}ms)`);
        lines.push("");
        lines.push(section.output || "(no output)");
        lines.push("");
    }
    return lines.join("\n");
}

export class AutoDiagTask implements Task {
    readonly name = "auto-diag";

    async run(ctx: RunContext): Promise<TaskResult> {
        const opts = parseAutoDiagArgs(process.argv);
        if (typeof opts === "string") {
            process.stderr.write(`${opts}\nusage: ct auto-diag [--tail N] [--no-logs]\n`);
            return { ok: false, code: 2, summary: opts, skipBridge: true };
        }

        process.umask(0o077);
        mkdirSync("diagnostics", { recursive: true });

        if (!ctx.json) {
            process.stdout.write("Cool Tunnel Server — auto-diag\n");
            process.stdout.write("read-only checks; continuing after failures\n\n");
        }

        const sections: AutoDiagSection[] = [];
        for (const cmd of commands(opts)) {
            if (!ctx.json) process.stdout.write(`==> ${cmd.title}\n`);
            sections.push(await runSection(cmd.title, cmd.command));
        }

        const path = reportPathFor();
        writeFileSync(path, renderReport(sections), { mode: 0o600 });
        chmodSync(path, 0o600);

        const summary = summarizeSections(sections);
        if (!ctx.json) {
            process.stdout.write(`\nreport: ${path}\n`);
            process.stdout.write(`summary: ${summary.passed} passed, ${summary.failed} failed\n`);
            if (summary.failed > 0) {
                process.stdout.write(`paste the report when asking for help: ${shellQuote(path)}\n`);
            }
        }

        return {
            ok: summary.ok,
            code: summary.ok ? 0 : 1,
            summary: `${summary.passed} passed, ${summary.failed} failed`,
            json: { report: path, ...summary, sections },
            skipBridge: true,
        };
    }
}
