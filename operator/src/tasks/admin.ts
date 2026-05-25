// SPDX-License-Identifier: AGPL-3.0-only
// `ct admin ...` commands for the Bun/Hono admin panel.

import { chmodSync, writeFileSync } from "node:fs";
import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { loadDotenv, mergeEnv } from "../util/env";
import { loadAdminConfig } from "../admin/config";
import { AdminStorage, ensureServerConfig } from "../admin/storage";
import { bootstrapMaterialPath, issueBootstrapToken } from "../admin/bootstrap";
import { createAuth, hashAdminPassword } from "../admin/auth";
import { startAdminServer } from "../admin/server";
import { redactSensitive } from "../util/redact";
import type { AdminUserRow } from "../admin/storage";

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
  ct admin users disable <email-or-id>
  ct admin users enable <email-or-id>
  ct admin users reset-password <email-or-id>
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
                    const secretFile = bootstrapMaterialPath(config);
                    writeFileSync(secretFile, [
                        "# Cool Tunnel first-owner bootstrap material",
                        "# Treat this file as a secret. The token is one-time-use and expires automatically.",
                        `setup_page=${issue.setupPageUrl}`,
                        `token=${issue.token}`,
                        "",
                    ].join("\n"), { mode: 0o600 });
                    try {
                        chmodSync(secretFile, 0o600);
                    } catch {
                        // Best effort for bind mounts.
                    }
                    const message = [
                        "First-owner bootstrap token issued.",
                        "",
                        "The one-time setup page and token were written to a root-only file.",
                        `  ${secretFile}`,
                        "",
                        "Copy the token over your trusted SSH session, open the setup page, then delete the file:",
                        `  sudo cat ${secretFile}`,
                        `  sudo rm -f ${secretFile}`,
                        "",
                        `Expires: ${issue.expiresAt.toISOString()}`,
                        "",
                        "Setup page: https://<PANEL_DOMAIN>/setup/bootstrap",
                        "No password or raw token was printed. You will choose the owner password in the browser.",
                    ].join("\n");
                    process.stdout.write(message + "\n");
                    return {
                        ok: true,
                        code: 0,
                        summary: "bootstrap token issued",
                        json: {
                            ok: true,
                            secretFile,
                            setupPageUrl: "https://<PANEL_DOMAIN>/setup/bootstrap",
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
                    if (result.stdout) process.stdout.write(redactSensitive(result.stdout));
                    if (result.stderr) process.stderr.write(redactSensitive(result.stderr));
                    return { ok: result.ok, code: result.code, summary: result.ok ? "doctor ok" : "doctor failed" };
                }
                case "render-caddyfile": {
                    const { runCoreAction } = await import("../admin/core-boundary");
                    const result = await runCoreAction("render-caddyfile", config);
                    if (result.stdout) process.stdout.write(redactSensitive(result.stdout));
                    if (result.stderr) process.stderr.write(redactSensitive(result.stderr));
                    return { ok: result.ok, code: result.code, summary: result.ok ? "caddyfile rendered" : "caddyfile render failed" };
                }
                case "render-singbox": {
                    const { runCoreAction } = await import("../admin/core-boundary");
                    const result = await runCoreAction("render-singbox", config);
                    if (result.stdout) process.stdout.write(redactSensitive(result.stdout));
                    if (result.stderr) process.stderr.write(redactSensitive(result.stderr));
                    return { ok: result.ok, code: result.code, summary: result.ok ? "singbox rendered" : "singbox render failed" };
                }
                case "users": {
                    const sub = parsed.rest[0] ?? "list";
                    if (sub === "list") {
                        const users = storage.listUsers();
                        if (ctx.json) return { ok: true, code: 0, summary: `${users.length} users`, json: { ok: true, users } };
                        for (const user of users) {
                            process.stdout.write(`${user.email}\t${user.role}\t${user.status}\t${user.name}\n`);
                        }
                        return { ok: true, code: 0, summary: `${users.length} users` };
                    }
                    if (sub === "disable" || sub === "enable") {
                        const user = findAdminUser(storage, parsed.rest[1] ?? "");
                        if (!user) {
                            ctx.logger.error(`admin users ${sub}: provide an existing email or user id`);
                            return { ok: false, code: 2, summary: "missing user" };
                        }
                        storage.setUserStatus(user.id, sub === "disable" ? "disabled" : "active");
                        storage.audit(null, `user.${sub}d`, "user", user.id, { email: user.email, role: user.role, via: "cli" });
                        if (ctx.json) return { ok: true, code: 0, summary: `user ${sub}d`, json: { ok: true, user: storage.getUserById(user.id) } };
                        process.stdout.write(`admin user ${sub}d: ${user.email}\n`);
                        return { ok: true, code: 0, summary: `user ${sub}d` };
                    }
                    if (sub === "reset-password") {
                        const user = findAdminUser(storage, parsed.rest[1] ?? "");
                        const password = parsed.rest[2] ?? ctx.env["CT_ADMIN_TEMP_PASSWORD"] ?? "";
                        if (!user) {
                            ctx.logger.error("admin users reset-password: provide an existing email or user id");
                            return { ok: false, code: 2, summary: "missing user" };
                        }
                        if (password.length < 12 || password.length > 128) {
                            ctx.logger.error("admin users reset-password: set CT_ADMIN_TEMP_PASSWORD or pass a 12-128 character temporary password");
                            return { ok: false, code: 2, summary: "missing temporary password" };
                        }
                        const auth = createAuth(config);
                        const passwordHash = await hashAdminPassword(auth, password);
                        storage.setUserPasswordHash(user.id, passwordHash);
                        storage.audit(null, "user.password_reset", "user", user.id, { email: user.email, role: user.role, via: "cli" });
                        if (ctx.json) return { ok: true, code: 0, summary: "password reset", json: { ok: true } };
                        process.stdout.write(`admin user password reset: ${user.email}\n`);
                        process.stdout.write("Share the temporary password out-of-band; it was not printed or logged.\n");
                        return { ok: true, code: 0, summary: "password reset" };
                    }
                    {
                        ctx.logger.error(`admin users: unknown subcommand "${sub}"`);
                        return { ok: false, code: 2, summary: "bad args" };
                    }
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

function findAdminUser(storage: AdminStorage, value: string): AdminUserRow | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const byEmail = trimmed.includes("@") ? storage.getUserByEmail(trimmed) : null;
    if (byEmail) return byEmail;
    try {
        return storage.getUserById(trimmed);
    } catch {
        return null;
    }
}
