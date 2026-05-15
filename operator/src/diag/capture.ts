// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/capture.ts — incident-context aggregator + AI bridge emitter.
//
// Called by TaskRunner on any task failure (unless --no-bridge). Runs the
// four collectors in parallel, redacts obvious secrets, then prints either:
//   --json mode → JSON of the incident to stderr (stdout already has task json)
//   default     → fenced prompt block to stdout for the operator to copy

import type { RunContext } from "../runner/context";
import type { TaskResult } from "../runner/task";
import type { BallastResult, CollectorOutput, ComposeState, IncidentContext, JournalSlice, ProcTreeSnapshot, SysMetrics } from "./types";
import { collectSysMetrics } from "./collectors/sysmetrics";
import { collectJournal } from "./collectors/journal";
import { collectProcTree } from "./collectors/proctree";
import { collectBallast } from "./collectors/ballast";
import { collectComposeState } from "./collectors/compose_state";
import { formatBridge, redactContext } from "./bridge";
import { $, capture } from "../util/sh";
import { loadDotenv, mergeEnv } from "../util/env";

declare const BUILD_VERSION: string;
const VERSION: string = (typeof BUILD_VERSION !== "undefined") ? BUILD_VERSION : "dev";

async function timed<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<CollectorOutput<T>> {
    const start = Date.now();
    try {
        const data = await fn();
        return { name, ok: true, data, duration_ms: Date.now() - start };
    } catch (err) {
        return {
            name,
            ok: false,
            data: fallback,
            error: err instanceof Error ? err.message : String(err),
            duration_ms: Date.now() - start,
        };
    }
}

async function readHostInfo(): Promise<{ kernel: string; uptime_seconds: number }> {
    const k = await capture($`uname -sr`);
    let uptime = 0;
    try {
        const proc = await Bun.file("/proc/uptime").text();
        uptime = Math.floor(Number(proc.trim().split(/\s+/)[0] ?? "0"));
    } catch {
        // macOS fallback: sysctl kern.boottime
        const r = await capture($`sysctl -n kern.boottime`);
        const m = r.stdout.match(/sec = (\d+)/);
        if (m && m[1]) uptime = Math.floor(Date.now() / 1000) - Number(m[1]);
    }
    return { kernel: k.stdout.trim() || "unknown", uptime_seconds: uptime };
}

const EMPTY_BALLAST: BallastResult = { overall_ok: false, checks: [] };
const EMPTY_JOURNAL: Record<string, JournalSlice> = {};
const EMPTY_METRICS: SysMetrics = {
    cpu: { load_1m: 0, load_5m: 0, load_15m: 0, cores: 0 },
    memory: { total_kb: 0, available_kb: 0, used_pct: 0 },
    disk: [],
};
const EMPTY_PROCTREE: ProcTreeSnapshot = { lines: [] };
const EMPTY_COMPOSE: ComposeState = { services: [] };

export async function captureIncidentContext(
    ctx: RunContext,
    taskName: string,
    result: TaskResult,
): Promise<void> {
    ctx.logger.info(`[incident] collecting context for ${taskName} (exit=${result.code})…`);

    // v0.1.6: merge .env so ballast checks that depend on DOMAIN /
    // PANEL_DOMAIN / REDIS_PASSWORD work the same way as a direct
    // `ct ballast` run. Without this, the bridge-emitted ballast
    // loses .env-only vars (v0.1.5 capture used process.env only).
    const dotenv = await loadDotenv([`${ctx.cwd}/.env`, `${ctx.cwd}/../.env`]);
    const env = mergeEnv(ctx.env, dotenv?.env ?? null);
    const collectorCtx: RunContext = { ...ctx, env };

    const [ballast, journal, metrics, proctree, compose, host] = await Promise.all([
        timed("ballast", () => collectBallast(collectorCtx), EMPTY_BALLAST),
        timed("journal", () => collectJournal(), EMPTY_JOURNAL),
        timed("sysmetrics", () => collectSysMetrics(), EMPTY_METRICS),
        timed("proctree", () => collectProcTree(), EMPTY_PROCTREE),
        timed("compose", () => collectComposeState(), EMPTY_COMPOSE),
        readHostInfo(),
    ]);

    const incident: IncidentContext = {
        schema_version: 1,
        operator_version: VERSION,
        task: taskName,
        exit_code: result.code,
        ts: new Date().toISOString(),
        host,
        ballast,
        journal,
        metrics,
        proctree,
        compose,
    };
    if (result.summary !== undefined) {
        incident.summary = result.summary;
    }

    const scrubbed = redactContext(incident);

    if (ctx.json) {
        // In --json mode, the task's own JSON is on stdout. Append the incident
        // bundle to stderr so it remains accessible without corrupting stdout.
        process.stderr.write(JSON.stringify(scrubbed, null, 2) + "\n");
    } else {
        process.stdout.write("\n=== INCIDENT BRIDGE (paste below into your AI) ===\n");
        process.stdout.write(formatBridge(scrubbed));
        process.stdout.write("=== END INCIDENT BRIDGE ===\n");
    }
}
