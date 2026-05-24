// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recover.ts — post install/update recovery helper.
//
// This command is intentionally small and operational: when install/update
// fails after the stack is mostly up, gather the few facts that matter and
// perform the two common repairs without turning the operator into a shell
// debugger.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture, which, type ShResult } from "../util/sh";
import {
    credentialLockCheckCommand,
    renderSingboxConfigCommand,
    SINGBOX_CONFIG_PATH,
} from "../util/credential-control";
import { redactSensitive } from "../util/redact";
import type { EnvMap } from "../util/env";

type Mode = "diagnose" | "fix-stale-singbox";

export interface RecoverArgs {
    readonly mode: Mode;
}

export function parseRecoverArgs(argv: readonly string[]): RecoverArgs | string {
    const cmdIdx = argv.indexOf("recover");
    if (cmdIdx < 0) return "recover: command missing from argv";
    const rest = argv.slice(cmdIdx + 1).filter((a) => a !== "--json");
    if (rest.length === 0 || rest[0] === "diagnose") return { mode: "diagnose" };
    if (rest[0] === "--fix-stale-singbox" || rest[0] === "fix-stale-singbox") {
        return { mode: "fix-stale-singbox" };
    }
    if (rest[0] === "-h" || rest[0] === "--help") {
        return "recover: usage: ct recover [diagnose|fix-stale-singbox]";
    }
    return `recover: unknown mode "${rest[0]}"`;
}

export function summarizeRenderNames(output: string): string {
    const names = output.split("\n").map((line) => line.trim()).filter(Boolean);
    if (names.length === 0) return "none";
    if (names.length <= 6) return names.join(", ");
    return `${names.slice(0, 6).join(", ")} ... (+${names.length - 6} more)`;
}

export function recoveryAdvice(input: {
    readonly dbVlessCount: number | null;
    readonly renderedUserCount: number | null;
    readonly renderedNames: string;
    readonly credentialLockOk: boolean;
    readonly renderOutput?: string;
    readonly env?: EnvMap;
}): string {
    const renderOutput = input.renderOutput ?? "";
    if (renderOutput.includes("invalid") || renderOutput.includes("REALITY_")) {
        return "Render failed on validated admin config. Check REALITY_* values in .env, then run: ct recover diagnose";
    }
    if (input.credentialLockOk) {
        return "credential-lock OK. Continue with: ./ct update";
    }
    if (input.dbVlessCount === 0 && input.renderedUserCount !== null && input.renderedUserCount > 0) {
        return "DB has zero active VLESS accounts but rendered config still has users. Run: ct recover fix-stale-singbox";
    }
    if (input.dbVlessCount !== null && input.renderedUserCount !== null && input.dbVlessCount !== input.renderedUserCount) {
        return "DB/rendered account counts differ. Run: ct recover fix-stale-singbox; if it persists, inspect panel logs.";
    }
    if (input.renderedNames.includes("__no_active_accounts__")) {
        return "rendered config contains the no-active-accounts placeholder; credential-lock should allow it. Update operator/panel or inspect guard logs.";
    }
    return "Run the printed render + credential-lock commands, then inspect panel logs for singbox.render.* or SQLSTATE.";
}

class RecoverTaskImpl {
    private failures = 0;

    async run(mode: Mode): Promise<TaskResult> {
        if (!(await which("docker"))) {
            process.stderr.write("docker not on PATH\n");
            return { ok: false, code: 2, summary: "no docker" };
        }

        if (mode === "fix-stale-singbox") {
            return this.fixStaleSingbox();
        }
        return this.diagnose();
    }

    private async diagnose(): Promise<TaskResult> {
        process.stdout.write("cool-tunnel-server — recover diagnose\n\n");
        await this.printCommand("docker compose ps", capture($`docker compose ps`));

        const render = await this.printCommand(
            renderSingboxConfigCommand().join(" "),
            capture($`${renderSingboxConfigCommand()}`),
        );
        const lock = await this.printCommand(
            credentialLockCheckCommand().join(" "),
            capture($`${credentialLockCheckCommand()}`),
        );
        const dbCount = await this.dbVlessCount();
        const renderedNames = await this.renderedNames();
        const renderedCount = renderedNames.ok
            ? renderedNames.stdout.split("\n").map((line) => line.trim()).filter(Boolean).length
            : null;

        process.stdout.write("\nSummary\n");
        process.stdout.write(`  DB active VLESS accounts: ${dbCount ?? "unknown"}\n`);
        process.stdout.write(`  Rendered VLESS users: ${renderedCount ?? "unknown"}\n`);
        if (renderedNames.ok) {
            process.stdout.write(`  Rendered names: ${summarizeRenderNames(renderedNames.stdout)}\n`);
        }
        process.stdout.write(`  Render command: ${render.ok ? "OK" : "FAILED"}\n`);
        process.stdout.write(`  Credential lock: ${lock.ok ? "OK" : "FAILED"}\n`);
        process.stdout.write(`\nNext: ${recoveryAdvice({
            dbVlessCount: dbCount,
            renderedUserCount: renderedCount,
            renderedNames: renderedNames.stdout,
            credentialLockOk: lock.ok,
            renderOutput: `${render.stdout}\n${render.stderr}`,
            env: {},
        })}\n`);

        await this.printFilteredPanelLogs();
        return { ok: this.failures === 0, code: this.failures === 0 ? 0 : 1, summary: "diagnosed" };
    }

    private async fixStaleSingbox(): Promise<TaskResult> {
        process.stdout.write("cool-tunnel-server — recover fix-stale-singbox\n\n");
        await this.printCommand("docker compose stop singbox", capture($`docker compose stop singbox`));
        await this.printCommand(
            `docker compose exec -T panel rm -f ${SINGBOX_CONFIG_PATH}`,
            capture($`docker compose exec -T panel rm -f ${SINGBOX_CONFIG_PATH}`),
        );
        const render = await this.printCommand(
            renderSingboxConfigCommand().join(" "),
            capture($`${renderSingboxConfigCommand()}`),
        );
        const names = await this.renderedNames();
        if (names.ok) {
            process.stdout.write(`\nRendered VLESS users: ${summarizeRenderNames(names.stdout)}\n`);
        } else {
            this.noteFailure("could not read rendered VLESS users", names);
        }
        const lock = await this.printCommand(
            credentialLockCheckCommand().join(" "),
            capture($`${credentialLockCheckCommand()}`),
        );
        await this.printCommand(
            "docker compose up -d --no-build --pull never singbox",
            capture($`docker compose up -d --no-build --pull never singbox`),
        );

        if (render.ok && lock.ok && this.failures === 0) {
            process.stdout.write("\nRecovered. Continue with: ./ct update\n");
            return { ok: true, code: 0, summary: "recovered" };
        }

        process.stdout.write("\nRecovery did not fully settle. Run: ct recover diagnose\n");
        await this.printFilteredPanelLogs();
        return { ok: false, code: 1, summary: "recovery incomplete" };
    }

    private async dbVlessCount(): Promise<number | null> {
        const r = await capture($`docker compose exec -T panel bun run /opt/cool-tunnel/operator/src/index.ts admin users list --json`);
        if (!r.ok) return null;
        let n = NaN;
        try {
            const parsed = JSON.parse(r.stdout) as { users?: unknown[] };
            n = parsed.users?.length ?? NaN;
        } catch {
            n = NaN;
        }
        return Number.isFinite(n) ? n : null;
    }

    private async renderedNames(): Promise<ShResult> {
        const jq = `.inbounds[]? | select(.type=="vless") | .users[]? | select((.name|startswith("__previous_uuid:"))|not) | .name`;
        return capture($`docker compose exec -T panel jq -r ${jq} ${SINGBOX_CONFIG_PATH}`);
    }

    private async printFilteredPanelLogs(): Promise<void> {
        const pattern = "ERROR|CRITICAL|Exception|singbox.render|proxy_account|SQLSTATE|MassAssignment|reality|failed|credential-lock";
        const logs = await capture(
            $`docker compose logs --tail=200 --no-color panel singbox`,
        );
        if (!logs.ok) {
            this.noteFailure("could not read panel/singbox logs", logs);
            return;
        }
        const lines = logs.stdout.split("\n").filter((line) => new RegExp(pattern, "i").test(line));
        process.stdout.write("\nRecent relevant logs\n");
        if (lines.length === 0) {
            process.stdout.write("  (no matching panel/singbox log lines in last 200)\n");
        } else {
            for (const line of lines.slice(-80)) process.stdout.write(`  ${redactSensitive(line)}\n`);
        }
    }

    private async printCommand(label: string, promise: Promise<ShResult>): Promise<ShResult> {
        process.stdout.write(`$ ${label}\n`);
        const r = await promise;
        if (r.stdout.trim()) process.stdout.write(indent(redactSensitive(r.stdout)));
        if (r.stderr.trim()) process.stderr.write(indent(redactSensitive(r.stderr)));
        if (!r.ok) this.noteFailure(`${label} failed`, r);
        process.stdout.write("\n");
        return r;
    }

    private noteFailure(label: string, r: ShResult): void {
        this.failures++;
        process.stderr.write(`! ${label} (exit ${r.code})\n`);
    }
}

function indent(text: string): string {
    return text.split("\n").map((line) => line ? `  ${line}` : line).join("\n").replace(/\n?$/, "\n");
}

export class RecoverTask implements Task {
    readonly name = "recover";

    async run(ctx: RunContext): Promise<TaskResult> {
        const parsed = parseRecoverArgs(process.argv);
        if (typeof parsed === "string") {
            ctx.logger.error(parsed);
            return { ok: false, code: 2, summary: "bad args" };
        }
        return new RecoverTaskImpl().run(parsed.mode);
    }
}
