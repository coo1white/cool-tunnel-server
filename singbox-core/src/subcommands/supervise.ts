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
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
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
    pollMs: number;
    graceMs: number;
}> = {
    config: "/data/config/singbox.json",
    singboxBin: "/usr/local/bin/sing-box",
    healthzHost: "127.0.0.1",
    healthzPort: 9091,
    bootTimeoutMs: 60_000,
    debounceMs: 250,
    pollMs: 2_000,
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
    activeConfig: string | null;
};

const state: State = { child: null, configMtime: 0, lastSpawnAt: 0, activeConfig: null };

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

type PreparedConfig = {
    path: string;
    migratedLegacyDomainStrategy: boolean;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableRuntimeConfigPath(configPath: string): string {
    return `/tmp/singbox-core-supervise/${basename(configPath)}`;
}

export function migrateLegacyDomainStrategyConfig(config: unknown): boolean {
    if (!isRecord(config) || !Array.isArray(config["outbounds"])) return false;

    let changed = false;
    const outbounds = config["outbounds"];
    for (const outbound of outbounds) {
        if (!isRecord(outbound) || outbound["type"] !== "direct") continue;
        if ("domain_strategy" in outbound) {
            delete outbound["domain_strategy"];
            changed = true;
        }
        if (!isRecord(outbound["domain_resolver"])) {
            outbound["domain_resolver"] = {
                server: "local-dns",
                strategy: "ipv4_only",
            };
            changed = true;
        } else {
            if (outbound["domain_resolver"]["strategy"] !== "ipv4_only") {
                outbound["domain_resolver"]["strategy"] = "ipv4_only";
                changed = true;
            }
        }
    }

    if (!changed) return false;

    const dns = isRecord(config["dns"]) ? config["dns"] : {};
    const servers = Array.isArray(dns["servers"]) ? dns["servers"] : [];
    if (!servers.some((server) => isRecord(server) && server["tag"] === "local-dns")) {
        servers.push({ type: "local", tag: "local-dns" });
    }
    dns["servers"] = servers;
    config["dns"] = dns;
    return true;
}

function prepareConfig(configPath: string): PreparedConfig | null {
    try {
        const raw = readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!migrateLegacyDomainStrategyConfig(parsed)) {
            return { path: configPath, migratedLegacyDomainStrategy: false };
        }

        const runtimePath = stableRuntimeConfigPath(configPath);
        mkdirSync(dirname(runtimePath), { recursive: true });
        writeFileSync(runtimePath, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o644 });
        log("warn", "legacy_domain_strategy_migrated", {
            source_config: configPath,
            runtime_config: runtimePath,
        });
        return { path: runtimePath, migratedLegacyDomainStrategy: true };
    } catch (err) {
        log("error", "config_prepare_failed", {
            config: configPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

function prepareAndValidateConfig(singboxBin: string, configPath: string): PreparedConfig | null {
    const prepared = prepareConfig(configPath);
    if (!prepared) return null;

    // `sing-box check -c <path>` exits 0 on a parseable + semantically
    // valid config. Pre-flight before respawn so a typo in the
    // panel-written config can't crashloop the supervisor.
    const r = spawnSync(singboxBin, ["check", "-c", prepared.path], { encoding: "utf8" });
    if (r.status !== 0) {
        log("error", "config_validate_failed", {
            config: prepared.path,
            exit_code: r.status,
            stderr: (r.stderr || "").slice(0, 400),
        });
        return null;
    }
    return prepared;
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

function spawnSingbox(args: ParsedArgs, prepared: PreparedConfig): void {
    const child = spawn({
        cmd: [args.singboxBin, "run", "-c", prepared.path],
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
    state.activeConfig = prepared.path;
    state.lastSpawnAt = Date.now();
    log("info", "spawned_singbox", {
        pid: child.pid,
        config: prepared.path,
        source_config: args.config,
        migrated_legacy_domain_strategy: prepared.migratedLegacyDomainStrategy,
    });
}

let restartPending: ReturnType<typeof setTimeout> | null = null;

function scheduleRestart(args: ParsedArgs, reason: string): void {
    if (restartPending) clearTimeout(restartPending);
    restartPending = setTimeout(async () => {
        restartPending = null;
        const prepared = prepareAndValidateConfig(args.singboxBin, args.config);
        if (!prepared) {
            log("warn", "restart_skipped_invalid_config", { reason });
            return;
        }
        if (state.child) {
            await killChild(state.child, reason);
            state.child = null;
        }
        spawnSingbox(args, prepared);
    }, DEFAULTS.debounceMs);
}

export function isConfigWatchEvent(configPath: string, filename: string | Buffer | null): boolean {
    // fs.watch reports null filenames on some platforms/backends. Treat
    // that as relevant so we never miss a config replacement.
    if (filename == null) return true;
    return filename.toString() === basename(configPath);
}

export function shouldPollConfigRestart(lastSeenMtime: number, currentMtime: number): boolean {
    return currentMtime > 0 && currentMtime !== lastSeenMtime;
}

function startConfigPoller(args: ParsedArgs): void {
    let lastSeenMtime = safeMtime(args.config);
    setInterval(() => {
        const currentMtime = safeMtime(args.config);
        if (!shouldPollConfigRestart(lastSeenMtime, currentMtime)) {
            return;
        }

        lastSeenMtime = currentMtime;
        scheduleRestart(args, "config_poll_changed");
    }, DEFAULTS.pollMs);
    log("info", "config_polling_enabled", {
        config: args.config,
        interval_ms: DEFAULTS.pollMs,
    });
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
                    active_config: state.activeConfig,
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
        const prepared = existsSync(args.config)
            ? prepareAndValidateConfig(args.singboxBin, args.config)
            : null;
        if (prepared) {
            spawnSingbox(args, prepared);
            // Watch the containing directory, not the config file's inode.
            // render-server writes via temp-file + rename, so watching the
            // file path can become blind after the first atomic replacement.
            watch(dirname(args.config), (_event, filename) => {
                if (isConfigWatchEvent(args.config, filename)) {
                    scheduleRestart(args, "config_changed");
                }
            });
            // Docker named volumes + atomic rename usually work with
            // fs.watch, but provider kernels/filesystems occasionally
            // miss the directory event. Polling mtime is the cheap
            // safety net that closes the "rendered file changed, live
            // sing-box process still old" drift window.
            startConfigPoller(args);
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
