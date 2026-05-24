// SPDX-License-Identifier: AGPL-3.0-only
// Better Auth configuration for the Hono admin panel.

import { betterAuth } from "better-auth";
import type { AdminConfig } from "./config";
import type { AdminRole } from "./roles";
import { requireRole } from "./roles";
import type { AdminStorage } from "./storage";
import { openAdminDatabase } from "./storage";
import { redactSensitive } from "../util/redact";

export type AuthInstance = ReturnType<typeof createAuth>;

export interface CurrentSession {
    readonly user: {
        readonly id: string;
        readonly email: string;
        readonly name: string;
        readonly role: AdminRole;
    };
    readonly session: Record<string, unknown>;
}

export function createAuth(config: AdminConfig) {
    return betterAuth({
        appName: "Cool Tunnel Admin",
        database: openAdminDatabase(config.dbPath),
        secret: config.authSecret,
        baseURL: config.baseUrl,
        basePath: "/api/auth",
        trustedOrigins: [...config.trustedOrigins],
        telemetry: { enabled: false },
        emailAndPassword: {
            enabled: true,
            disableSignUp: !config.publicSignup,
            minPasswordLength: 12,
            maxPasswordLength: 128,
            autoSignIn: true,
            revokeSessionsOnPasswordReset: true,
        },
        user: {
            additionalFields: {
                role: {
                    type: "string",
                    required: true,
                    defaultValue: "viewer",
                    validator: {
                        input: {
                            "~standard": {
                                version: 1,
                                vendor: "cool-tunnel",
                                validate: (value: unknown) => {
                                    try {
                                        return { value: requireRole(value) };
                                    } catch (error) {
                                        return {
                                            issues: [{
                                                message: error instanceof Error ? error.message : String(error),
                                            }],
                                        };
                                    }
                                },
                            },
                        },
                    },
                },
            },
        },
        session: {
            expiresIn: 60 * 60 * 24 * 7,
            updateAge: 60 * 60 * 24,
            cookieCache: {
                enabled: false,
            },
        },
        rateLimit: {
            enabled: true,
            storage: "database",
            window: 60,
            max: 120,
            customRules: {
                "/sign-in/email": {
                    window: 60,
                    max: 5,
                },
                "/sign-up/email": config.publicSignup
                    ? {
                        window: 60 * 10,
                        max: 3,
                    }
                    : false,
            },
        },
        advanced: {
            ipAddress: {
                ipAddressHeaders: ["x-forwarded-for"],
                ipv6Subnet: 64,
            },
            useSecureCookies: config.secureCookies,
            cookiePrefix: "ct-admin",
            defaultCookieAttributes: {
                sameSite: "Lax",
                secure: config.secureCookies,
                httpOnly: true,
            },
        },
        logger: {
            level: config.appEnv === "development" ? "debug" : "warn",
            disabled: false,
            log: (level, message, ...args) => {
                const rendered = [message, ...args.map((arg) => {
                    if (typeof arg === "string") return arg;
                    try {
                        return JSON.stringify(arg);
                    } catch {
                        return String(arg);
                    }
                })].join(" ");
                const line = `[better-auth] ${level}: ${redactSensitive(rendered)}\n`;
                if (level === "error" || level === "warn") process.stderr.write(line);
                else if (config.appEnv === "development") process.stderr.write(line);
            },
        },
    });
}

export async function getCurrentSession(auth: ReturnType<typeof createAuth>, headers: Headers): Promise<CurrentSession | null> {
    const session = await auth.api.getSession({ headers });
    if (!session) return null;
    const rawUser = session.user as Record<string, unknown>;
    return {
        session: session.session as Record<string, unknown>,
        user: {
            id: String(rawUser["id"] ?? ""),
            email: String(rawUser["email"] ?? ""),
            name: String(rawUser["name"] ?? ""),
            role: requireRole(rawUser["role"] ?? "viewer"),
        },
    };
}

export async function createAdminUserWithPassword(
    auth: ReturnType<typeof createAuth>,
    storage: AdminStorage,
    input: {
        readonly email: string;
        readonly name: string;
        readonly password: string;
        readonly role: AdminRole;
        readonly request?: Request;
    },
): Promise<{ id: string; email: string; role: AdminRole }> {
    requireRole(input.role);
    if (input.password.length < 12 || input.password.length > 128) {
        throw new Error("password must be 12-128 characters");
    }
    if (input.name.trim().length < 1 || input.name.trim().length > 120) {
        throw new Error("name must be 1-120 characters");
    }
    if (storage.getUserByEmail(input.email)) {
        throw new Error("admin user already exists for that email");
    }
    const ctx = await auth.$context;
    const passwordHash = await ctx.password.hash(input.password);
    const user = storage.createCredentialUser({
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash,
    });
    return { id: user.id, email: user.email, role: user.role };
}

export async function createFirstOwnerWithBootstrapToken(
    auth: ReturnType<typeof createAuth>,
    storage: AdminStorage,
    input: {
        readonly tokenHash: string;
        readonly email: string;
        readonly name: string;
        readonly password: string;
    },
): Promise<{ ok: true; user: { id: string; email: string; role: AdminRole }; tokenId: string } | { ok: false; reason: "owner-exists" | "missing" | "used" | "expired" }> {
    if (input.password.length < 12 || input.password.length > 128) {
        throw new Error("password must be 12-128 characters");
    }
    if (input.name.trim().length < 1 || input.name.trim().length > 120) {
        throw new Error("name must be 1-120 characters");
    }
    const ctx = await auth.$context;
    const passwordHash = await ctx.password.hash(input.password);
    const result = storage.createFirstOwnerWithBootstrapToken({
        tokenHash: input.tokenHash,
        email: input.email,
        name: input.name,
        passwordHash,
    });
    if (!result.ok) return result;
    return {
        ok: true,
        tokenId: result.tokenId,
        user: { id: result.user.id, email: result.user.email, role: result.user.role },
    };
}
