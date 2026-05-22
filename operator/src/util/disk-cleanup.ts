// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/disk-cleanup.ts — safe install/update cleanup.

import { rmSync } from "node:fs";
import { $, capture, which, type ShResult } from "./sh";
import {
    classifyDiskSpace,
    DEFAULT_DISK_THRESHOLDS,
    formatDiskSpaceSummary,
    measureDiskSpace,
    type DiskSpaceMeasurement,
    type DiskSpaceThresholds,
    type PreflightResult,
} from "./preflight";

export interface CleanupCommand {
    readonly label: string;
    readonly argv: readonly string[];
    readonly canRun?: () => Promise<boolean>;
}

export interface CleanupStepResult {
    readonly label: string;
    readonly action: "ran" | "skipped" | "failed";
    readonly detail: string;
}

export interface AutoTempCleanResult {
    readonly before: DiskSpaceMeasurement;
    readonly after: DiskSpaceMeasurement;
    readonly steps: readonly CleanupStepResult[];
    readonly disk: PreflightResult;
}

export interface AutoTempCleanOptions {
    readonly thresholds?: DiskSpaceThresholds;
    readonly commands?: readonly CleanupCommand[];
    readonly cleanRepoCache?: (space: DiskSpaceMeasurement, thresholds: DiskSpaceThresholds) => CleanupStepResult | null;
    readonly forceDockerCleanup?: boolean;
    readonly measure?: () => Promise<DiskSpaceMeasurement>;
    readonly run?: (cmd: CleanupCommand) => Promise<ShResult>;
}

export const DEFAULT_CLEANUP_COMMANDS: readonly CleanupCommand[] = [
    {
        label: "Docker builder cache",
        argv: ["docker", "builder", "prune", "-f"],
        canRun: () => which("docker"),
    },
    {
        label: "Unused Docker data",
        argv: ["docker", "system", "prune", "-af"],
        canRun: () => which("docker"),
    },
];

export function formatCleanupCommand(cmd: CleanupCommand): string {
    return cmd.argv.join(" ");
}

export function describeCleanupDelta(
    before: DiskSpaceMeasurement,
    after: DiskSpaceMeasurement,
): string {
    const repoDelta = after.repoGb - before.repoGb;
    const dockerDelta = after.dockerGb - before.dockerGb;
    const parts = [
        repoDelta > 0 ? `repo +${repoDelta}G` : `repo ${after.repoGb}G`,
        dockerDelta > 0 ? `docker +${dockerDelta}G` : `docker ${after.dockerGb}G`,
    ];
    return parts.join(", ");
}

export function cleanupRepoBuildCache(
    space: DiskSpaceMeasurement,
    thresholds: DiskSpaceThresholds = DEFAULT_DISK_THRESHOLDS,
): CleanupStepResult | null {
    if (space.repoGb >= thresholds.minRepoGb) return null;
    try {
        rmSync("core/target", { recursive: true, force: true });
        return {
            label: "Rust build cache",
            action: "ran",
            detail: "removed core/target",
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            label: "Rust build cache",
            action: "failed",
            detail: msg.split("\n")[0] ?? "rmSync core/target failed",
        };
    }
}

async function runCleanupCommand(cmd: CleanupCommand): Promise<ShResult> {
    const [bin, ...args] = cmd.argv;
    if (!bin) {
        return { ok: false, code: 2, stdout: "", stderr: "empty cleanup command" };
    }
    return await capture($`${bin} ${args}`);
}

export async function runAutoTempClean(
    opts: AutoTempCleanOptions = {},
): Promise<AutoTempCleanResult> {
    const thresholds = opts.thresholds ?? DEFAULT_DISK_THRESHOLDS;
    const measure = opts.measure ?? measureDiskSpace;
    const run = opts.run ?? runCleanupCommand;
    const cleanRepoCache = opts.cleanRepoCache ?? cleanupRepoBuildCache;
    const commands = opts.commands ?? DEFAULT_CLEANUP_COMMANDS;
    const forceDockerCleanup = opts.forceDockerCleanup ?? false;

    const before = await measure();
    const steps: CleanupStepResult[] = [];
    const beforeDisk = classifyDiskSpace(before, thresholds);
    if (beforeDisk.ok && !forceDockerCleanup) {
        return {
            before,
            after: before,
            steps,
            disk: beforeDisk,
        };
    }

    if (!beforeDisk.ok) {
        const repoStep = cleanRepoCache(before, thresholds);
        if (repoStep) steps.push(repoStep);
    }

    for (const cmd of commands) {
        if (cmd.canRun && !(await cmd.canRun())) {
            steps.push({
                label: cmd.label,
                action: "skipped",
                detail: `${cmd.argv[0] ?? "command"} not on PATH`,
            });
            continue;
        }
        const r = await run(cmd);
        if (r.ok) {
            const detail = `${formatCleanupCommand(cmd)}${r.stdout || r.stderr ? `; ${(r.stdout + r.stderr).trim().split("\n").filter(Boolean).slice(-1)[0] ?? "ok"}` : ""}`;
            steps.push({
                label: cmd.label,
                action: "ran",
                detail,
            });
        } else {
            steps.push({
                label: cmd.label,
                action: "failed",
                detail: `${formatCleanupCommand(cmd)}: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`,
            });
        }
    }

    const after = await measure();
    return {
        before,
        after,
        steps,
        disk: classifyDiskSpace(after, thresholds),
    };
}

export function formatAutoTempCleanSummary(result: AutoTempCleanResult): string {
    const ran = result.steps.filter((s) => s.action === "ran").length;
    const failed = result.steps.filter((s) => s.action === "failed").length;
    const prefix = failed > 0
        ? `temp cleanup ran with ${failed} warning(s)`
        : ran > 0
            ? "temp cleanup complete"
            : "disk headroom OK; no cleanup needed";
    return `${prefix}; ${describeCleanupDelta(result.before, result.after)}; ${formatDiskSpaceSummary(result.after)}`;
}
