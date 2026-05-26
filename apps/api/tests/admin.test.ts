// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadAdminConfig, bootstrapMaterialPath, type AdminConfig } from "@cool-tunnel/config";
import { AdminStore, migrateAdminDb, openAdminDb } from "@cool-tunnel/db";
import { hashBootstrapToken, redactSensitive } from "@cool-tunnel/security";
import { REQUIRED_SCHEMA_VERSION, type AdminUser } from "@cool-tunnel/shared";
import { createApiApp } from "../src/app";
import { createAuth } from "../src/auth";
import { isCoreAction } from "../src/core-boundary";

const SECRET = "test-better-auth-secret-".padEnd(43, "x");

function baseEnv(dbPath: string, extra: Record<string, string> = {}) {
  return {
    CT_ADMIN_ENV: "test",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "http://localhost:9000",
    CT_ADMIN_DB_PATH: dbPath,
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
    REALITY_PRIVATE_KEY: "A".repeat(43),
    REALITY_PUBLIC_KEY: "B".repeat(43),
    ...extra,
  };
}

function tempFixture(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-api-test-"));
  const dbPath = join(dir, "admin.sqlite");
  const config = loadAdminConfig(baseEnv(dbPath, extra));
  const { db } = openAdminDb(config.dbPath);
  migrateAdminDb(db);
  const store = new AdminStore(db, config);
  store.ensureDefaults(config);
  const auth = createAuth(config);
  const { app } = createApiApp({ config, store, auth });
  return { dir, config, db, store, auth, app };
}

async function ownerFixture() {
  const f = tempFixture();
  const { token } = await f.store.createBootstrapToken(f.config, 30);
  const passwordHash = await f.auth.$context.then((ctx) => ctx.password.hash("correct horse battery staple"));
  const tokenHash = await hashBootstrapToken(token, f.config.authSecret);
  const owner = f.store.createFirstOwner({
    email: "owner@example.com",
    username: "owner",
    name: "Owner",
    passwordHash,
    role: "owner",
  }, tokenHash);
  return { ...f, owner };
}

async function signIn(app: ReturnType<typeof createApiApp>["app"], email = "owner@example.com", password = "correct horse battery staple") {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(",").map((part) => part.trim()).find((part) => part.includes("ct-admin.session_token="))?.split(";")[0] ?? "";
  const me = cookie ? await app.request("/api/me", { headers: { cookie } }) : null;
  const csrf = me?.ok ? ((await me.json()) as { csrfToken: string }).csrfToken : "";
  return { res, cookie, csrf, setCookie };
}

function closeFixture(f: { dir: string; db: { close(): void } }) {
  try {
    f.db.close();
  } catch {
    // Already closed.
  }
  rmSync(f.dir, { recursive: true, force: true });
}

test("first owner setup consumes one-time bootstrap token and rejects reuse", async () => {
  const f = tempFixture();
  try {
    const { token } = await f.store.createBootstrapToken(f.config, 30);
    const page = await f.app.request(`/setup?token=${token}`);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/setup");
    expect(page.headers.get("set-cookie") ?? "").toContain("HttpOnly");
    expect(page.headers.get("set-cookie") ?? "").toContain("SameSite=Strict");
    expect(await page.text()).not.toContain(token);

    const create = await f.app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `ct_bootstrap_token=${encodeURIComponent(token)}` },
      body: new URLSearchParams({
        email: "owner@example.com",
        username: "owner",
        name: "Owner",
        password: "correct horse battery staple",
      }),
    });
    expect(create.status).toBe(303);
    expect(f.store.ownerCount()).toBe(1);

    const tokenHash = await hashBootstrapToken(token, f.config.authSecret);
    expect(f.store.consumeBootstrapTokenHash(tokenHash)).toEqual({ ok: false, reason: "used" });
  } finally {
    closeFixture(f);
  }
});

test("bootstrap token expiration blocks setup", async () => {
  const f = tempFixture();
  try {
    const { token } = await f.store.createBootstrapToken(f.config, -1);
    const create = await f.app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `ct_bootstrap_token=${encodeURIComponent(token)}` },
      body: new URLSearchParams({
        email: "owner@example.com",
        username: "owner",
        name: "Owner",
        password: "correct horse battery staple",
      }),
    });
    expect(create.status).toBe(403);
    expect(await create.text()).toContain("invalid or expired");
    expect(f.store.ownerCount()).toBe(0);
  } finally {
    closeFixture(f);
  }
});

test("setup scrubs arbitrary query strings and only stores token in an HttpOnly cookie", async () => {
  const f = tempFixture();
  try {
    const leaked = await f.app.request("/setup?email=owner@example.com&password=super-secret");
    expect(leaked.status).toBe(303);
    expect(leaked.headers.get("location")).toBe("/setup");
    expect(await leaked.text()).not.toContain("super-secret");
    expect(leaked.headers.get("set-cookie")).toBeNull();

    const { token } = await f.store.createBootstrapToken(f.config, 30);
    const tokenLoad = await f.app.request(`/setup?token=${token}`);
    expect(tokenLoad.status).toBe(303);
    expect(tokenLoad.headers.get("location")).toBe("/setup");
    expect(tokenLoad.headers.get("set-cookie") ?? "").toContain("HttpOnly");
    expect(tokenLoad.headers.get("set-cookie") ?? "").toContain("SameSite=Strict");
    expect(await tokenLoad.text()).not.toContain(token);
  } finally {
    closeFixture(f);
  }
});

test("login form scrubs query strings and posts credentials server-side", async () => {
  const f = await ownerFixture();
  try {
    const leaked = await f.app.request("/login?email=owner@example.com&password=super-secret");
    expect(leaked.status).toBe(303);
    expect(leaked.headers.get("location")).toBe("/login");
    expect(await leaked.text()).not.toContain("super-secret");

    const page = await f.app.request("/login");
    const body = await page.text();
    expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain('method="post"');
    expect(body).toContain('action="/login"');
    expect(body).not.toContain("localStorage");

    const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const csrfCookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const success = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
        origin: "http://localhost:9000",
        referer: "http://localhost:9000/login",
      },
      body: new URLSearchParams({ csrf, email: "owner@example.com", password: "correct horse battery staple" }),
    });
    expect(success.status).toBe(303);
    expect(success.headers.get("location")).toBe("/dashboard");
    expect(success.headers.get("set-cookie") ?? "").toContain("ct-admin.session_token=");

    const secondPage = await f.app.request("/login");
    const secondBody = await secondPage.text();
    const secondCsrf = secondBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const secondCsrfCookie = secondPage.headers.get("set-cookie")?.split(";")[0] ?? "";
    const nullOriginSuccess = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: secondCsrfCookie,
        origin: "null",
        referer: "",
      },
      body: new URLSearchParams({ csrf: secondCsrf, email: "owner@example.com", password: "correct horse battery staple" }),
    });
    expect(nullOriginSuccess.status).toBe(303);
    expect(nullOriginSuccess.headers.get("location")).toBe("/dashboard");

    const failed = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
        origin: "http://localhost:9000",
        referer: "http://localhost:9000/login",
      },
      body: new URLSearchParams({ csrf, email: "missing@example.com", password: "wrong-password-value" }),
    });
    expect(failed.status).toBe(401);
    const failedBody = await failed.text();
    expect(failedBody).toContain("Sign in failed. Check the email and password.");
    expect(failedBody).not.toContain("missing@example.com");
    expect(failedBody).not.toContain("wrong-password-value");

    for (let i = 0; i < 5; i++) {
      const pageAttempt = await f.app.request("/login");
      const attemptBody = await pageAttempt.text();
      const attemptCsrf = attemptBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const attemptCookie = pageAttempt.headers.get("set-cookie")?.split(";")[0] ?? "";
      const attempt = await f.app.request("/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: attemptCookie,
          "x-forwarded-for": "198.51.100.55",
          origin: "http://localhost:9000",
          referer: "http://localhost:9000/login",
        },
        body: new URLSearchParams({ csrf: attemptCsrf, email: "missing@example.com", password: "wrong-password-value" }),
      });
      expect(attempt.status).toBe(401);
    }
    const blockedPage = await f.app.request("/login");
    const blockedBody = await blockedPage.text();
    const blockedCsrf = blockedBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const blockedCookie = blockedPage.headers.get("set-cookie")?.split(";")[0] ?? "";
    const blocked = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: blockedCookie,
        "x-forwarded-for": "198.51.100.55",
        origin: "http://localhost:9000",
        referer: "http://localhost:9000/login",
      },
      body: new URLSearchParams({ csrf: blockedCsrf, email: "owner@example.com", password: "correct horse battery staple" }),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).not.toContain("correct horse");
  } finally {
    closeFixture(f);
  }
});

test("Better Auth cookies are httpOnly SameSite Lax and signup is disabled", async () => {
  const f = await ownerFixture();
  try {
    expect(f.auth.options.emailAndPassword?.disableSignUp).toBe(true);
    const signup = await f.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "correct horse battery staple", name: "New" }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(400);

    const signedIn = await signIn(f.app);
    expect(signedIn.res.status).toBe(200);
    expect(signedIn.setCookie).toContain("ct-admin.session_token=");
    expect(signedIn.setCookie.toLowerCase()).toContain("httponly");
    expect(signedIn.setCookie.toLowerCase()).toContain("samesite=lax");
    expect(signedIn.setCookie).not.toContain("localStorage");
  } finally {
    closeFixture(f);
  }
});

test("protected routes and role authorization enforce viewer/operator/admin/owner rules", async () => {
  const f = await ownerFixture();
  try {
    const denied = await f.app.request("/api/users");
    expect(denied.status).toBe(401);

    const ownerSession = await signIn(f.app);
    const createViewer = await f.app.request("/api/users", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({
        email: "viewer@example.com",
        username: "viewer",
        name: "Viewer",
        password: "correct horse battery staple",
        role: "viewer",
      }),
    });
    expect(createViewer.status).toBe(201);
    const viewer = ((await createViewer.json()) as { user: AdminUser }).user;
    const viewerSession = await signIn(f.app, "viewer@example.com");
    const forbidden = await f.app.request("/api/users", {
      method: "POST",
      headers: { cookie: viewerSession.cookie, "x-csrf-token": viewerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(forbidden.status).toBe(403);

    const demoteLastOwner = await f.app.request(`/api/users/${f.owner.id}`, {
      method: "PATCH",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(demoteLastOwner.status).toBe(400);

    const disabled = await f.app.request(`/api/users/${viewer.id}/disable`, {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
    });
    expect(disabled.status).toBe(200);
  } finally {
    closeFixture(f);
  }
});

test("proxy accounts, subscription URL masking, and manifest endpoint work", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const created = await f.app.request("/api/proxy-accounts", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", label: "Alice", clientDefaultLocalPort: 1088 }),
    });
    expect(created.status).toBe(201);
    const account = (await created.json()) as { account: { id: string; uuid: string; subscriptionUrl: string; subscriptionUrlMasked: string } };
    expect(account.account.uuid).toMatch(/[0-9a-f-]{36}/);
    expect(account.account.subscriptionUrlMasked).toContain("<redacted>");
    expect(account.account.subscriptionUrl).not.toContain("<redacted>");

    const manifest = await f.app.request(new URL(account.account.subscriptionUrl).pathname);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    const json = await manifest.json() as { version: number; profiles: Array<{ uuid: string; client_defaults: { local_port: number } }>; signature: string };
    expect(json.version).toBe(2);
    expect(json.profiles[0]?.uuid).toBe(account.account.uuid);
    expect(json.profiles[0]?.client_defaults.local_port).toBe(1088);
    expect(json.signature).toBeTruthy();

    const missing = await f.app.request("/api/v1/subscription/not-a-token");
    expect(missing.status).toBe(200);
    expect(missing.headers.get("content-type")).toContain("text/html");
  } finally {
    closeFixture(f);
  }
});

test("settings validation, status, audit, migrations, and action boundary", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const badSettings = await f.app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ domain: "bad domain" }),
    });
    expect(badSettings.status).toBe(400);

    const status = await f.app.request("/api/status", { headers: { cookie: ownerSession.cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: { migration: { ok: true, currentVersion: REQUIRED_SCHEMA_VERSION } } });

    const audit = await f.app.request("/api/audit", { headers: { cookie: ownerSession.cookie } });
    expect(audit.status).toBe(200);
    expect(JSON.stringify(await audit.json())).not.toContain("correct horse");

    const noCsrf = await f.app.request("/api/render", { method: "POST", headers: { cookie: ownerSession.cookie } });
    expect(noCsrf.status).toBe(403);
    const forgedCsrf = await f.app.request("/api/render", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": "0".repeat(32), "content-type": "application/json" },
      body: JSON.stringify({ target: "singbox" }),
    });
    expect(forgedCsrf.status).toBe(403);
    expect(isCoreAction("doctor")).toBe(true);
    expect(isCoreAction("rm -rf /")).toBe(false);
  } finally {
    closeFixture(f);
  }
});

test("bootstrap material path is root-only and redaction masks sensitive values", () => {
  const f = tempFixture({ BETTER_AUTH_URL: "https://panel.example.com", CT_ADMIN_SECURE_COOKIES: "true" });
  try {
    const materialPath = bootstrapMaterialPath(f.config);
    writeFileSync(materialPath, "token=ctbt_secretTokenValue1234567890\n", { mode: 0o600 });
    chmodSync(materialPath, 0o600);
    expect(statSync(materialPath).mode & 0o777).toBe(0o600);
    const redacted = redactSensitive("open /setup?token=ctbt_secretTokenValue1234567890 and https://panel.example.com/api/v1/subscription/abcdef");
    expect(redacted).not.toContain("ctbt_secret");
    expect(redacted).not.toContain("abcdef");
  } finally {
    closeFixture(f);
  }
});

test("production secure cookies require https", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-api-test-"));
  try {
    expect(() => {
      const config: AdminConfig = loadAdminConfig(baseEnv(join(dir, "admin.sqlite"), {
        CT_ADMIN_ENV: "production",
        BETTER_AUTH_URL: "http://panel.example.com",
      }));
      return config;
    }).toThrow("https://");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
