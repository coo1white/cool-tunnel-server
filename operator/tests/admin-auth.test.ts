// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bootstrapMaterialPath, hashBootstrapToken } from "../src/admin/bootstrap";
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

test("browser login form posts without exposing credentials in URL", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage } = createAdminApp(config);

        const leaked = await app.request("/login?email=owner@example.com&password=super-secret");
        expect(leaked.status).toBe(303);
        expect(leaked.headers.get("location")).toBe("/login");
        expect(leaked.headers.get("cache-control")).toBe("no-store");
        expect(leaked.headers.get("referrer-policy")).toBe("no-referrer");
        expect(await leaked.text()).not.toContain("super-secret");

        const page = await app.request("/login");
        const body = await page.text();
        expect(page.status).toBe(200);
        expect(page.headers.get("referrer-policy")).toBe("no-referrer");
        expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
        expect(page.headers.get("cache-control")).toBe("no-store");
        expect(body).toContain('method="post"');
        expect(body).toContain('action="/login"');
        expect(body).toContain('name="csrf"');
        expect(body).not.toContain("onsubmit=");
        expect(body).not.toContain("signIn(");
        expect(body).not.toContain("localStorage");
        const csrfCookie = page.headers.get("set-cookie") ?? "";
        expect(csrfCookie).toContain("ct_login_csrf=");
        expect(csrfCookie).toContain("HttpOnly");
        expect(csrfCookie).toContain("SameSite=Strict");
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("admin dashboard exact path requires an authenticated session", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage } = createAdminApp(config);
        const response = await app.request("/admin");
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("all admin API routes require an authenticated session", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage } = createAdminApp(config);
        for (const [path, init] of [
            ["/api/admin/session", undefined],
            ["/api/admin/users", undefined],
            ["/api/admin/doctor", { method: "POST" }],
            ["/api/admin/actions/update", { method: "POST" }],
        ] as const) {
            const response = await app.request(path, init);
            expect(response.status, path).toBe(401);
            expect(await response.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
        }
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("server-side login fallback redirects with session cookie and generic failure", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage, auth } = createAdminApp(config);
        const tokenHash = await hashBootstrapToken("bootstrap-post-login-".padEnd(40, "x"), config.authSecret);
        storage.createBootstrapToken(tokenHash, new Date(Date.now() + 60_000));
        await createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash,
            email: "owner@example.com",
            name: "Owner",
            password: "correct horse battery staple",
        });

        const page = await app.request("/login");
        const pageBody = await page.text();
        const csrf = pageBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
        const csrfCookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        expect(csrf).toStartWith("ctcsrf_");
        expect(csrfCookie).toContain("ct_login_csrf=");

        const success = await app.request("/login", {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: csrfCookie,
            },
            body: new URLSearchParams({
                csrf,
                email: "owner@example.com",
                password: "correct horse battery staple",
            }),
        });
        expect(success.status).toBe(303);
        expect(success.headers.get("location")).toBe("/admin");
        expect(success.headers.get("set-cookie") ?? "").toContain("ct-admin.session_token=");

        const missingUser = await app.request("/login", {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: csrfCookie,
            },
            body: new URLSearchParams({
                csrf,
                email: "missing@example.com",
                password: "wrong-password-value",
            }),
        });
        expect(missingUser.status).toBe(401);
        const failedBody = await missingUser.text();
        expect(failedBody).toContain("Sign in failed. Check the email and password.");
        expect(failedBody).not.toContain("missing@example.com");
        expect(failedBody).not.toContain("wrong-password-value");
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("server-side login fallback rejects missing CSRF without checking credentials", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "http://localhost:9000" }));
        const { app, storage } = createAdminApp(config);
        const response = await app.request("/login", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                email: "owner@example.com",
                password: "wrong-password-value",
            }),
        });
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).toContain("Sign in expired. Reload the sign-in page and try again.");
        expect(body).not.toContain("owner@example.com");
        expect(body).not.toContain("wrong-password-value");
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("bootstrap setup URL is scrubbed into an httpOnly cookie", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, {
            BETTER_AUTH_URL: "https://panel.example.com",
            CT_ADMIN_SECURE_COOKIES: "true",
        }));
        const { app, storage } = createAdminApp(config);
        const token = "ctbt_secretTokenValue1234567890abcdefghi";
        const response = await app.request(`/setup/bootstrap?token=${token}`);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/setup/bootstrap");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        const cookie = response.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("ct_bootstrap_token=");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Secure");

        const page = await app.request("/setup/bootstrap", {
            headers: { cookie: `ct_bootstrap_token=${encodeURIComponent(token)}` },
        });
        const body = await page.text();
        expect(body).toContain("A one-time bootstrap token is loaded for this browser.");
        expect(body).not.toContain(token);
        storage.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ct admin bootstrap writes secret material to root-only file and returns redacted JSON", async () => {
    const { dir, dbPath } = tempDbPath();
    try {
        const config = loadAdminConfig(baseEnv(dbPath, { BETTER_AUTH_URL: "https://panel.example.com" }));
        const { AdminTask } = await import("../src/tasks/admin");
        const task = new AdminTask();
        const oldArgv = process.argv;
        let result;
        try {
            process.argv = ["bun", "ct-operator", "admin", "bootstrap"];
            result = await task.run({
                cwd: dir,
                env: baseEnv(dbPath, { BETTER_AUTH_URL: "https://panel.example.com" }),
                logger: { info() {}, warn() {}, error() {}, debug() {} },
                json: true,
                interactive: false,
            });
        } finally {
            process.argv = oldArgv;
        }
        expect(result.ok).toBe(true);
        const json = result.json as { setupPageUrl?: string; secretFile?: string; token?: string };
        expect(json.token).toBeUndefined();
        expect(json.setupPageUrl).toBe("https://<PANEL_DOMAIN>/setup/bootstrap");
        expect(json.setupPageUrl).not.toContain("ctbt_");
        expect(json.secretFile).toBe(bootstrapMaterialPath(config));
        expect(statSync(bootstrapMaterialPath(config)).mode & 0o777).toBe(0o600);
        const secretFile = await Bun.file(bootstrapMaterialPath(config)).text();
        expect(secretFile).toContain("setup_page=https://panel.example.com/setup/bootstrap");
        expect(secretFile).toContain("token=ctbt_");
        expect(secretFile).not.toContain("/setup/bootstrap?token=");
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
