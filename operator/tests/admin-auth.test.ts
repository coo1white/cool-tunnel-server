// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { hashBootstrapToken } from "../src/admin/bootstrap";
import { loadAdminConfig } from "../src/admin/config";
import { createAdminUserWithPassword, createAuth, createFirstOwnerWithBootstrapToken } from "../src/admin/auth";
import { createAdminApp } from "../src/admin/server";
import { AdminStorage, backupAdminSqlite } from "../src/admin/storage";
import { isCoreAction } from "../src/admin/core-boundary";
import { redactSensitive } from "../src/util/redact";

const SECRET = "test-better-auth-secret-".padEnd(43, "x");

function tempDbPath(): { dir: string; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "ct-admin-test-"));
    return { dir, dbPath: join(dir, "admin.sqlite") };
}

function baseEnv(dbPath: string, extra: Record<string, string> = {}) {
    return {
        CT_ADMIN_ENV: "test",
        BETTER_AUTH_SECRET: SECRET,
        CT_ADMIN_DB_PATH: dbPath,
        DOMAIN: "proxy.example.com",
        PANEL_DOMAIN: "panel.example.com",
        ACME_EMAIL: "ops@example.com",
        REALITY_PRIVATE_KEY: "A".repeat(43),
        REALITY_PUBLIC_KEY: "B".repeat(43),
        ...extra,
    };
}

test("first-owner bootstrap creates one owner and rejects token reuse", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath));
        const storage = new AdminStorage(dbPath);
        storage.migrate();
        const auth = createAuth(config);
        const token = "bootstrap-token-".padEnd(40, "x");
        const tokenHash = await hashBootstrapToken(token, config.authSecret);
        storage.createBootstrapToken(tokenHash, new Date(Date.now() + 60_000));

        const created = await createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash,
            email: "owner@example.com",
            name: "Owner",
            password: "correct horse battery staple",
        });
        expect(created.ok).toBe(true);
        expect(storage.ownerCount()).toBe(1);
        expect(storage.listUsers()[0]?.role).toBe("owner");

        const reused = await createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash,
            email: "second@example.com",
            name: "Second",
            password: "correct horse battery staple",
        });
        expect(reused).toEqual({ ok: false, reason: "owner-exists" });
        expect(storage.ownerCount()).toBe(1);
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("expired bootstrap token is rejected without creating an owner", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath));
        const storage = new AdminStorage(dbPath);
        storage.migrate();
        const auth = createAuth(config);
        const tokenHash = await hashBootstrapToken("expired-token-".padEnd(40, "x"), config.authSecret);
        storage.createBootstrapToken(tokenHash, new Date(Date.now() - 1_000));

        const result = await createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash,
            email: "owner@example.com",
            name: "Owner",
            password: "correct horse battery staple",
        });
        expect(result).toEqual({ ok: false, reason: "expired" });
        expect(storage.ownerCount()).toBe(0);
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("failed duplicate-email bootstrap does not consume the token", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath));
        const storage = new AdminStorage(dbPath);
        storage.migrate();
        const auth = createAuth(config);
        const tokenHash = await hashBootstrapToken("token-not-burned-".padEnd(40, "x"), config.authSecret);
        storage.createBootstrapToken(tokenHash, new Date(Date.now() + 60_000));
        storage.createCredentialUser({
            email: "owner@example.com",
            name: "Existing",
            role: "viewer",
            passwordHash: "hash",
        });

        await expect(createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash,
            email: "owner@example.com",
            name: "Owner",
            password: "correct horse battery staple",
        })).rejects.toThrow("admin user already exists");

        expect(storage.bootstrapTokenStatus(tokenHash)).toBe("valid");
        expect(storage.ownerCount()).toBe(0);
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("last owner cannot be demoted or deleted", () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const storage = new AdminStorage(dbPath);
        storage.migrate();
        const owner = storage.createCredentialUser({
            email: "owner@example.com",
            name: "Owner",
            role: "owner",
            passwordHash: "hash",
        });

        expect(() => storage.setUserRole(owner.id, "admin")).toThrow("last owner");
        expect(() => storage.deleteUser(owner.id)).toThrow("last owner");
        expect(storage.ownerCount()).toBe(1);
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("custom admin mutations reject cross-site origin", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "https://panel.example.com" }));
        const { app, storage } = createAdminApp(config);
        const response = await app.request("/setup/bootstrap", {
            method: "POST",
            headers: {
                origin: "https://evil.example.net",
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(),
        });

        expect(response.status).toBe(403);
        expect(await response.text()).toContain("Request origin is not trusted");
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("disabled public signup is reflected in Better Auth config", () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath));
        const auth = createAuth(config);
        expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
        expect(auth.options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 60, max: 5 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Better Auth login sets httpOnly session cookie and unlocks protected admin route", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage } = createAdminApp(config);
        const auth = createAuth(config);
        const tokenHash = await hashBootstrapToken("bootstrap-login-".padEnd(40, "x"), config.authSecret);
        storage.createBootstrapToken(tokenHash, new Date(Date.now() + 60_000));
        await createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash,
            email: "owner@example.com",
            name: "Owner",
            password: "correct horse battery staple",
        });

        const denied = await app.request("/api/admin/session");
        expect(denied.status).toBe(401);

        const signIn = await app.request("/api/auth/sign-in/email", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-forwarded-for": "203.0.113.10",
            },
            body: JSON.stringify({
                email: "owner@example.com",
                password: "correct horse battery staple",
                rememberMe: true,
            }),
        });
        expect(signIn.status).toBe(200);
        const setCookie = signIn.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("ct-admin.session_token=");
        expect(setCookie.toLowerCase()).toContain("httponly");
        expect(setCookie.toLowerCase()).toContain("samesite=lax");
        expect(setCookie).not.toContain("localStorage");

        const cookie = setCookie.split(",").map((part) => part.trim()).find((part) => part.startsWith("ct-admin.session_token="))?.split(";")[0];
        expect(cookie).toBeTruthy();
        const session = await app.request("/api/admin/session", {
            headers: { cookie: cookie ?? "" },
        });
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ ok: true, user: { email: "owner@example.com", role: "owner" } });
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("role authorization blocks viewer from protected admin actions", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage, auth } = createAdminApp(config);
        const user = await createAdminUserWithPassword(auth, storage, {
            email: "viewer@example.com",
            name: "Viewer",
            password: "correct horse battery staple",
            role: "viewer",
        });
        expect(user.role).toBe("viewer");

        const signIn = await app.request("/api/auth/sign-in/email", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-forwarded-for": "203.0.113.11",
            },
            body: JSON.stringify({
                email: "viewer@example.com",
                password: "correct horse battery staple",
            }),
        });
        const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const response = await app.request("/api/admin/users", { headers: { cookie } });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("auth config uses Caddy-provided forwarded IP for Better Auth rate limiting", () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath));
        const auth = createAuth(config);
        expect(auth.options.advanced?.ipAddress).toEqual({
            ipAddressHeaders: ["x-forwarded-for"],
            ipv6Subnet: 64,
        });
        expect((auth.options.advanced as Record<string, unknown>)["trustedProxyHeaders"]).toBeUndefined();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("admin migrations are idempotent and SQLite backup includes WAL writes", () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const storage = new AdminStorage(dbPath);
        storage.migrate();
        storage.migrate();
        storage.createCredentialUser({
            email: "backup@example.com",
            name: "Backup",
            role: "admin",
            passwordHash: "hash",
        });
        const dest = join(dir, "admin-backup.sqlite");
        backupAdminSqlite(dbPath, dest);
        expect(statSync(dest).mode & 0o777).toBe(0o600);

        const db = new Database(dest, { readonly: true, strict: true });
        try {
            const row = db.query<{ role: string }, [string]>("SELECT role FROM user WHERE email = ?").get("backup@example.com");
            expect(row?.role).toBe("admin");
        } finally {
            db.close();
        }
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Bun/Rust boundary rejects unknown actions and redaction masks bootstrap URLs", () => {
    expect(isCoreAction("doctor")).toBe(true);
    expect(isCoreAction("restart-services")).toBe(true);
    expect(isCoreAction("rm -rf /")).toBe(false);
    expect(redactSensitive("open /setup/bootstrap?token=ctbt_secretTokenValue1234567890")).toContain("token=<redacted>");
});

test("production secure cookies require an https admin base URL", () => {
    const { dir, dbPath } = tempDbPath();
    try {
        expect(() => loadAdminConfig(baseEnv(dbPath, {
            CT_ADMIN_ENV: "production",
            BETTER_AUTH_URL: "http://panel.example.com",
        }))).toThrow("https://");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
