// SPDX-License-Identifier: AGPL-3.0-only
// `ct admin ...` commands for the Bun/Hono admin panel.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { loadDotenv, mergeEnv } from "../util/env";
import { loadAdminConfig } from "../admin/config";
import { AdminStorage, ensureServerConfig } from "../admin/storage";
import { issueBootstrapToken } from "../admin/bootstrap";
import { startAdminServer } from "../admin/server";

type AdminCommand = "bootstrap" | "create-owner" | "serve" | "migrate" | "users" | "doctor" | "render-caddyfile" | "render-singbox";

export function parseAdminArgs(argv: readonly string[]): { command: AdminCommand; rest: string[] } | string {
    const adminIdx = argv.indexOf("admin");
    const rest = (adminIdx >= 0 ? argv.slice(adminIdx + 1) : argv.slice(2)).filter((arg) => arg !== "--json");
    const command = rest[0] ?? "help";
    if (command === "bootstrap" || command === "create-owner" || command === "serve" || command === "migrate" || command === "users" || command === "doctor" || command === "render-caddyfile" || command === "render-singbox") {
        return { command, rest: rest.slice(1) };
    }
    if (command === "help" || command === "--help" || command === "-h") {
        return "help";
    }
    return `admin: unknown command "${command}"`;
}

export function adminUsage(): string {
    return `ct admin — admin panel management

Usage:
  ct admin bootstrap       Issue a one-time first-owner setup token
  ct admin create-owner    Alias for bootstrap; create owner in browser
  ct admin serve           Start the Bun/Hono admin web server
  ct admin migrate         Run SQLite admin/auth migrations
  ct admin users list      List admin accounts
  ct admin doctor          Run the admin/Rust boundary health check
  ct admin render-caddyfile
  ct admin render-singbox
`;
}

export class AdminTask implements Task {
    readonly name = "admin";

    async run(ctx: RunContext): Promise<TaskResult> {
        const parsed = parseAdminArgs(process.argv);
        if (parsed === "help") {
            process.stdout.write(adminUsage());
            return { ok: true, code: 0, summary: "help" };
        }
        if (typeof parsed === "string") {
            ctx.logger.error(parsed);
            process.stderr.write(adminUsage());
            return { ok: false, code: 2, summary: "bad args" };
        }

        const loaded = await loadDotenv([`${ctx.cwd}/.env`, ".env"]);
        const env = mergeEnv(ctx.env, loaded?.env ?? null);
        const config = loadAdminConfig(env);
        const storage = new AdminStorage(config.dbPath);
        storage.migrate();
        ensureServerConfig(storage, config);

        try {
            switch (parsed.command) {
                case "bootstrap":
                case "create-owner": {
                    const issue = await issueBootstrapToken(storage, config);
                    const message = [
                        "First-owner bootstrap token issued.",
                        "",
                        "Open this URL from your admin workstation:",
                        `  ${issue.setupUrl}`,
                        "",
                        "Or paste this one-time token into /setup/bootstrap:",
                        `  ${issue.token}`,
                        "",
                        `Expires: ${issue.expiresAt.toISOString()}`,
                        "",
                        "No password was generated or printed. You will choose the owner password in the browser.",
                    ].join("\n");
                    process.stdout.write(message + "\n");
                    return {
                        ok: true,
                        code: 0,
                        summary: "bootstrap token issued",
                        json: {
                            ok: true,
                            token: issue.token,
                            setupUrl: issue.setupUrl,
                            expiresAt: issue.expiresAt.toISOString(),
                        },
                    };
                }
                case "migrate":
                    process.stdout.write(`admin database migrated: ${config.dbPath}\n`);
                    return { ok: true, code: 0, summary: "migrated", json: { ok: true, dbPath: config.dbPath } };
                case "doctor": {
                    const { runCoreAction } = await import("../admin/core-boundary");
                    const result = await runCoreAction("doctor", config);
                    if (result.stdout) process.stdout.write(result.stdout);
                    if (result.stderr) process.stderr.write(result.stderr);
                    return { ok: result.ok, code: result.code, summary: result.ok ? "doctor ok" : "doctor failed" };
                }
                case "render-caddyfile": {
                    const { runCoreAction } = await import("../admin/core-boundary");
                    const result = await runCoreAction("render-caddyfile", config);
                    if (result.stdout) process.stdout.write(result.stdout);
                    if (result.stderr) process.stderr.write(result.stderr);
                    return { ok: result.ok, code: result.code, summary: result.ok ? "caddyfile rendered" : "caddyfile render failed" };
                }
                case "render-singbox": {
                    const { runCoreAction } = await import("../admin/core-boundary");
                    const result = await runCoreAction("render-singbox", config);
                    if (result.stdout) process.stdout.write(result.stdout);
                    if (result.stderr) process.stderr.write(result.stderr);
                    return { ok: result.ok, code: result.code, summary: result.ok ? "singbox rendered" : "singbox render failed" };
                }
                case "users": {
                    const sub = parsed.rest[0] ?? "list";
                    if (sub !== "list") {
                        ctx.logger.error(`admin users: unknown subcommand "${sub}"`);
                        return { ok: false, code: 2, summary: "bad args" };
                    }
                    const users = storage.listUsers();
                    if (ctx.json) return { ok: true, code: 0, summary: `${users.length} users`, json: { ok: true, users } };
                    for (const user of users) {
                        process.stdout.write(`${user.email}\t${user.role}\t${user.name}\n`);
                    }
                    return { ok: true, code: 0, summary: `${users.length} users` };
                }
                case "serve":
                    storage.close();
                    startAdminServer(config);
                    await new Promise(() => {
                        // Keep Bun.serve alive under the task runner.
                    });
                    return { ok: true, code: 0, summary: "served" };
            }
            return { ok: false, code: 2, summary: "bad args" };
        } finally {
            if (parsed.command !== "serve") {
                storage.close();
            } else {
                try {
                    storage.close();
                } catch {
                    // Already closed before serve.
                }
            }
        }
    }
}
