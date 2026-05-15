#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/index.ts — CLI entry: parse argv, build RunContext, dispatch.

import { TaskRunner } from "./runner/task";
import { createConsoleLogger, type RunContext } from "./runner/context";
import type { Task } from "./runner/task";

declare const BUILD_VERSION: string;

// At dev time (bun run src/index.ts) BUILD_VERSION isn't defined; fall
// back to a sentinel. The compiled binary always has it baked in.
const VERSION: string = (typeof BUILD_VERSION !== "undefined") ? BUILD_VERSION : "dev";

const USAGE = `ct-operator ${VERSION}

Usage:
  ct-operator <command> [options]

Commands:
  doctor         Run health checks on the running deployment
  fix            Detect and interactively repair common issues
  readiness      Strict >=9/10 readiness gate; cron/CI suitable
  ballast        Critical-invariant check only (no narration; cron-friendly)
  render         Re-render caddyfile/haproxy/singbox config from the DB
  auto-sync      Credential-lock audit + auto-correct agent
  self-update    Pull a new signed binary from GitHub Releases
  version        Print version and exit

Options:
  --json         Emit structured JSON to stdout instead of human output
  --no-bridge    Suppress the AI incident-bridge prompt on failure

Environment:
  CT_OPERATOR_DEBUG=1   Enable debug-level logging on stderr
`;

interface Flags {
    json: boolean;
    noBridge: boolean;
}

function parseFlags(args: readonly string[]): Flags {
    const flags: Flags = { json: false, noBridge: false };
    for (const a of args) {
        if (a === "--json") flags.json = true;
        else if (a === "--no-bridge") flags.noBridge = true;
    }
    return flags;
}

async function loadTask(cmd: string): Promise<Task | null> {
    switch (cmd) {
        case "doctor": {
            const { DoctorTask } = await import("./tasks/doctor");
            return new DoctorTask();
        }
        case "fix": {
            const { FixTask } = await import("./tasks/fix");
            return new FixTask();
        }
        case "readiness": {
            const { ReadinessTask } = await import("./tasks/readiness");
            return new ReadinessTask();
        }
        case "ballast": {
            const { BallastTask } = await import("./tasks/ballast");
            return new BallastTask();
        }
        case "render": {
            const { RenderTask } = await import("./tasks/render");
            return new RenderTask();
        }
        case "auto-sync": {
            const { AutoSyncTask } = await import("./tasks/auto-sync");
            return new AutoSyncTask();
        }
        case "self-update": {
            const { SelfUpdateTask } = await import("./tasks/self-update");
            return new SelfUpdateTask();
        }
        default:
            return null;
    }
}

async function main(): Promise<number> {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        process.stdout.write(USAGE);
        return 0;
    }
    const cmd = args[0]!;
    if (cmd === "version" || cmd === "--version") {
        process.stdout.write(VERSION + "\n");
        return 0;
    }

    const flags = parseFlags(args.slice(1));
    const task = await loadTask(cmd);
    if (!task) {
        process.stderr.write(`error: unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
    }

    const ctx: RunContext = {
        cwd: process.cwd(),
        env,
        logger: createConsoleLogger(),
        json: flags.json,
        noBridge: flags.noBridge,
        interactive: process.stdin.isTTY === true,
    };

    const runner = new TaskRunner(ctx);
    const result = await runner.run(task);
    return result.code;
}

const code = await main();
process.exit(code);
