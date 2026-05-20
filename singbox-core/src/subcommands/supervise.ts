// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/subcommands/supervise.ts — sing-box process manager.
//
// Long-running watcher:
//
//   1. Read --config path (default /data/config/singbox.json).
//   2. Spawn `sing-box run -c <config>` as a child process; inherit
//      stdout/stderr so its logs flow into Docker / launchd logs.
//   3. fs.watch the config file. Any change → SIGTERM the child,
//      await graceful exit (up to 5s) or SIGKILL, then respawn.
//   4. Expose a tiny HTTP healthz on 127.0.0.1:<port> reporting the
//      child PID + last-config-mtime + last-spawn timestamp.
//   5. Forward SIGTERM/SIGINT from the parent to the child for
//      clean container stop semantics.
//
// Debounce inotify churn (atomic-write rename + chmod produces
// multiple events) so we don't respawn for one logical write.
//
// Why not use sing-box's built-in SIGHUP reload? sing-box does
// support config reload via signal, but it's not consistent across
// minor versions and skips validation reuse — restart is reliable
// and the new TLS handshake state is fresh, which we want anyway.

import { spawn, type Subprocess } from "bun";
import { existsSync, statSync, watch } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { flagValue, integerFlagValue } from "../util/argv.ts";

interface ParsedArgs {
    readonly config: string;
    readonly singboxBin: string;
    readonly healthzHost: string;
    readonly healthzPort: number;
    readonly bootTimeoutMs: number;
    readonly help: boolean;
}

const DEFAULTS: Readonly<{
    config: string;
    singboxBin: string;
    healthzHost: string;
    healthzPort: number;
    bootTimeoutMs: number;
    debounceMs: number;
    graceMs: number;
}> = {
    config: "/data/config/singbox.json",
    singboxBin: "/usr/local/bin/sing-box",
    healthzHost: "127.0.0.1",
    healthzPort: 9091,
    bootTimeoutMs: 60_000,
    debounceMs: 250,
    graceMs: 5_000,
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
    let config = DEFAULTS.config;
    let singboxBin = DEFAULTS.singboxBin;
    let healthzHost = DEFAULTS.healthzHost;
    let healthzPort = DEFAULTS.healthzPort;
    let bootTimeoutMs = DEFAULTS.bootTimeoutMs;
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--config" || a === "-c") {
            config = flagValue(argv, i, a);
            i++;
        } else if (a === "--singbox-bin") {
            singboxBin = flagValue(argv, i, a);
            i++;
        } else if (a === "--healthz-host") {
            healthzHost = flagValue(argv, i, a);
            i++;
        } else if (a === "--healthz-port") {
            healthzPort = integerFlagValue(argv, i, a, { min: 1, max: 65_535 });
            i++;
        } else if (a === "--boot-timeout-ms") {
            bootTimeoutMs = integerFlagValue(argv, i, a, { min: 1 });
            i++;
        } else if (a === "--help" || a === "-h") help = true;
        else throw new Error(`unknown flag: ${a}`);
    }
    return { config, singboxBin, healthzHost, healthzPort, bootTimeoutMs, help };
}

function usage(): string {
    return [
        "Usage: singbox-core supervise [options]",
        "",
        "  --config/-c        Path to sing-box config.json (default /data/config/singbox.json)",
        "  --singbox-bin      Path to sing-box binary (default /usr/local/bin/sing-box)",
        "  --healthz-host     Bind for healthz HTTP endpoint (default 127.0.0.1)",
        "  --healthz-port     Port for healthz HTTP endpoint (default 9091)",
        "  --boot-timeout-ms  Max wait for config before exit (default 60000)",
    ].join("\n");
}

type State = {
    child: Subprocess | null;
    configMtime: number;
    lastSpawnAt: number;
};

const state: State = { child: null, configMtime: 0, lastSpawnAt: 0 };

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

function safeMtime(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}

function validateConfig(singboxBin: string, configPath: string): boolean {
    // `sing-box check -c <path>` exits 0 on a parseable + semantically
    // valid config. Pre-flight before respawn so a typo in the
    // panel-written config can't crashloop the supervisor.
    const r = spawnSync(singboxBin, ["check", "-c", configPath], { encoding: "utf8" });
    if (r.status !== 0) {
        log("error", "config_validate_failed", {
            exit_code: r.status,
            stderr: (r.stderr || "").slice(0, 400),
        });
        return false;
    }
    return true;
}

async function killChild(child: Subprocess, reason: string): Promise<void> {
    log("info", "killing_singbox", { reason, pid: child.pid });
    child.kill("SIGTERM");
    const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), DEFAULTS.graceMs)),
    ]);
    if (!exited) {
        log("warn", "singbox_did_not_exit_killing", { pid: child.pid });
        child.kill("SIGKILL");
        await child.exited;
    }
}

function spawnSingbox(args: ParsedArgs): void {
    const child = spawn({
        cmd: [args.singboxBin, "run", "-c", args.config],
        stdout: "inherit",
        stderr: "inherit",
        onExit(_p, exitCode, signal) {
            log(exitCode === 0 ? "info" : "warn", "singbox_exited", {
                exit_code: exitCode,
                signal,
            });
        },
    });
    state.child = child;
    state.configMtime = safeMtime(args.config);
    state.lastSpawnAt = Date.now();
    log("info", "spawned_singbox", { pid: child.pid, config: args.config });
}

let restartPending: ReturnType<typeof setTimeout> | null = null;

function scheduleRestart(args: ParsedArgs, reason: string): void {
    if (restartPending) clearTimeout(restartPending);
    restartPending = setTimeout(async () => {
        restartPending = null;
        if (!validateConfig(args.singboxBin, args.config)) {
            log("warn", "restart_skipped_invalid_config", { reason });
            return;
        }
        if (state.child) {
            await killChild(state.child, reason);
            state.child = null;
        }
        spawnSingbox(args);
    }, DEFAULTS.debounceMs);
}

export function isConfigWatchEvent(configPath: string, filename: string | Buffer | null): boolean {
    // fs.watch reports null filenames on some platforms/backends. Treat
    // that as relevant so we never miss a config replacement.
    if (filename == null) return true;
    return filename.toString() === basename(configPath);
}

function startHealthz(args: ParsedArgs): void {
    Bun.serve({
        hostname: args.healthzHost,
        port: args.healthzPort,
        fetch(req) {
            if (new URL(req.url).pathname !== "/healthz") {
                return new Response("not found", { status: 404 });
            }
            const alive = state.child != null && !state.child.killed;
            return Response.json(
                {
                    status: alive ? "ok" : "starting",
                    singbox_pid: state.child?.pid ?? null,
                    config_mtime: state.configMtime,
                    last_spawn_at: state.lastSpawnAt,
                },
                { status: alive ? 200 : 503 },
            );
        },
    });
    log("info", "healthz_listening", { host: args.healthzHost, port: args.healthzPort });
}

export async function runSupervise(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(usage() + "\n");
        return 0;
    }

    log("info", "supervisor_starting", {
        config: args.config,
        singbox_bin: args.singboxBin,
    });

    // Boot wait — the panel may not have rendered the config by the
    // time the container starts. Poll until it exists OR timeout.
    const deadline = Date.now() + args.bootTimeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(args.config) && validateConfig(args.singboxBin, args.config)) {
            spawnSingbox(args);
            // Watch the containing directory, not the config file's inode.
            // render-server writes via temp-file + rename, so watching the
            // file path can become blind after the first atomic replacement.
            watch(dirname(args.config), (_event, filename) => {
                if (isConfigWatchEvent(args.config, filename)) {
                    scheduleRestart(args, "config_changed");
                }
            });
            startHealthz(args);

            // Forward parent signals to the child for clean shutdown.
            const onSignal = (sig: NodeJS.Signals) => async () => {
                log("info", "signal_received", { signal: sig });
                if (state.child) await killChild(state.child, sig);
                process.exit(0);
            };
            process.on("SIGTERM", onSignal("SIGTERM"));
            process.on("SIGINT", onSignal("SIGINT"));
            return await new Promise<number>(() => {
                /* run forever */
            });
        }
        log("info", "waiting_for_config", { path: args.config });
        await new Promise((r) => setTimeout(r, 2000));
    }

    log("error", "boot_timeout", {
        detail: `config not present + valid within ${args.bootTimeoutMs}ms`,
    });
    startHealthz(args);
    process.exit(1);
}
