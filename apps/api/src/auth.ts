// SPDX-License-Identifier: AGPL-3.0-only

import { betterAuth } from "better-auth";
import type { AdminConfig } from "@cool-tunnel/config";
import { openAdminDb } from "@cool-tunnel/db";
import { requireRole, type AdminRole } from "@cool-tunnel/shared";
import { hashPassword, redactSensitive, verifyPassword } from "@cool-tunnel/security";

export type AuthInstance = ReturnType<typeof createAuth>;

// Hard ceiling on session lifetime. The sliding 7-day expiry (with daily
// refresh) can otherwise extend indefinitely while a session stays active;
// this caps the total age regardless of activity.
const SESSION_ABSOLUTE_MAX_MS = 1000 * 60 * 60 * 24 * 30;

export interface CurrentSession {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly username: string;
    readonly name: string;
    readonly role: AdminRole;
    readonly status: "active" | "disabled";
    readonly mustChangePassword: boolean;
  };
  readonly session: Record<string, unknown>;
}

export function createAuth(config: AdminConfig) {
  return betterAuth({
    appName: "Cool Tunnel Admin",
    database: openAdminDb(config.dbPath).db,
    secret: config.authSecret,
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    trustedOrigins: [...config.trustedOrigins],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.publicSignup,
      minPasswordLength: 12,
      maxPasswordLength: 512,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    user: {
      additionalFields: {
        username: { type: "string", required: true, defaultValue: "" },
        role: { type: "string", required: true, defaultValue: "viewer" },
        status: { type: "string", required: true, defaultValue: "active" },
        mustChangePassword: { type: "boolean", required: true, defaultValue: false },
        lastLoginAt: { type: "string", required: false },
        disabledAt: { type: "string", required: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": config.publicSignup ? { window: 600, max: 3 } : false,
      },
    },
    disabledPaths: config.publicSignup ? [] : ["/sign-up/email"],
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
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const db = openAdminDb(config.dbPath).db;
            try {
              const row = db.query<{ status: string }, [string]>("SELECT status FROM user WHERE id = ?").get(String(session.userId));
              if (row?.status !== "active") return false;
            } finally {
              db.close();
            }
          },
        },
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
        const line = `[better-auth] ${level}: ${normalizeAuthLog(redactSensitive(rendered).replace(/("email"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2"))}\n`;
        if (level === "error" || level === "warn" || config.appEnv === "development") process.stderr.write(line);
      },
    },
  });
}

function normalizeAuthLog(message: string): string {
  if (/user not found|invalid password|invalid credentials/i.test(message)) return "authentication failed";
  return message;
}

export async function getCurrentSession(auth: AuthInstance, headers: Headers): Promise<CurrentSession | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const rawSession = session.session as Record<string, unknown>;
  const createdAt = Date.parse(String(rawSession.createdAt ?? ""));
  if (Number.isFinite(createdAt) && Date.now() - createdAt > SESSION_ABSOLUTE_MAX_MS) return null;
  const rawUser = session.user as Record<string, unknown>;
  const status = rawUser.status === "disabled" ? "disabled" : "active";
  if (status !== "active") return null;
  return {
    session: session.session as Record<string, unknown>,
    user: {
      id: String(rawUser.id ?? ""),
      email: String(rawUser.email ?? ""),
      username: String(rawUser.username ?? ""),
      name: String(rawUser.name ?? ""),
      role: requireRole(rawUser.role ?? "viewer"),
      status,
      mustChangePassword: rawUser.mustChangePassword === true || rawUser.mustChangePassword === 1,
    },
  };
}
