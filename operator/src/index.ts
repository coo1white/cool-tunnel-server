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
  install        First-time bootstrap on a fresh Debian VPS
  doctor         Run health checks on the running deployment
  render         Re-render caddyfile/singbox config from the DB
  backup         Snapshot SQLite + .env + Caddy ACME state into backups/
  restore <p>    Restore a deployment from a backup tarball
  update         Pull a new release, load release images, hot-swap
  auto-update    Unattended release-pulling agent (default OFF)
  admin          Bootstrap and manage admin accounts from the CLI
  help [topic]   Operator mini-manual; no args lists topics
  version        Print version and exit

Options:
  --json         Emit structured JSON to stdout instead of human output
Environment:
  CT_OPERATOR_DEBUG=1   Enable debug-level logging on stderr
`;

interface Flags {
    json: boolean;
}

function parseFlags(args: readonly string[]): Flags {
    const flags: Flags = { json: false };
    for (const a of args) {
        if (a === "--json") flags.json = true;
    }
    return flags;
}

async function loadTask(cmd: string): Promise<Task | null> {
    switch (cmd) {
        case "install": {
            const { InstallTask } = await import("./tasks/install");
            return new InstallTask();
        }
        case "doctor": {
            const { DoctorTask } = await import("./tasks/doctor");
            return new DoctorTask();
        }
        case "render": {
            const { RenderTask } = await import("./tasks/render");
            return new RenderTask();
        }
        case "backup": {
            const { BackupTask } = await import("./tasks/backup");
            return new BackupTask();
        }
        case "restore": {
            const { RestoreTask } = await import("./tasks/restore");
            return new RestoreTask();
        }
        case "update": {
            const { UpdateTask } = await import("./tasks/update");
            return new UpdateTask();
        }
        case "auto-update": {
            const { AutoUpdateTask } = await import("./tasks/auto-update");
            return new AutoUpdateTask();
        }
        case "help": {
            const { HelpTask } = await import("./tasks/help");
            return new HelpTask();
        }
        case "admin": {
            const { AdminTask } = await import("./tasks/admin");
            return new AdminTask();
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
    // The compiled binary's BUILD_VERSION is a TS-level constant
    // (set via `bun build --compile --define`). Inject it under a
    // reserved internal key so tasks can compare themselves against
    // root package.json when needed.
    env["_CT_OPERATOR_OWN_VERSION"] = VERSION;
    if (cmd === "admin") {
        env["_CT_OPERATOR_ADMIN_ARGS"] = args.slice(1).join("\n");
    }

    const ctx: RunContext = {
        cwd: process.cwd(),
        env,
        logger: createConsoleLogger(),
        json: flags.json,
        interactive: process.stdin.isTTY === true,
    };

    const runner = new TaskRunner(ctx);
    const result = await runner.run(task);
    return result.code;
}

const code = await main();
process.exit(code);
