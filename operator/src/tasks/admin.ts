// SPDX-License-Identifier: AGPL-3.0-only

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadDotenv, mergeEnv } from "../util/env";

type AdminRole = "owner" | "admin" | "operator" | "viewer";
type UserStatus = "active" | "disabled";

interface AdminConfig {
    readonly baseUrl: string;
    readonly authSecret: string;
    readonly dbPath: string;
    readonly bootstrapTokenTtlMinutes: number;
}

interface AdminUser {
    readonly id: string;
    readonly email: string;
    readonly username: string;
    readonly name: string;
    readonly role: AdminRole;
    readonly status: UserStatus;
    readonly mustChangePassword: boolean;
}

interface StoreErrorLike extends Error {
    readonly status: number;
}

interface StoreErrorConstructor {
    new(code: string, message: string, status?: number): StoreErrorLike;
}

interface AdminStoreLike {
    ensureDefaults(config: AdminConfig): void;
    hasOwner(): boolean;
    listUsers(): AdminUser[];
    createBootstrapToken(config: Pick<AdminConfig, "authSecret">, ttlMinutes: number): Promise<{ token: string; expiresAt: string }>;
    createUser(actor: AdminUser | null, input: {
        email: string;
        username: string;
        name: string;
        passwordHash: string;
        role: AdminRole;
        mustChangePassword?: boolean;
    }): AdminUser;
    disableUser(actor: AdminUser, id: string): AdminUser;
    enableUser(actor: AdminUser, id: string): AdminUser;
    resetPassword(actor: AdminUser, id: string, passwordHash: string): AdminUser;
    updateUser(actor: AdminUser, id: string, input: { role: AdminRole }): AdminUser;
}

interface AdminPackages {
    bootstrapMaterialPath(config: Pick<AdminConfig, "dbPath">): string;
    loadAdminConfig(env: Record<string, string | undefined>): AdminConfig;
    openAdminDb(path: string): { db: { close(): void }; path: string };
    migrateAdminDb(db: unknown): void;
    AdminStore: new(db: unknown, config: AdminConfig) => AdminStoreLike;
    StoreError: StoreErrorConstructor;
    hashPassword(password: string): Promise<string>;
    redactSensitive(text: string): string;
    validatePassword(value: string): boolean;
    validateRole(value: string): value is AdminRole;
}

export class AdminTask implements Task {
    name = "admin";

    async run(ctx: RunContext): Promise<TaskResult> {
        const packages = await loadAdminPackages();
        const args = (ctx.env["_CT_OPERATOR_ADMIN_ARGS"] ?? "").split("\n").filter(Boolean);
        const sub = args[0] ?? "help";
        if (sub === "serve") {
            ctx.logger.error("ct admin serve was removed; run the Better-T-Stack admin API/web apps instead.");
            return { ok: false, code: 2 };
        }
        const dotenv = await loadDotenv([`${ctx.cwd}/.env`]);
        const config = packages.loadAdminConfig(mergeEnv(ctx.env, dotenv?.env ?? null));
        const { db } = packages.openAdminDb(config.dbPath);
        packages.migrateAdminDb(db);
        const store = new packages.AdminStore(db, config);
        store.ensureDefaults(config);
        try {
            if (sub === "migrate") {
                ctx.logger.info(`admin SQLite schema is current: ${config.dbPath}`);
                return { ok: true, code: 0, json: { ok: true, dbPath: config.dbPath } };
            }
            if (sub === "bootstrap") {
                const ttl = ttlArg(args, config.bootstrapTokenTtlMinutes);
                const { token, expiresAt } = await store.createBootstrapToken(config, ttl);
                const materialPath = writeBootstrapMaterial({
                    baseUrl: config.baseUrl,
                    token,
                    expiresAt,
                    path: packages.bootstrapMaterialPath(config),
                });
                ctx.logger.warn("Bootstrap setup material is one-time only and expires. Keep the root-only file local to the VPS.");
                ctx.logger.info(`Setup material written: ${materialPath}`);
                ctx.logger.info(`Setup URL: ${packages.redactSensitive(setupUrl(config.baseUrl, token))}`);
                ctx.logger.info(`Expires: ${expiresAt}`);
                return {
                    ok: true,
                    code: 0,
                    json: { ok: true, materialPath, setupUrl: packages.redactSensitive(setupUrl(config.baseUrl, token)), expiresAt },
                };
            }
            if (sub === "create-owner") {
                const email = requiredArg(args, "--email");
                const username = requiredArg(args, "--username");
                const name = valueArg(args, "--name") ?? username;
                const password = await readPasswordArg(args, ctx.env);
                if (store.hasOwner()) throw new packages.StoreError("bootstrap_disabled", "An active owner already exists; use the admin UI or user management commands for additional accounts.", 403);
                if (!packages.validatePassword(password)) throw new packages.StoreError("invalid_password", "Password must be at least 12 characters.");
                const user = store.createUser(null, {
                    email,
                    username,
                    name,
                    passwordHash: await packages.hashPassword(password),
                    role: "owner",
                    mustChangePassword: false,
                });
                ctx.logger.info(`owner created: ${user.username} <${user.email}>`);
                return { ok: true, code: 0, json: { ok: true, user: publicUser(user) } };
            }
            if (sub === "users") return await this.runUsers(ctx, packages, store, args.slice(1));
            ctx.logger.error(renderAdminUsage());
            return { ok: false, code: 2 };
        } catch (e: unknown) {
            if (e instanceof Error) {
                ctx.logger.error(packages.redactSensitive(e.message));
            } else {
                ctx.logger.error("admin command failed");
            }
            return { ok: false, code: isStoreError(e) ? (e.status >= 500 ? 1 : 2) : 1 };
        } finally {
            db.close();
        }
    }

    private async runUsers(ctx: RunContext, packages: AdminPackages, store: AdminStoreLike, args: readonly string[]): Promise<TaskResult> {
        const sub = args[0] ?? "list";
        if (sub === "list") {
            const users = store.listUsers();
            if (users.length === 0) {
                ctx.logger.info("no admin users found");
                return { ok: true, code: 0 };
            }
            for (const user of users) {
                ctx.logger.info(`${user.username}\t${user.email}\t${user.role}\t${user.status}`);
            }
            return { ok: true, code: 0 };
        }
        const id = requiredArg(args, "--id");
        const actor = store.listUsers().find((u: AdminUser) => u.role === "owner" && u.status === "active") ?? null;
        if (!actor) throw new packages.StoreError("owner_required", "Create an owner before mutating users from the CLI.", 400);
        if (sub === "disable") {
            store.disableUser(actor, id);
            ctx.logger.info("user disabled");
            return { ok: true, code: 0 };
        }
        if (sub === "enable") {
            store.enableUser(actor, id);
            ctx.logger.info("user enabled");
            return { ok: true, code: 0 };
        }
        if (sub === "reset-password") {
            const password = await readPasswordArg(args, ctx.env);
            if (!packages.validatePassword(password)) throw new packages.StoreError("invalid_password", "Password must be at least 12 characters.");
            store.resetPassword(actor, id, await packages.hashPassword(password));
            ctx.logger.info("password reset; user must change it on next login");
            return { ok: true, code: 0 };
        }
        if (sub === "set-role") {
            const role = requiredArg(args, "--role");
            if (!packages.validateRole(role)) throw new packages.StoreError("invalid_role", "Role must be owner, admin, operator, or viewer.", 400);
            store.updateUser(actor, id, { role: role as AdminRole });
            ctx.logger.info("role updated");
            return { ok: true, code: 0 };
        }
        ctx.logger.error(renderAdminUsage());
        return { ok: false, code: 2 };
    }
}

function valueArg(args: readonly string[], name: string): string | null {
    const prefixed = args.find((a) => a.startsWith(`${name}=`));
    if (prefixed) return prefixed.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx >= 0) return args[idx + 1] ?? null;
    return null;
}

function requiredArg(args: readonly string[], name: string): string {
    const value = valueArg(args, name);
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
}

async function readPasswordArg(args: readonly string[], env: Record<string, string> = process.env as Record<string, string>): Promise<string> {
    const fromArg = valueArg(args, "--password");
    if (fromArg) return fromArg;
    const fromEnv = env["CT_ADMIN_PASSWORD"] ?? process.env["CT_ADMIN_PASSWORD"];
    if (fromEnv) return fromEnv;
    if (args.includes("--password-stdin")) {
        const text = await new Response(Bun.stdin.stream()).text();
        const password = text.replace(/\r?\n$/, "");
        if (password) return password;
    }
    throw new Error("Missing password. Use --password-stdin or CT_ADMIN_PASSWORD; --password is supported only for controlled rescue shells.");
}

function ttlArg(args: readonly string[], fallback: number): number {
    const raw = valueArg(args, "--ttl-minutes");
    if (!raw) return fallback;
    const ttl = Number(raw);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) {
        throw new Error("TTL must be an integer from 1 to 120 minutes.");
    }
    return ttl;
}

function setupUrl(baseUrl: string, token: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/setup?token=${encodeURIComponent(token)}`;
}

function writeBootstrapMaterial(input: { baseUrl: string; token: string; expiresAt: string; path: string }): string {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    const tmp = `${input.path}.tmp-${process.pid}-${Date.now()}`;
    const body = [
        "# Cool Tunnel one-time first-owner setup material",
        "# Root-only local file. Delete it after the first owner is created.",
        "# Open setup_url once; the API immediately stores token in an HttpOnly cookie and redirects to /setup.",
        `setup_url=${setupUrl(input.baseUrl, input.token)}`,
        `token=${input.token}`,
        `expires_at=${input.expiresAt}`,
        "",
    ].join("\n");
    try {
        writeFileSync(tmp, body, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, input.path);
        chmodSync(input.path, 0o600);
    } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }
    return input.path;
}

function publicUser(user: AdminUser): Pick<AdminUser, "id" | "email" | "username" | "name" | "role" | "status" | "mustChangePassword"> {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
        status: user.status,
        mustChangePassword: user.mustChangePassword,
    };
}

function isStoreError(value: unknown): value is StoreErrorLike {
    return value instanceof Error && typeof (value as { status?: unknown }).status === "number";
}

async function loadAdminPackages(): Promise<AdminPackages> {
    // Specifiers MUST be string literals. `bun build --compile` only bundles
    // dynamic imports it can resolve statically; a computed specifier (a
    // template string built from a variable) is invisible to the bundler, so
    // the packages are absent from the compiled binary and every `ct admin`
    // subcommand dies at runtime with `Cannot find module '@cool-tunnel/config'
    // from '/$bunfs/root/ct-operator-...'`.
    const [config, db, security] = await Promise.all([
        import("@cool-tunnel/config") as unknown as Promise<Pick<AdminPackages, "bootstrapMaterialPath" | "loadAdminConfig">>,
        import("@cool-tunnel/db") as unknown as Promise<Pick<AdminPackages, "openAdminDb" | "migrateAdminDb" | "AdminStore" | "StoreError">>,
        import("@cool-tunnel/security") as unknown as Promise<Pick<AdminPackages, "hashPassword" | "redactSensitive" | "validatePassword" | "validateRole">>,
    ]);
    return {
        bootstrapMaterialPath: config.bootstrapMaterialPath,
        loadAdminConfig: config.loadAdminConfig,
        openAdminDb: db.openAdminDb,
        migrateAdminDb: db.migrateAdminDb,
        AdminStore: db.AdminStore,
        StoreError: db.StoreError,
        hashPassword: security.hashPassword,
        redactSensitive: security.redactSensitive,
        validatePassword: security.validatePassword,
        validateRole: security.validateRole,
    };
}

function renderAdminUsage(): string {
    return `Usage:
  ct-operator admin migrate
  ct-operator admin bootstrap [--ttl-minutes 30]
  ct-operator admin create-owner --email EMAIL --username NAME --password-stdin
  ct-operator admin users list
  ct-operator admin users disable --id ID
  ct-operator admin users enable --id ID
  ct-operator admin users reset-password --id ID --password-stdin
  ct-operator admin users set-role --id ID --role owner|admin|operator|viewer`;
}
